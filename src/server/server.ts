import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';

import { COMMANDS } from '../commands';
import { clientInfoLine } from '../commands/connection';
import type { CommandMeta } from '../commands/meta';
import { allCommandsDeep, arityOk, getCommandMeta, keysFromSpecs, lookupCommand } from '../commands/meta';
import type { CommandContext } from '../commands/types';
import { Block, NO_REPLY } from '../commands/types';
import { CommandError } from '../errors';
import { LuaEngine } from '../lua/engine';
import { RespMessages, unknownCommand, unknownSubcommand, wrongArity } from '../messages';
import type { Reply } from '../resp';
import { NULL_ARRAY, OK, QUEUED, RespError, RespParser, RespPush, Status } from '../resp';
import { hashFieldExpires, hashHasFieldTtl } from '../commands/hashes';
import { Database } from '../store/database';
import { objectEncoding, updateEncoding } from '../store/encoding';
import { clientMemory, computeMemory } from '../store/memory';
import type { KeyRecord, MemoryReport } from '../store/memory';
import { matchGlob } from '../util';
import { Acl, aclDenialMessage, noPermError } from './acl';
import type { AclDenial, AclLogContext, AclLogInput, AclUser, KeyAccess } from './acl';
import { Client } from './client';
import { ServerConfig } from './config';
import type { Waiter } from './client';

export interface ServerOptions {
  port: number;
  host: string;
  password?: string;
  databases: number;
  logLevel: 'silent' | 'warn' | 'info' | 'debug';
  /** ACL file (the immutable `aclfile` config): loaded at startup, used by ACL LOAD / ACL SAVE. */
  aclfile?: string;
}

/** Hooks other modules plug into DEBUG (the persistence engine provides RELOAD / LOADAOF). */
export interface DebugHooks {
  /** DEBUG RELOAD [MERGE] [NOFLUSH] [NOSAVE]; args are the options after RELOAD. */
  reload?: (client: Client, args: string[]) => Reply;
  /** DEBUG LOADAOF. */
  loadaof?: (client: Client) => Reply;
}

/** Redis execCommand(): why a queued command became forbidden between MULTI and EXEC. */
const EXEC_ACL_REASONS: Record<AclDenial['reason'], string> = {
  command: 'no permission to execute the command or subcommand',
  key: 'no permission to touch the specified keys',
  channel: 'no permission to access one of the channels used as arguments',
};

/** Redis keyspec flags → ACL key permission (ACLSelectorCheckKey: access = read; insert / delete / update = write). */
function keyAccess(key: string, flags: readonly string[]): KeyAccess {
  return {
    key,
    read: flags.includes('access'),
    write: flags.includes('insert') || flags.includes('delete') || flags.includes('update'),
  };
}

/** Keys of a command with their ACL flags; SET and BITFIELD have variable flags resolved like setGetKeys / bitfieldGetKeys. */
export function aclKeysOf(meta: CommandMeta, argv: string[]): KeyAccess[] {
  const name = meta.fullname;
  if (name === 'set' && argv.length >= 2) {
    const get = argv.slice(3).some((a) => a.toLowerCase() === 'get');
    return [keyAccess(argv[1], get ? ['RW', 'access', 'update'] : ['OW', 'update'])];
  }
  if (name === 'bitfield' && argv.length >= 2) {
    let readonly = true;
    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i].toLowerCase();
      const rem = argv.length - i - 1;
      if (arg === 'get' && rem >= 2) i += 2;
      else if (arg === 'overflow' && rem >= 1) i += 1;
      else {
        readonly = false;
        break;
      }
    }
    return [keyAccess(argv[1], readonly ? ['RO', 'access'] : ['RW', 'access', 'update'])];
  }
  const refs = keysFromSpecs(meta, argv) ?? [];
  return refs.map((r) => keyAccess(argv[r.index], r.flags));
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

/** strerror() text of a failed file operation. */
function strerror(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  const texts: Record<string, string> = {
    ENOENT: 'No such file or directory',
    EACCES: 'Permission denied',
    EISDIR: 'Is a directory',
    ENOTDIR: 'Not a directory',
    EROFS: 'Read-only file system',
    ENOSPC: 'No space left on device',
  };
  return (code && texts[code]) ?? (e as Error).message;
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
  if (name === 'acl' && argv[1]?.toLowerCase() === 'setuser') return argv.map((a, i) => (i < 2 ? a : '(redacted)'));
  if (name === 'config' && argv[1]?.toLowerCase() === 'set') {
    // sensitive configs (requirepass, masterauth) have their value redacted
    return argv.map((a, i) => (i > 2 && i % 2 === 1 && /^(requirepass|masterauth)$/i.test(argv[i - 1]) ? '(redacted)' : a));
  }
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
  /** Users, permissions and ACL LOG. */
  readonly acl: Acl;
  /** INFO stats acl_access_denied_*. */
  readonly aclStats = { auth: 0, command: 0, key: 0, channel: 0 };
  /** master_replid (DEBUG CHANGE-REPL-ID replaces it). */
  replId = randomBytes(20).toString('hex');
  /** DEBUG SET-ACTIVE-EXPIRE: the background expire cycle runs only while true. */
  activeExpire = true;
  /** used_memory_peak and the unix time (s) it was reached. */
  memoryPeak = 0;
  memoryPeakTime = 0;
  /** Extension points for DEBUG subcommands implemented elsewhere. */
  readonly debugHooks: DebugHooks = {};

  private readonly versions = new Map<string, number>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly readyKeys = new Set<string>();
  private nextClientId = 1;
  private net: Server | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private servingReady = false;
  private closing: Promise<void> | null = null;
  private readonly closeListeners: Array<() => void> = [];
  /** Bumped by every change that can alter memory accounting (cache key of memoryReport()). */
  private memoryEpoch = 0;
  private memoryCache: { key: string; report: MemoryReport } | null = null;
  /** Standalone Redis allocates a db's dicts on first use and keeps them (MEMORY STATS db.N). */
  private readonly dbAllocated: boolean[];

  constructor(readonly options: ServerOptions) {
    this.config = new ServerConfig({
      port: String(options.port),
      bind: options.host,
      databases: String(options.databases),
      requirepass: options.password ?? '',
      aclfile: options.aclfile ?? '',
    });
    this.databases = Array.from({ length: options.databases }, (_, i) => new Database((key) => this.onExpired(i, key), this.config));
    this.dbAllocated = this.databases.map(() => false);
    this.acl = new Acl({
      allCommands: () => allCommandsDeep().map((m) => m.fullname),
      categoriesOf: (name) => (getCommandMeta(name)?.acl ?? []).map((c) => `@${c}`),
      requirepass: options.password ?? '',
      pubsubDefault: this.config.get('acl-pubsub-default') === 'allchannels' ? 'allchannels' : 'resetchannels',
      logMaxLen: this.config.num('acllog-max-len'),
    });
  }

  /** The `default` ACL user (it can never be deleted). */
  get defaultUser(): AclUser {
    const u = this.acl.user('default');
    if (!u) throw new Error('ACL default user missing');
    return u;
  }

  async listen(): Promise<AddressInfo> {
    const aclfile = this.config.get('aclfile') ?? '';
    if (aclfile) this.loadAclFile(aclfile);
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
      if (!this.activeExpire) return;
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
    // clientSetDefaultAuth(): logged in as default when default is `on nopass`
    const client = new Client(this.nextClientId++, socket, !this.acl.defaultLoginAllowed(), this.defaultUser);
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

  /** Redis processCommand(): existence/arity, auth, no_multi, ACL, subscriber context, then queue (MULTI) or run. */
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

    const checked = this.reject(argv);
    const spec = COMMANDS.get(name);
    if (!spec || checked.error !== null) {
      if (!spec) this.log('warn', `unknown command: ${name}`);
      this.rejectCommand(client, checked.error ?? unknownCommand(argv[0], argv.slice(1)), checked.statName);
      return;
    }
    const meta = checked.meta;
    const fullname = checked.statName ?? name;
    if (this.authRequired(client) && !spec.flags?.noauth) {
      this.rejectCommand(client, RespMessages.NOAUTH, fullname, name === 'exec');
      return;
    }
    if (client.multi && meta?.flagSet.has('no_multi')) {
      this.rejectCommand(client, 'ERR Command not allowed inside a transaction', fullname);
      return;
    }
    const denial = this.aclDenial(client, argv, meta);
    if (denial && client.user) {
      client.lastCommand = fullname;
      this.aclLogDenial(client, denial, this.aclContext(client));
      this.rejectCommand(client, noPermError(denial, client.user.name), fullname, name === 'exec');
      return;
    }
    if (client.resp === 2 && client.subscriptionCount > 0 && !SUBSCRIBER_ALLOWED.has(name)) {
      this.rejectCommand(client, RespMessages.SUBSCRIBE_CONTEXT.replace('%s', name), fullname);
      return;
    }

    if (client.multi && !MULTI_IMMEDIATE.has(name)) {
      client.multi.push(argv);
      client.write(QUEUED);
      return;
    }

    const result = this.execute(client, argv, { inScript: false, noBlock: false }, checked);
    if (result instanceof Block) this.block(client, result, argv);
    else if (result !== NO_REPLY) client.write(result);
    this.serveReadyKeys();
  }

  /**
   * Redis rejectCommand(): flags a pending transaction, counts the rejection and replies the error. A rejected EXEC
   * aborts the transaction instead (execCommandAbort).
   */
  private rejectCommand(client: Client, message: string, statName?: string, isExec = false): void {
    if (client.multi) client.multiError = true;
    if (statName) this.commandStat(statName).rejected++;
    if (isExec) {
      client.multi = null;
      client.multiError = false;
      client.watched.clear();
      const reason = message.startsWith('NOAUTH') ? `${message}  ` : message;
      this.replyError(client, `EXECABORT Transaction discarded because of: ${reason}`);
      return;
    }
    this.replyError(client, message);
  }

  /** authRequired(): the default user needs a password (or is off) and this client has not authenticated. */
  authRequired(client: Client): boolean {
    return !client.authenticated && !this.acl.defaultLoginAllowed();
  }

  // ---- ACL -----------------------------------------------------------------------------------------------------

  /** ACLCheckAllPerm() for argv (argv[0] included); null when allowed, the client is a superuser or the command is unknown. */
  aclDenial(client: Client, argv: string[], meta = lookupCommand(argv).meta): AclDenial | null {
    const user = client.user;
    if (!user || !meta) return null;
    return this.aclCheckUser(user, argv, meta);
  }

  aclCheckUser(user: AclUser, argv: string[], meta: CommandMeta): AclDenial | null {
    const root = user.root;
    if (root.allCommands && root.allKeys && root.allChannels) return null;
    const command = meta.parent ? meta.parent.name : meta.name;
    const sub = meta.parent ? meta.name : null;
    const keys = user.selectors.some((s) => !s.allKeys) ? aclKeysOf(meta, argv) : [];
    const noauth = meta.flagSet.has('no_auth') || Boolean(COMMANDS.get(command)?.flags?.noauth);
    return this.acl.check(user, command, sub, argv.slice(1), keys, { noauth });
  }

  /** ACL LOG context of a client: `multi` while queueing or running a transaction. */
  aclContext(client: Client): AclLogContext {
    return client.multi || client.inExec ? 'multi' : 'toplevel';
  }

  /** addACLLogEntry(): ACL LOG + INFO acl_access_denied_* counters. */
  aclLog(client: Client, entry: Omit<AclLogInput, 'clientInfo'>): void {
    this.aclStats[entry.reason]++;
    this.acl.log({ ...entry, clientInfo: clientInfoLine(this, client) });
  }

  aclLogDenial(client: Client, denial: AclDenial, context: AclLogContext): void {
    this.aclLog(client, { reason: denial.reason, context, object: denial.object, username: client.user?.name ?? 'default' });
  }

  /** Closes a connection after the current reply when it is the caller, right away otherwise (freeClientAsync). */
  private killOrCloseAfterReply(target: Client, current: Client | null): void {
    if (target === current) target.closeAfterReply = true;
    else this.killClient(target);
  }

  /** ACLFreeUserAndKillClients(): every connection authenticated as `user` is closed (ACL DELUSER, ACL LOAD). */
  killUserClients(user: AclUser, current: Client | null): void {
    for (const c of [...this.clients]) {
      if (c.user !== user) continue;
      c.user = this.defaultUser;
      c.authenticated = false;
      this.killOrCloseAfterReply(c, current);
    }
  }

  /** ACLKillPubsubClientsIfNeeded(): subscribers of `user` holding a channel or pattern it may no longer access are closed. */
  killRevokedSubscribers(user: AclUser, current: Client | null): void {
    for (const c of [...this.clients]) {
      if (c.user !== user || c.subscriptionCount === 0) continue;
      const revoked =
        [...c.channels].some((ch) => !this.acl.channelAllowed(user, ch, false)) ||
        [...c.shardChannels].some((ch) => !this.acl.channelAllowed(user, ch, false)) ||
        [...c.patterns].some((p) => !this.acl.channelAllowed(user, p, true));
      if (revoked) this.killOrCloseAfterReply(c, current);
    }
  }

  /** Reads the ACL file; throws CommandError with Redis's ACL LOAD error text. Returns the names whose users changed. */
  loadAclFile(path: string, current: Client | null = null): string[] {
    let text: string;
    try {
      text = readFileSync(path, 'latin1');
    } catch (e) {
      throw new CommandError(`ERR Error loading ACLs, opening file '${path}': ${strerror(e)}`);
    }
    const before = new Map(this.acl.users().map((n) => [n, this.acl.user(n)] as const));
    const changed = this.acl.loadFile(text, path);
    for (const name of changed) {
      const old = before.get(name);
      // the default user is updated in place and keeps its clients (pub/sub permissions are re-checked below)
      if (old && name !== 'default') this.killUserClients(old, current);
    }
    for (const u of before.values()) if (u && this.acl.user(u.name) === u) this.killRevokedSubscribers(u, current);
    return changed;
  }

  // ---- memory --------------------------------------------------------------------------------------------------

  private keyRecords(db: Database): KeyRecord[] {
    const out: KeyRecord[] = [];
    for (const key of db.keys()) {
      const value = db.peek(key);
      if (!value) continue;
      const fieldTtls = value.type === 'hash' ? hashFieldExpires(value.value) : undefined;
      out.push({
        key,
        value,
        encoding: objectEncoding(value, this.config, fieldTtls !== undefined),
        hasExpire: db.getExpire(key) !== undefined,
        fieldTtls,
      });
    }
    return out;
  }

  /** used_memory and friends (getMemoryOverheadData over the whole dataset); also tracks used_memory_peak. */
  memoryReport(): MemoryReport {
    const clientsNormal = this.clients.size * clientMemory();
    const key = `${this.memoryEpoch}|${clientsNormal}`;
    let report = this.memoryCache?.key === key ? this.memoryCache.report : null;
    if (!report) {
      const databases = this.databases.map((db, id) => {
        const keys = this.keyRecords(db);
        if (keys.length) this.dbAllocated[id] = true;
        return { id, keys, allocated: this.dbAllocated[id] };
      });
      report = computeMemory({
        databases,
        clientsNormal,
        sizes: {
          listMaxListpackSize: this.config.num('list-max-listpack-size'),
          streamNodeMaxEntries: this.config.num('stream-node-max-entries'),
          streamNodeMaxBytes: this.config.num('stream-node-max-bytes'),
        },
      });
      this.memoryCache = { key, report };
    }
    if (report.usedMemory > this.memoryPeak) {
      this.memoryPeak = report.usedMemory;
      this.memoryPeakTime = Math.floor(Date.now() / 1000);
    }
    // the report's own peak is max(previous peak, used) at computation time; refresh it with the tracked peak
    if (report.peak !== this.memoryPeak) {
      report = { ...report, peak: this.memoryPeak, peakPercentage: Math.fround((report.usedMemory * 100) / this.memoryPeak) };
    }
    return report;
  }

  /** CONFIG SET side effects. */
  applyConfig(name: string, value: string): void {
    this.memoryEpoch++;
    switch (ServerConfig.canonical(name)) {
      case 'requirepass':
        this.acl.setRequirePass(value);
        break;
      case 'acllog-max-len':
        this.acl.logMaxLen = Number(value);
        break;
      case 'acl-pubsub-default':
        this.acl.pubsubDefault = value === 'allchannels' ? 'allchannels' : 'resetchannels';
        break;
    }
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
  execute(
    client: Client,
    argv: string[],
    mode: { inScript: boolean; noBlock: boolean },
    prechecked?: ReturnType<RedisLiteServer['reject']>,
  ): Reply | Block | typeof NO_REPLY {
    const name = argv[0].toLowerCase();
    const args = argv.slice(1);
    const spec = COMMANDS.get(name);
    const checked = prechecked ?? this.reject(argv);
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
    if (mode.inScript && client.user) {
      // scriptVerifyACL()
      const denial = this.aclDenial(client, argv, meta);
      if (denial) {
        this.aclLogDenial(client, denial, 'lua');
        return new RespError(`ERR ACL failure in script: ${aclDenialMessage(denial, client.user.name)}`);
      }
    }

    if (this.monitors.size && !meta?.flagSet.has('skip_monitor') && !meta?.flagSet.has('admin')) this.feedMonitors(client, argv, mode.inScript);
    this.stats.commands++;
    client.commandsProcessed++;
    if (!mode.inScript) client.lastCommand = fullname;
    const db = this.databases[client.dbIndex];
    const ctx: CommandContext = { server: this, client, db, inScript: mode.inScript, noBlock: mode.noBlock, noop: false, name: argv[0] };
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
    this.memoryEpoch++;
    const value = this.databases[dbIndex]?.peek(key);
    if (value) this.dbAllocated[dbIndex] = true;
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
    this.memoryEpoch++;
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
    client.inExec = true;
    try {
      for (const argv of queued) {
        // ACL permissions are checked again at EXEC time in case they changed after the commands were queued
        const denial = this.aclDenial(client, argv);
        if (denial) {
          client.lastCommand = 'exec';
          this.aclLogDenial(client, denial, 'multi');
          const message =
            'NOPERM ACLs rules changed between the moment the transaction was accumulated and the EXEC call. ' +
            `This command is no longer allowed for the following reason: ${EXEC_ACL_REASONS[denial.reason]}`;
          this.countError(message);
          replies.push(new RespError(message));
          continue;
        }
        const r = this.execute(client, argv, { inScript: false, noBlock: true });
        replies.push(r instanceof Block || r === NO_REPLY ? NULL_ARRAY : r);
      }
    } finally {
      client.inExec = false;
    }
    return replies;
  }

  /**
   * FLUSHDB / FLUSHALL / SWAPDB (Redis touchAllWatchedKeysInDb): invalidates the WATCHes on keys of `dbIndex` that exist there (or,
   * for SWAPDB, in `other`). Call it before the database changes. Watched keys that did not exist are left alone (Redis 7.0+).
   */
  signalFlushedDb(dbIndex: number, other?: number): void {
    // the peak is sampled on demand; take a sample before a database is emptied
    if (other === undefined && this.databases[dbIndex]?.keys().length) this.memoryReport();
    this.memoryEpoch++;
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

  private block(client: Client, block: Block, argv?: string[]): void {
    const waiter: Waiter = {
      argv,
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
            if (this.rejectBlockedByAcl(waiter)) {
              released.push(waiter.client);
              continue;
            }
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

  /** A blocked command is re-checked against the ACLs before it is served (Redis reprocesses it): NOPERM when revoked. */
  private rejectBlockedByAcl(waiter: Waiter): boolean {
    const { client, argv } = waiter;
    if (!argv || !client.user) return false;
    const { meta } = lookupCommand(argv);
    const denial = meta ? this.aclDenial(client, argv, meta) : null;
    if (!denial || !meta) return false;
    this.unblock(waiter);
    this.aclLogDenial(client, denial, 'toplevel');
    this.commandStat(meta.fullname).rejected++;
    this.replyError(client, noPermError(denial, client.user.name));
    return true;
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
    this.memoryEpoch++;
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
    return new Client(this.nextClientId++, null, false, null);
  }

  status(text: string): Status {
    return new Status(text);
  }
}
