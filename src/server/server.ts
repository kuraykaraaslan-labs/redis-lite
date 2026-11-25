import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';

import { COMMANDS } from '../commands';
import type { CommandMeta } from '../commands/meta';
import { arityOk, lookupCommand } from '../commands/meta';
import type { CommandContext } from '../commands/types';
import { Block, NO_REPLY } from '../commands/types';
import { CommandError } from '../errors';
import { LuaEngine } from '../lua/engine';
import { RespMessages, unknownCommand, unknownSubcommand, wrongArity } from '../messages';
import type { Reply } from '../resp';
import { NULL_ARRAY, OK, QUEUED, RespError, RespParser, RespPush, Status } from '../resp';
import { hashHasFieldTtl } from '../commands/hashes';
import { Database } from '../store/database';
import { updateEncoding } from '../store/encoding';
import { matchGlob } from '../util';
import { Client } from './client';
import { ServerConfig } from './config';
import type { Waiter } from './client';

export interface ServerOptions {
  port: number;
  host: string;
  password?: string;
  databases: number;
  logLevel: 'silent' | 'warn' | 'info' | 'debug';
}

/** Write commands whose integer reply 0 means nothing was modified (Redis does not signal the key then). */
const ZERO_IS_NOOP = new Set([
  'del', 'unlink', 'expire', 'pexpire', 'expireat', 'pexpireat', 'persist', 'sadd', 'srem', 'hdel', 'hsetnx', 'setnx', 'msetnx',
  'renamenx', 'smove', 'lpushx', 'rpushx', 'lrem', 'zrem', 'zremrangebyscore', 'zremrangebyrank', 'zremrangebylex', 'copy', 'move',
  'linsert', 'pfadd', 'xdel', 'xtrim', 'xack', 'hsetex',
]);
/** Write commands whose null / empty reply means nothing was modified. */
const EMPTY_IS_NOOP = new Set([
  'set', 'lpop', 'rpop', 'spop', 'zpopmin', 'zpopmax', 'getdel', 'getex', 'lmove', 'rpoplpush', 'lmpop', 'zmpop', 'blpop', 'brpop',
  'blmove', 'brpoplpush', 'blmpop', 'bzpopmin', 'bzpopmax', 'bzmpop', 'xadd',
]);

/** Redis only signals a key as modified (WATCH, client tracking) when the command really wrote to it. */
function isNoop(name: string, args: string[], reply: unknown): boolean {
  if (reply instanceof RespError) return true;
  if (reply === 0 && ZERO_IS_NOOP.has(name)) return true;
  if (EMPTY_IS_NOOP.has(name) && (reply === null || reply === NULL_ARRAY || (Array.isArray(reply) && reply.length === 0))) return true;
  if (name === 'getex' && args.length === 1) return true;
  if (Array.isArray(reply) && reply.every((r) => r === -2 || r === 0 || r === -1) && /^h(p?expire(at)?|persist)$/.test(name)) return true;
  return false;
}

/** Commands a client in MULTI runs right away instead of queueing. */
const MULTI_IMMEDIATE = new Set(['exec', 'discard', 'multi', 'watch', 'quit', 'reset']);
/** Commands allowed in RESP2 subscriber mode. */
const SUBSCRIBER_ALLOWED = new Set(['subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe', 'ssubscribe', 'sunsubscribe', 'ping', 'quit', 'reset']);

/** Per-command statistics (INFO commandstats). */
export interface CommandStat {
  calls: number;
  usec: number;
  rejected: number;
  failed: number;
}

/** One SLOWLOG entry. */
export interface SlowlogEntry {
  id: number;
  time: number;
  usec: number;
  argv: string[];
  addr: string;
  name: string;
}

const SLOWLOG_ENTRY_MAX_ARGC = 32;
const SLOWLOG_ENTRY_MAX_STRING = 128;

/** Redis slowlogCreateEntry(): at most 32 arguments, each at most 128 bytes. */
function slowlogArgv(argv: string[]): string[] {
  const argc = Math.min(argv.length, SLOWLOG_ENTRY_MAX_ARGC);
  const out: string[] = [];
  for (let i = 0; i < argc; i++) {
    if (argc !== argv.length && i === argc - 1) {
      out.push(`... (${argv.length - argc + 1} more arguments)`);
    } else if (argv[i].length > SLOWLOG_ENTRY_MAX_STRING) {
      out.push(`${argv[i].slice(0, SLOWLOG_ENTRY_MAX_STRING)}... (${argv[i].length - SLOWLOG_ENTRY_MAX_STRING} more bytes)`);
    } else out.push(argv[i]);
  }
  return out;
}

const REPR_ESCAPES: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\x07': '\\a', '\b': '\\b' };

/** Redis sdscatrepr() body (MONITOR): C escapes for \\ " \n \r \t \a \b, \xHH for other non-printable bytes. */
function reprString(s: string): string {
  return s.replace(/[\\"\x00-\x1f\x7f-\xff]/g, (c) => REPR_ESCAPES[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Arguments Redis replaces with "(redacted)" in SLOWLOG and MONITOR (passwords). */
function redact(argv: string[]): string[] {
  const name = argv[0].toLowerCase();
  if (name === 'auth') return argv.map((a, i) => (i === 0 ? a : '(redacted)'));
  if (name === 'hello') {
    const out = [...argv];
    for (let i = 2; i < out.length; i++) {
      if (out[i].toLowerCase() === 'auth' && i + 2 < out.length) {
        out[i + 1] = '(redacted)';
        out[i + 2] = '(redacted)';
        i += 2;
      } else if (out[i].toLowerCase() === 'setname') i++;
    }
    return out;
  }
  return argv;
}

/** The redis-lite server: one in-memory keyspace, one command at a time (which is what makes every command atomic). */
export class RedisLiteServer {
  readonly runId = randomBytes(20).toString('hex');
  readonly startedAt = Date.now();
  readonly databases: Database[];
  readonly clients = new Set<Client>();
  readonly scripts = new Map<string, string>();
  readonly channels = new Map<string, Set<Client>>();
  readonly patterns = new Map<string, Set<Client>>();
  readonly shardChannels = new Map<string, Set<Client>>();
  readonly monitors = new Set<Client>();
  readonly stats = { commands: 0, connections: 0, expired: 0, errorReplies: 0, netIn: 0, netOut: 0 };
  /** INFO commandstats, by full command name (`client|id`). */
  readonly commandStats = new Map<string, CommandStat>();
  /** INFO errorstats, by error code (`ERR`, `WRONGTYPE`…). */
  readonly errorStats = new Map<string, number>();
  readonly slowlog: SlowlogEntry[] = [];
  private slowlogNextId = 0;
  /** Unix ms of the last SAVE / BGSAVE (LASTSAVE, INFO rdb_last_save_time). */
  lastSave = Date.now();
  /** Writes since the last save (INFO rdb_changes_since_last_save). */
  dirty = 0;
  lua!: LuaEngine;
  readonly config: ServerConfig;

  private readonly versions = new Map<string, number>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly readyKeys = new Set<string>();
  private nextClientId = 1;
  private net: Server | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private servingReady = false;
  private closing: Promise<void> | null = null;
  private readonly closeListeners: Array<() => void> = [];

  constructor(readonly options: ServerOptions) {
    this.config = new ServerConfig({ port: String(options.port), bind: options.host, databases: String(options.databases), requirepass: options.password ?? '' });
    this.databases = Array.from({ length: options.databases }, (_, i) => new Database((key) => this.onExpired(i, key), this.config));
  }

  async listen(): Promise<AddressInfo> {
    this.lua = await LuaEngine.create(this);
    const net = createServer((socket) => this.accept(socket));
    this.net = net;
    await new Promise<void>((resolve, reject) => {
      net.once('error', reject);
      net.listen(this.options.port, this.options.host, () => {
        net.off('error', reject);
        resolve();
      });
    });
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const db of this.databases) db.sweep(now, 200);
    }, 100);
    this.sweepTimer.unref();
    const address = net.address() as AddressInfo;
    this.config.set('port', String(address.port));
    return address;
  }

  /** Runs `listener` once the server has closed (also after SHUTDOWN). */
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  close(): Promise<void> {
    this.closing ??= this.doClose().then(() => {
      for (const listener of this.closeListeners) listener();
    });
    return this.closing;
  }

  private async doClose(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const list of this.waiters.values()) for (const w of list) if (w.timer) clearTimeout(w.timer);
    this.waiters.clear();
    for (const client of this.clients) {
      client.closed = true;
      client.socket?.destroy();
    }
    this.clients.clear();
    const net = this.net;
    this.net = null;
    if (net) await new Promise<void>((resolve) => net.close(() => resolve()));
  }

  log(level: 'warn' | 'info' | 'debug', message: string): void {
    const order = { silent: 0, warn: 1, info: 2, debug: 3 };
    if (order[level] <= order[this.options.logLevel]) process.stderr.write(`[redis-lite] ${message}\n`);
  }

  // ---- connections ---------------------------------------------------------------------------------------------

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    const client = new Client(this.nextClientId++, socket, Boolean(this.config.get('requirepass')));
    this.clients.add(client);
    this.stats.connections++;
    const parser = new RespParser({ maxBulkLen: () => this.config.num('proto-max-bulk-len') });
    socket.on('data', (chunk: Buffer) => {
      client.netIn += chunk.length;
      if (client.protocolError) return;
      const { commands, error } = parser.parse(chunk);
      client.pending.push(...commands);
      if (error !== null) client.protocolError = error;
      this.drain(client);
    });
    const cleanup = () => this.disconnect(client);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  /** Closes a connection at once (CLIENT KILL) and forgets its state. */
  killClient(client: Client): void {
    this.disconnect(client);
    client.socket?.destroy();
  }

  private disconnect(client: Client): void {
    if (client.closed) return;
    this.stats.netIn += client.netIn;
    this.stats.netOut += client.netOut;
    client.closed = true;
    this.clients.delete(client);
    if (client.blocked) this.unblock(client.blocked);
    for (const ch of client.channels) this.removeSubscriber(this.channels, ch, client);
    for (const p of client.patterns) this.removeSubscriber(this.patterns, p, client);
    for (const ch of client.shardChannels) this.removeSubscriber(this.shardChannels, ch, client);
    this.monitors.delete(client);
  }

  /** Runs the client's queued commands until it blocks. */
  private drain(client: Client): void {
    while (!client.closed && !client.blocked && client.pending.length) {
      const argv = client.pending.shift() as string[];
      this.runTopLevel(client, argv);
      if (client.closeAfterReply) {
        client.pending.length = 0;
        client.socket?.end();
        this.disconnect(client);
      }
    }
    if (client.protocolError && !client.closed && !client.blocked && !client.pending.length && !client.protocolErrorSent) {
      client.protocolErrorSent = true;
      client.write(new RespError(`ERR ${client.protocolError}`), true);
      client.socket?.end();
    }
  }

  /** An error reply produced outside a command (NOAUTH, queueing errors…): counted in INFO errorstats. */
  private replyError(client: Client, message: string): void {
    this.countError(message);
    client.write(new RespError(message));
  }

  /** INFO errorstats / total_error_replies. */
  countError(message: string): void {
    this.stats.errorReplies++;
    const space = message.indexOf(' ');
    const code = space < 0 ? message : message.slice(0, space);
    if (this.errorStats.has(code) || this.errorStats.size < 128) this.errorStats.set(code, (this.errorStats.get(code) ?? 0) + 1);
  }

  private commandStat(name: string): CommandStat {
    let stat = this.commandStats.get(name);
    if (!stat) this.commandStats.set(name, (stat = { calls: 0, usec: 0, rejected: 0, failed: 0 }));
    return stat;
  }

  /** CONFIG RESETSTAT. */
  resetStats(): void {
    this.stats.commands = 0;
    this.stats.connections = 0;
    this.stats.expired = 0;
    this.stats.errorReplies = 0;
    this.stats.netIn = 0;
    this.stats.netOut = 0;
    this.commandStats.clear();
    this.errorStats.clear();
  }

  slowlogReset(): void {
    this.slowlog.length = 0;
  }

  private slowlogPush(client: Client, argv: string[], usec: number): void {
    const threshold = this.config.num('slowlog-log-slower-than');
    const maxLen = this.config.num('slowlog-max-len');
    if (threshold < 0 || maxLen === 0 || usec < threshold) return;
    this.slowlog.unshift({
      id: this.slowlogNextId++,
      time: Math.floor(Date.now() / 1000),
      usec,
      argv: slowlogArgv(redact(argv)),
      addr: client.address,
      name: client.name,
    });
    if (this.slowlog.length > maxLen) this.slowlog.length = maxLen;
  }

  private runTopLevel(client: Client, argv: string[]): void {
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

    const spec = COMMANDS.get(name);
    if (!client.authenticated && !spec?.flags?.noauth) {
      this.replyError(client, RespMessages.NOAUTH);
      return;
    }
    if (client.resp === 2 && client.subscriptionCount > 0 && !SUBSCRIBER_ALLOWED.has(name)) {
      this.replyError(client, RespMessages.SUBSCRIBE_CONTEXT.replace('%s', name));
      return;
    }

    if (client.multi && !MULTI_IMMEDIATE.has(name)) {
      const checked = this.reject(argv);
      const problem = checked.error ?? (checked.meta?.flagSet.has('no_multi') ? 'ERR Command not allowed inside a transaction' : null);
      if (problem) {
        client.multiError = true;
        this.replyError(client, problem);
        return;
      }
      client.multi.push(argv);
      client.write(QUEUED);
      return;
    }

    const result = this.execute(client, argv, { inScript: false, noBlock: false });
    if (result instanceof Block) this.block(client, result);
    else if (result !== NO_REPLY) client.write(result);
    this.serveReadyKeys();
  }

  /** Redis processCommand() checks before running a command: unknown command / subcommand, arity. */
  private reject(argv: string[]): { error: string | null; meta?: CommandMeta; statName?: string } {
    const name = argv[0].toLowerCase();
    const args = argv.slice(1);
    const spec = COMMANDS.get(name);
    if (!spec) return { error: unknownCommand(argv[0], args) };
    const { meta, base } = lookupCommand(argv);
    if (base && base.subcommands.size && argv.length > 1 && !meta) {
      return { error: unknownSubcommand(argv[1].slice(0, 128), argv[0]), statName: name };
    }
    const isSub = Boolean(meta && meta !== base);
    const arity = isSub && meta ? meta.arity : spec.arity;
    const fullname = meta?.fullname ?? name;
    if (!arityOk(arity, argv.length)) return { error: wrongArity(fullname), meta, statName: fullname };
    return { error: null, meta, statName: fullname };
  }

  // ---- command execution ---------------------------------------------------------------------------------------

  /** Runs one command. Used by sockets, EXEC and Lua `redis.call`. */
  execute(client: Client, argv: string[], mode: { inScript: boolean; noBlock: boolean }): Reply | Block | typeof NO_REPLY {
    const name = argv[0].toLowerCase();
    const args = argv.slice(1);
    const spec = COMMANDS.get(name);
    const checked = this.reject(argv);
    if (!spec || checked.error !== null) {
      const message = checked.error ?? unknownCommand(argv[0], args);
      if (!spec) this.log('warn', `unknown command: ${name}`);
      if (checked.statName) this.commandStat(checked.statName).rejected++;
      if (!mode.inScript) this.countError(message);
      return new RespError(message);
    }
    const meta = checked.meta;
    const fullname = checked.statName ?? name;
    if (mode.inScript && spec.flags?.noscript) return new RespError(RespMessages.NOT_ALLOWED_FROM_SCRIPT);

    if (this.monitors.size && !meta?.flagSet.has('skip_monitor') && !meta?.flagSet.has('admin')) this.feedMonitors(client, argv, mode.inScript);
    this.stats.commands++;
    client.commandsProcessed++;
    if (!mode.inScript) client.lastCommand = fullname;
    const db = this.databases[client.dbIndex];
    const ctx: CommandContext = { server: this, client, db, inScript: mode.inScript, noBlock: mode.noBlock, noop: false };
    db.touchOnRead = !client.noTouch || name === 'touch';
    const started = process.hrtime.bigint();
    let result: Reply | Block | typeof NO_REPLY;
    try {
      result = spec.handler(ctx, args);
      if (spec.flags?.write && spec.keys && !ctx.noop && !isNoop(name, args, result)) {
        for (const key of spec.keys(args)) this.touch(client.dbIndex, key);
      }
    } catch (error) {
      if (error instanceof CommandError) result = new RespError(error.message);
      else {
        this.log('warn', `internal error in ${name}: ${(error as Error).stack ?? String(error)}`);
        result = new RespError(`ERR ${(error as Error).message}`);
      }
    }
    const usec = Number((process.hrtime.bigint() - started) / 1000n);
    const stat = this.commandStat(fullname);
    stat.calls++;
    stat.usec += usec;
    if (result instanceof RespError) {
      stat.failed++;
      if (!mode.inScript) this.countError(result.message);
    }
    if (!mode.inScript && !meta?.flagSet.has('skip_slowlog')) this.slowlogPush(client, argv, usec);
    return result;
  }

  /** Marks a key modified: invalidates WATCH and wakes clients blocked on it. */
  touch(dbIndex: number, key: string): void {
    this.dirty++;
    const value = this.databases[dbIndex]?.peek(key);
    if (value) updateEncoding(value, this.config, value.type === 'hash' && hashHasFieldTtl(value.value));
    const k = `${dbIndex}:${key}`;
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
    if (this.waiters.has(k)) this.readyKeys.add(k);
  }

  keyVersion(dbIndex: number, key: string): number {
    return this.versions.get(`${dbIndex}:${key}`) ?? 0;
  }

  private onExpired(dbIndex: number, key: string): void {
    this.stats.expired++;
    const k = `${dbIndex}:${key}`;
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
  }

  // ---- transactions --------------------------------------------------------------------------------------------

  runExec(client: Client): Reply {
    const queued = client.multi;
    if (!queued) return new RespError(RespMessages.EXEC_WITHOUT_MULTI);
    const aborted = client.multiError;
    const dirty = this.isWatchDirty(client);
    client.multi = null;
    client.multiError = false;
    client.watched.clear();
    if (aborted) return new RespError(RespMessages.EXECABORT);
    if (dirty) return NULL_ARRAY;
    const replies: Reply[] = [];
    for (const argv of queued) {
      const r = this.execute(client, argv, { inScript: false, noBlock: true });
      replies.push(r instanceof Block || r === NO_REPLY ? NULL_ARRAY : r);
    }
    return replies;
  }

  /**
   * FLUSHDB / FLUSHALL / SWAPDB (Redis touchAllWatchedKeysInDb): invalidates the WATCHes on keys of `dbIndex` that exist there (or,
   * for SWAPDB, in `other`). Call it before the database changes. Watched keys that did not exist are left alone (Redis 7.0+).
   */
  signalFlushedDb(dbIndex: number, other?: number): void {
    const prefix = `${dbIndex}:`;
    const bumped = new Set<string>();
    for (const c of this.clients) {
      for (const k of c.watched.keys()) {
        if (!k.startsWith(prefix) || bumped.has(k)) continue;
        const key = k.slice(prefix.length);
        const exists = this.databases[dbIndex].peek(key) !== undefined || (other !== undefined && this.databases[other].peek(key) !== undefined);
        if (!exists) continue;
        bumped.add(k);
        this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
      }
    }
  }

  private isWatchDirty(client: Client): boolean {
    for (const [k, v] of client.watched) if ((this.versions.get(k) ?? 0) !== v) return true;
    return false;
  }

  // ---- blocking ------------------------------------------------------------------------------------------------

  private block(client: Client, block: Block): void {
    const waiter: Waiter = {
      client,
      dbKeys: block.keys.map((k) => `${client.dbIndex}:${k}`),
      retry: block.retry,
      timeoutReply: block.timeoutReply,
      timer: null,
      done: false,
    };
    for (const k of waiter.dbKeys) {
      const list = this.waiters.get(k);
      if (list) list.push(waiter);
      else this.waiters.set(k, [waiter]);
    }
    if (block.timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        if (waiter.done) return;
        this.unblock(waiter);
        client.write(block.timeoutReply);
        this.drain(client);
        this.serveReadyKeys();
      }, block.timeoutMs);
    }
    client.blocked = waiter;
  }

  /** CLIENT UNBLOCK: answers the blocked client with its timeout reply, or an UNBLOCKED error. */
  unblockClient(client: Client, withError: boolean): boolean {
    const waiter = client.blocked;
    if (!waiter) return false;
    this.unblock(waiter);
    client.write(withError ? new RespError('UNBLOCKED client unblocked via CLIENT UNBLOCK') : waiter.timeoutReply);
    setImmediate(() => this.drain(client));
    return true;
  }

  private unblock(waiter: Waiter): void {
    waiter.done = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    for (const k of waiter.dbKeys) {
      const list = this.waiters.get(k);
      if (!list) continue;
      const i = list.indexOf(waiter);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.waiters.delete(k);
    }
    if (waiter.client.blocked === waiter) waiter.client.blocked = null;
  }

  /** Serves clients blocked on keys that changed, FIFO per key, until nothing more can be served. */
  serveReadyKeys(): void {
    if (this.servingReady) return;
    this.servingReady = true;
    const released: Client[] = [];
    try {
      while (this.readyKeys.size) {
        const keys = [...this.readyKeys];
        this.readyKeys.clear();
        for (const k of keys) {
          const list = this.waiters.get(k);
          if (!list) continue;
          for (const waiter of [...list]) {
            if (waiter.done) continue;
            const reply = waiter.retry();
            if (reply === undefined) continue;
            this.unblock(waiter);
            waiter.client.write(reply);
            released.push(waiter.client);
          }
        }
      }
    } finally {
      this.servingReady = false;
    }
    for (const client of released) this.drain(client);
    if (this.readyKeys.size) this.serveReadyKeys();
  }

  // ---- pub/sub -------------------------------------------------------------------------------------------------

  subscribe(client: Client, channel: string, pattern: boolean): void {
    const map = pattern ? this.patterns : this.channels;
    let set = map.get(channel);
    if (!set) map.set(channel, (set = new Set()));
    set.add(client);
    (pattern ? client.patterns : client.channels).add(channel);
  }

  unsubscribe(client: Client, channel: string, pattern: boolean): void {
    this.removeSubscriber(pattern ? this.patterns : this.channels, channel, client);
    (pattern ? client.patterns : client.channels).delete(channel);
  }

  private removeSubscriber(map: Map<string, Set<Client>>, channel: string, client: Client): void {
    const set = map.get(channel);
    if (!set) return;
    set.delete(client);
    if (!set.size) map.delete(channel);
  }

  ssubscribe(client: Client, channel: string): void {
    let set = this.shardChannels.get(channel);
    if (!set) this.shardChannels.set(channel, (set = new Set()));
    set.add(client);
    client.shardChannels.add(channel);
  }

  sunsubscribe(client: Client, channel: string): void {
    this.removeSubscriber(this.shardChannels, channel, client);
    client.shardChannels.delete(channel);
  }

  spublish(channel: string, message: string): number {
    let receivers = 0;
    for (const client of this.shardChannels.get(channel) ?? []) {
      client.write(new RespPush(['smessage', channel, message]));
      receivers++;
    }
    return receivers;
  }

  private feedMonitors(client: Client, argv: string[], inScript: boolean): void {
    const now = Date.now();
    const ts = `${Math.floor(now / 1000)}.${String((now % 1000) * 1000).padStart(6, '0')}`;
    const origin = inScript ? 'lua' : client.address;
    const args = redact(argv).map((a) => `"${reprString(a)}"`);
    const line = new Status(`${ts} [${client.dbIndex} ${origin}] ${args.join(' ')}`);
    for (const m of this.monitors) if (m !== client) m.write(line);
  }

  /** SWAPDB: exchanges the contents of two databases, invalidates WATCHes and serves clients blocked on keys that now exist. */
  swapDatabases(a: number, b: number): void {
    this.signalFlushedDb(a, b);
    if (a !== b) this.signalFlushedDb(b, a);
    this.databases[a].swapWith(this.databases[b]);
    for (const k of this.waiters.keys()) {
      const sep = k.indexOf(':');
      const db = Number(k.slice(0, sep));
      if ((db === a || db === b) && this.databases[db].peek(k.slice(sep + 1)) !== undefined) this.readyKeys.add(k);
    }
  }

  publish(channel: string, message: string): number {
    let receivers = 0;
    for (const client of this.channels.get(channel) ?? []) {
      client.write(new RespPush(['message', channel, message]));
      receivers++;
    }
    for (const [pattern, set] of this.patterns) {
      if (!matchGlob(pattern, channel)) continue;
      for (const client of set) {
        client.write(new RespPush(['pmessage', pattern, channel, message]));
        receivers++;
      }
    }
    return receivers;
  }

  /** A client that is not attached to a socket (embedded use, tests). */
  createInternalClient(): Client {
    return new Client(this.nextClientId++, null, false);
  }

  status(text: string): Status {
    return new Status(text);
  }
}
