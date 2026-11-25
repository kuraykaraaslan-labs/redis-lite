import { AppError } from '@/libs/app-error';
import Logger from '@/libs/logger';
import { formatMessage } from '@/libs/message-format';
import { NULL_ARRAY, OK, QUEUED, RespError } from '@/libs/resp';
import type { Reply } from '@/libs/resp';
import { unknownCommand, unknownSubcommand, wrongArity } from '@/libs/resp/messages';

import { aclDenialMessage, noPermError } from '@/modules/acl/acl.core';
import { Block, NO_REPLY } from '@/modules/command/command.handler';
import { COMMANDS } from '@/modules/command/command.registry';
import CommandService from '@/modules/command/command.service';
import type { CommandContext, HandlerResult } from '@/modules/command/command.types';
import { OOM_ERROR } from '@/modules/memory/memory.eviction';
import { setWrote } from '@/modules/notifications/notifications.core';

import type { Client } from './server.client';
import type { RedisLiteServer } from './server.core';
import ServerMessages from './server.messages';
import type { ExecuteMode, Precheck } from './server.types';

// ============================================================================
// No-op Detection
// ============================================================================

/** Write commands whose integer reply 0 means nothing was modified (Redis does not signal the key then). */
const ZERO_IS_NOOP = new Set([
  'del', 'unlink', 'expire', 'pexpire', 'expireat', 'pexpireat', 'persist', 'sadd', 'srem', 'hdel', 'hsetnx', 'setnx', 'msetnx',
  'renamenx', 'smove', 'lpushx', 'rpushx', 'lrem', 'zrem', 'zremrangebyscore', 'zremrangebyrank', 'zremrangebylex', 'copy', 'move',
  'linsert', 'pfadd', 'xdel', 'xtrim', 'xack', 'hsetex',
]);

/** Write commands whose null / empty reply means nothing was modified. */
const EMPTY_IS_NOOP = new Set([
  'lpop', 'rpop', 'spop', 'zpopmin', 'zpopmax', 'getdel', 'getex', 'lmove', 'rpoplpush', 'lmpop', 'zmpop', 'blpop', 'brpop',
  'blmove', 'brpoplpush', 'blmpop', 'bzpopmin', 'bzpopmax', 'bzmpop', 'xadd',
]);

/** Commands a client in MULTI runs right away instead of queueing. */
const MULTI_IMMEDIATE = new Set(['exec', 'discard', 'multi', 'watch', 'quit', 'reset']);

/** Commands allowed in RESP2 subscriber mode. */
const SUBSCRIBER_ALLOWED = new Set(['subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe', 'ssubscribe', 'sunsubscribe', 'ping', 'quit', 'reset']);

/**
 * Redis only signals a key as modified (WATCH, client tracking) when the command really wrote to it. `existed`: whether
 * the command's first key existed before it ran (SET … GET replies the old value, so only that tells whether it wrote).
 */
function isNoop(name: string, args: string[], reply: Reply, existed: boolean): boolean {
  if (reply instanceof RespError) return true;
  if (name === 'set') return !setWrote(['set', ...args], reply, existed);
  if (reply === 0 && ZERO_IS_NOOP.has(name)) return true;
  if (EMPTY_IS_NOOP.has(name) && (reply === null || reply === NULL_ARRAY || (Array.isArray(reply) && reply.length === 0))) return true;
  if (name === 'getex' && args.length === 1) return true;
  if (Array.isArray(reply) && reply.every((r) => r === -2 || r === 0 || r === -1) && /^h(p?expire(at)?|persist)$/.test(name)) return true;
  return false;
}

/** Keys of a command from its key extractor; a malformed command (rejected by the handler) has none. */
export function specKeys(extract: ((args: string[]) => string[]) | undefined, args: string[]): string[] {
  if (!extract) return [];
  try {
    return extract(args).filter((k): k is string => typeof k === 'string');
  } catch {
    return [];
  }
}

// ============================================================================
// Dispatcher
// ============================================================================

/**
 * Redis processCommand() and call(): the checks a command passes before it runs (existence, arity, auth, MULTI, ACL,
 * OOM, MISCONF, subscriber context), queueing inside MULTI, then the run itself with its side effects (WATCH versions,
 * propagation, keyspace events, tracking, stats, slowlog). An AppError thrown by a handler becomes its error reply.
 */
export class ServerDispatcher {
  /** The eviction pass before the current top-level command could not get under maxmemory (scripts check it too). */
  private preCommandOom = false;

  constructor(private readonly server: RedisLiteServer) {}

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Whether a command queued in the client's transaction has a Redis command flag (EXEC inherits write / denyoom). */
  private queuedHasFlag(client: Client, flag: string): boolean {
    return (client.multi ?? []).some((argv) => CommandService.lookupCommand(argv).meta?.flagSet.has(flag));
  }

  /**
   * Redis rejectCommand(): flags a pending transaction, counts the rejection and replies the error. A rejected EXEC
   * aborts the transaction instead (execCommandAbort).
   */
  private rejectCommand(client: Client, message: string, statName?: string, isExec = false): void {
    if (client.multi) client.multiError = true;
    if (statName) this.server.observer.commandStat(statName).rejected++;
    if (isExec) {
      client.multi = null;
      client.multiError = false;
      client.watched.clear();
      const reason = message.startsWith('NOAUTH') ? `${message}  ` : message;
      this.server.observer.replyError(client, formatMessage(ServerMessages.EXECABORT_BECAUSE, { reason }));
      return;
    }
    this.server.observer.replyError(client, message);
  }

  /** The checks before queueing / running that only top-level commands get; true when the command was rejected. */
  private refused(client: Client, argv: string[], name: string, checked: Precheck, noauth: boolean): boolean {
    const server = this.server;
    const meta = checked.meta;
    const fullname = checked.statName ?? name;
    const isExec = name === 'exec';
    if (server.authRequired(client) && !noauth) {
      this.rejectCommand(client, ServerMessages.NOAUTH, fullname, isExec);
      return true;
    }
    if (client.multi && meta?.flagSet.has('no_multi')) {
      this.rejectCommand(client, ServerMessages.NO_MULTI, fullname);
      return true;
    }
    const denial = server.aclDenial(client, argv, meta);
    if (denial && client.user) {
      client.lastCommand = fullname;
      server.aclLogDenial(client, denial, server.aclContext(client));
      this.rejectCommand(client, noPermError(denial, client.user.name), fullname, isExec);
      return true;
    }
    const queueing = Boolean(client.multi) && !MULTI_IMMEDIATE.has(name);
    // performEvictions(): before every command while maxmemory is set; denyoom commands are refused when it fails
    if (server.config.num('maxmemory') > 0) {
      this.preCommandOom = server.evictor.perform() === 'fail';
      // queueing in MULTI could grow memory without bound, so any queued command is refused too
      const denyoom = queueing || meta?.flagSet.has('denyoom') || (isExec && this.queuedHasFlag(client, 'denyoom'));
      if (this.preCommandOom && denyoom) {
        this.rejectCommand(client, OOM_ERROR, fullname, isExec);
        return true;
      }
    } else this.preCommandOom = false;
    // MISCONF: a failed BGSAVE / AOF write stops writes (and PING)
    const diskError = server.persistence.writeDeniedError();
    if (diskError !== null) {
      const write = meta?.flagSet.has('write') || name === 'ping' || (isExec && this.queuedHasFlag(client, 'write'));
      if (write) {
        this.rejectCommand(client, diskError, fullname, isExec);
        return true;
      }
    }
    if (client.resp === 2 && client.subscriptionCount > 0 && !SUBSCRIBER_ALLOWED.has(name)) {
      this.rejectCommand(client, formatMessage(ServerMessages.SUBSCRIBE_CONTEXT, { command: name }), fullname);
      return true;
    }
    return false;
  }

  /** The checks `redis.call` gets on top of the top-level ones: noscript, ACL, MISCONF, OOM. Null when allowed. */
  private scriptRefusal(client: Client, argv: string[], checked: Precheck, write: boolean, noscript: boolean): RespError | null {
    const server = this.server;
    const meta = checked.meta;
    if (noscript) return new RespError(ServerMessages.NOT_ALLOWED_FROM_SCRIPT);
    if (client.user) {
      // scriptVerifyACL()
      const denial = server.aclDenial(client, argv, meta);
      if (denial) {
        server.aclLogDenial(client, denial, 'lua');
        return new RespError(formatMessage(ServerMessages.ACL_SCRIPT_FAILURE, { reason: aclDenialMessage(denial, client.user.name) }));
      }
    }
    // the checks processCommand() makes for top-level commands, for redis.call
    if (write || meta?.flagSet.has('write')) {
      const diskError = server.persistence.writeDeniedError();
      if (diskError !== null) return new RespError(diskError);
    }
    if (this.preCommandOom && meta?.flagSet.has('denyoom')) return new RespError(OOM_ERROR);
    return null;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Redis processCommand() checks before running a command: unknown command / subcommand, arity. */
  precheck(argv: string[]): Precheck {
    const name = argv[0].toLowerCase();
    const args = argv.slice(1);
    const spec = COMMANDS.get(name);
    if (!spec) return { error: unknownCommand(argv[0], args) };
    const { meta, base } = CommandService.lookupCommand(argv);
    if (base && base.subcommands.size && argv.length > 1 && !meta) {
      return { error: unknownSubcommand(argv[1].slice(0, 128), argv[0]), statName: name };
    }
    const isSub = Boolean(meta && meta !== base);
    const arity = isSub && meta ? meta.arity : spec.arity;
    const fullname = meta?.fullname ?? name;
    if (!CommandService.arityOk(arity, argv.length)) return { error: wrongArity(fullname), meta, statName: fullname };
    return { error: null, meta, statName: fullname };
  }

  /** Redis processCommand(): existence/arity, auth, no_multi, ACL, subscriber context, then queue (MULTI) or run. */
  runTopLevel(client: Client, argv: string[]): void {
    const server = this.server;
    const name = argv[0].toLowerCase();
    client.lastActiveAt = Date.now();
    // CLIENT REPLY SKIP suppresses the reply of the command after it
    client.skipCurrent = client.skipNext;
    client.skipNext = false;

    if (name === 'quit') {
      client.lastCommand = 'quit';
      client.write(OK);
      client.socket?.end();
      return;
    }

    const checked = this.precheck(argv);
    const spec = COMMANDS.get(name);
    if (!spec || checked.error !== null) {
      if (!spec) Logger.warn('[ServerDispatcher.runTopLevel] Unknown command', { command: name });
      this.rejectCommand(client, checked.error ?? unknownCommand(argv[0], argv.slice(1)), checked.statName);
      return;
    }
    if (this.refused(client, argv, name, checked, Boolean(spec.flags?.noauth))) return;

    if (client.multi && !MULTI_IMMEDIATE.has(name)) {
      client.multi.push(argv);
      client.write(QUEUED);
      return;
    }

    server.tracking.current = client;
    let result: HandlerResult;
    try {
      result = this.execute(client, argv, { inScript: false, noBlock: false }, checked);
    } finally {
      server.tracking.current = null;
    }
    if (result instanceof Block) server.blocking.block(client, result, argv);
    else if (result !== NO_REPLY) client.write(result);
    server.tracking.flushDeferred(client);
    // CLIENT CACHING applies to the next command only (a whole transaction counts as one)
    if (!client.multi && !(name === 'client' && argv[1]?.toLowerCase() === 'caching')) client.trackingCaching = null;
    server.tracking.enforceLimit();
    server.serveReadyKeys();
  }

  /** Runs one command. Used by sockets, EXEC and Lua `redis.call`. */
  execute(client: Client, argv: string[], mode: ExecuteMode, prechecked?: Precheck): HandlerResult {
    const server = this.server;
    const name = argv[0].toLowerCase();
    const args = argv.slice(1);
    const spec = COMMANDS.get(name);
    const checked = prechecked ?? this.precheck(argv);
    if (!spec || checked.error !== null) {
      const message = checked.error ?? unknownCommand(argv[0], args);
      if (!spec) Logger.warn('[ServerDispatcher.execute] Unknown command', { command: name });
      if (checked.statName) server.observer.commandStat(checked.statName).rejected++;
      if (!mode.inScript) server.countError(message);
      return new RespError(message);
    }
    const meta = checked.meta;
    const fullname = checked.statName ?? name;
    if (mode.inScript) {
      const refusal = this.scriptRefusal(client, argv, checked, Boolean(spec.flags?.write), Boolean(spec.flags?.noscript));
      if (refusal) return refusal;
    }

    if (server.monitors.size && !meta?.flagSet.has('skip_monitor') && !meta?.flagSet.has('admin')) {
      server.observer.feedMonitors(client, argv, mode.inScript);
    }
    server.stats.commands++;
    client.commandsProcessed++;
    if (!mode.inScript) client.lastCommand = fullname;
    const dbIndex = client.dbIndex;
    const db = server.databases[dbIndex];
    const ctx: CommandContext = { server, client, db, inScript: mode.inScript, noBlock: mode.noBlock, noop: false, name: argv[0] };
    db.touchOnRead = !client.noTouch || name === 'touch';
    const notify = server.keyspace.notifyFlags();
    // read commands only need their keys for keyspace notifications (keymiss)
    let keys: string[] = [];
    if (spec.keys) keys = specKeys(spec.keys, args);
    else if (notify && meta) keys = CommandService.keyNames(meta, argv);
    const propagator = server.persistence.propagator;
    propagator.enter(name);
    let result: HandlerResult;
    const started = process.hrtime.bigint();
    try {
      // the state of the command's keys before it runs: `new` / `keymiss` events, and SET … GET's no-op test
      const before = notify || name === 'set' ? server.keyspace.keyStates(db, keys) : null;
      const dirtyBefore = server.persistence.dirty;
      let noop = false;
      try {
        result = spec.handler(ctx, args);
        if (!(result instanceof Block) && result !== NO_REPLY) {
          noop = ctx.noop || isNoop(name, args, result, before?.get(keys[0])?.exists ?? false);
          if (spec.flags?.write && !noop) for (const key of keys) server.touch(dbIndex, key);
        }
      } catch (error) {
        if (error instanceof AppError) result = new RespError(error.message);
        else {
          Logger.error('[ServerDispatcher.execute] Internal error', { command: name, err: (error as Error).stack ?? String(error) });
          result = new RespError(formatMessage(ServerMessages.GENERIC_ERROR, { message: (error as Error).message }));
        }
      }
      if (!(result instanceof Block) && result !== NO_REPLY) {
        propagator.record(dbIndex, argv, result, server.persistence.dirty - dirtyBefore);
        if (notify && before) {
          server.keyspace.notifyCommand(dbIndex, name, args, result, before, { write: Boolean(spec.flags?.write), noop, meta });
        }
      }
      if (client.tracking && meta?.flagSet.has('readonly')) server.tracking.remember(client, CommandService.keyNames(meta, argv));
    } finally {
      propagator.exit();
    }
    const usec = Number((process.hrtime.bigint() - started) / 1000n);
    const stat = server.observer.commandStat(fullname);
    stat.calls++;
    stat.usec += usec;
    if (result instanceof RespError) {
      stat.failed++;
      if (!mode.inScript) server.countError(result.message);
    }
    if (!mode.inScript && !meta?.flagSet.has('skip_slowlog')) server.observer.slowlogPush(client, argv, usec);
    return result;
  }
}
