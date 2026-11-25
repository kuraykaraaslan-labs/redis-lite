import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';

import { AppError } from '@/libs/app-error';
import { RespMessages, unknownCommand, unknownSubcommand, wrongArity } from '@/libs/resp/messages';
import type { Reply } from '@/libs/resp';
import { NULL_ARRAY, OK, QUEUED, RespError, RespParser, RespPush, Status } from '@/libs/resp';
import { matchGlob } from '@/libs/glob';
import { formatMessage } from '@/libs/message-format';
import Logger from '@/libs/logger';
import type { LogContext, LogLevelName } from '@/libs/logger';

import { COMMANDS } from '@/modules/command/command.registry';
import { clientInfoLine } from '@/modules/connection/connection.commands';
import type { CommandMeta } from '@/modules/command/command.meta';
import { allCommandsDeep, arityOk, getCommandMeta, keysFromSpecs, lookupCommand } from '@/modules/command/command.meta';
import type { CommandContext } from '@/modules/command/command.types';
import { Block, NO_REPLY } from '@/modules/command/command.handler';
import { LuaEngine } from '@/modules/scripting/scripting.engine';
import { hashHasFieldTtl } from '@/modules/hashes/hashes.commands';
import { Database } from '@/modules/database/database.core';
import type { RedisValue } from '@/modules/database/database.core';
import { updateEncoding } from '@/modules/database/database.encoding';
import { clientMemory, computeMemory, memoryForEviction } from '@/modules/memory/memory.accounting';
import type { MemoryReport } from '@/modules/memory/memory.accounting';
import { Acl, aclDenialMessage, noPermError } from '@/modules/acl/acl.core';
import type { AclDenial, AclLogContext, AclLogInput, AclUser, KeyAccess } from '@/modules/acl/acl.core';
import { Evictor, OOM_ERROR } from '@/modules/memory/memory.eviction';
import { MemoryTracker } from '@/modules/memory/memory.tracker';
import { keyspaceEvents, notificationMessages, parseNotifyFlags, setWrote } from '@/modules/notifications/notifications.core';
import type { KeyEvent, NotifyFlags } from '@/modules/notifications/notifications.core';
import { Persistence } from '@/modules/persistence/persistence.core';
import type { Propagator } from '@/modules/persistence/persistence.propagate';
import { Tracking } from '@/modules/tracking/tracking.core';

import { Client } from './server.client';
import { ServerConfig } from './server.config';
import type { Waiter } from './server.client';

export interface ServerOptions {
  port: number;
  host: string;
  password?: string;
  databases: number;
  logLevel: 'silent' | 'warn' | 'info' | 'debug';
  /** ACL file (the immutable `aclfile` config): loaded at startup, used by ACL LOAD / ACL SAVE. */
  aclfile?: string;
  /**
   * Load the RDB / AOF at startup and keep the configured save points. False (the default for embedded servers): the
   * server stays in memory (`save ""`, `appendonly no`, nothing loaded) unless `config` says otherwise.
   */
  persistence?: boolean;
  /** Initial config values (redis.conf directives / CONFIG SET names), validated like CONFIG SET. */
  config?: Record<string, string>;
  /** Absolute path of the redis.conf the server was started with (INFO config_file). */
  configFile?: string;
}

/** Configs that change how the memory model sizes existing keys. */
const MEMORY_MODEL_CONFIGS = /max-listpack|max-intset|max-ziplist|stream-node|list-compress/;

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
  'lpop', 'rpop', 'spop', 'zpopmin', 'zpopmax', 'getdel', 'getex', 'lmove', 'rpoplpush', 'lmpop', 'zmpop', 'blpop', 'brpop',
  'blmove', 'brpoplpush', 'blmpop', 'bzpopmin', 'bzpopmax', 'bzmpop', 'xadd',
]);

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

/** Redis chdir()s into `dir`: it must be an existing directory. The absolute path, or the strerror text. */
export function resolveDir(dir: string): { path: string } | { error: string } {
  const path = resolvePath(dir);
  try {
    if (!statSync(path).isDirectory()) return { error: 'Not a directory' };
  } catch (e) {
    return { error: strerror(e) };
  }
  return { path };
}

function checkDir(dir: string): string {
  const r = resolveDir(dir);
  if ('error' in r) throw new Error(`Can't chdir to '${dir}': ${r.error}`);
  return r.path;
}

/** Element count of a value (stream entries, list / set / hash / zset elements, string bytes). */
function valueSize(v: RedisValue | undefined): number {
  if (!v) return 0;
  switch (v.type) {
    case 'string':
    case 'list':
      return v.value.length;
    case 'hash':
    case 'set':
    case 'zset':
      return v.value.size;
    case 'stream':
      return v.value.length;
  }
}

/** Keys of a command from its key extractor; a malformed command (rejected by the handler) has none. */
function specKeys(extract: ((args: string[]) => string[]) | undefined, args: string[]): string[] {
  if (!extract) return [];
  try {
    return extract(args).filter((k): k is string => typeof k === 'string');
  } catch {
    return [];
  }
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
  lua!: LuaEngine;
  /** RDB / AOF, the dirty counter and command propagation. */
  readonly persistence: Persistence;
  /** maxmemory eviction. */
  readonly evictor: Evictor;
  /** CLIENT TRACKING (client-side caching). */
  readonly tracking: Tracking;
  /** Incremental used-memory accounting. */
  private readonly memory: MemoryTracker;
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
  /** Standalone Redis allocates a db's dicts on first use and keeps them (MEMORY STATS db.N). */
  private readonly dbAllocated: boolean[];
  private readonly clientsById = new Map<number, Client>();
  /** The eviction pass before the current top-level command could not get under maxmemory (scripts check it too). */
  private preCommandOom = false;
  /** SHUTDOWN already ran the persistence shutdown steps. */
  private shutdownPrepared = false;
  private notifyCache: { raw: string; flags: NotifyFlags | null } = { raw: '', flags: null };

  constructor(readonly options: ServerOptions) {
    Logger.setLevel(options.logLevel);
    this.config = new ServerConfig({
      port: String(options.port),
      bind: options.host,
      databases: String(options.databases),
      requirepass: options.password ?? '',
      aclfile: options.aclfile ?? '',
    });
    if (!options.persistence) {
      // embedded servers stay in memory unless told otherwise
      this.config.set('save', '');
      this.config.set('appendonly', 'no');
    }
    this.databases = Array.from(
      { length: options.databases },
      (_, i) => new Database((key) => this.onExpired(i, key), this.config, (key) => this.memory.changed(i, key)),
    );
    this.memory = new MemoryTracker(this.databases, this.config);
    this.dbAllocated = this.databases.map(() => false);
    this.persistence = new Persistence(this);
    this.evictor = new Evictor(this);
    this.tracking = new Tracking(this);
    this.debugHooks.reload = (_client, args) => {
      const opts = { merge: false, noflush: false, nosave: false };
      for (const a of args) {
        const o = a.toLowerCase();
        if (o === 'merge') opts.merge = true;
        else if (o === 'noflush') opts.noflush = true;
        else if (o === 'nosave') opts.nosave = true;
        else throw new AppError('ERR DEBUG RELOAD only supports the MERGE, NOFLUSH and NOSAVE options.');
      }
      const reply = this.persistence.debugReload(opts);
      this.evictor.clearPool();
      return reply;
    };
    this.debugHooks.loadaof = () => {
      const reply = this.persistence.debugLoadAof();
      this.evictor.clearPool();
      return reply;
    };
    this.acl = new Acl({
      allCommands: () => allCommandsDeep().map((m) => m.fullname),
      categoriesOf: (name) => (getCommandMeta(name)?.acl ?? []).map((c) => `@${c}`),
      requirepass: options.password ?? '',
      pubsubDefault: this.config.get('acl-pubsub-default') === 'allchannels' ? 'allchannels' : 'resetchannels',
      logMaxLen: this.config.num('acllog-max-len'),
    });
    for (const [name, value] of Object.entries(options.config ?? {})) this.initConfig(name, value);
  }

  /** A startup config value (constructor `config`, redis.conf): validated like CONFIG SET. */
  private initConfig(name: string, value: string): void {
    if (!this.config.has(name)) throw new Error(`Bad directive or wrong number of arguments: '${name}'`);
    const r = this.config.validate(name, value);
    if ('error' in r) throw new Error(`Invalid value for '${name}': ${r.error}`);
    let v = r.value;
    if (ServerConfig.canonical(name) === 'dir') v = checkDir(v);
    this.config.set(name, v);
    this.applyConfig(name, v);
  }

  /** Writes since the last save (INFO rdb_changes_since_last_save). */
  get dirty(): number {
    return this.persistence.dirty;
  }

  /** Unix ms of the last successful save (LASTSAVE). */
  get lastSave(): number {
    return this.persistence.lastSave;
  }

  get propagator(): Propagator {
    return this.persistence.propagator;
  }

  clientById(id: number): Client | undefined {
    return this.clientsById.get(id);
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
    if (this.options.persistence) this.persistence.loadAtStartup();
    this.persistence.start();
    const net = createServer((socket) => this.accept(socket));
    this.net = net;
    try {
      await new Promise<void>((resolve, reject) => {
        net.once('error', reject);
        net.listen(this.options.port, this.options.host, () => {
          net.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.persistence.stop();
      this.net = null;
      throw error;
    }
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

  /**
   * SHUTDOWN: the persistence steps (final save per the save points / SAVE / NOSAVE, AOF flush) then the close. False
   * when saving failed and FORCE was not given: the server keeps running.
   */
  shutdown(opts: { save?: boolean; nosave?: boolean; force?: boolean }): boolean {
    if (!this.persistence.prepareShutdown(opts)) return false;
    this.shutdownPrepared = true;
    setImmediate(() => void this.close());
    return true;
  }

  private async doClose(): Promise<void> {
    // like SIGTERM: final save when save points are configured; an embedded close never refuses to stop
    if (!this.shutdownPrepared) this.persistence.prepareShutdown({ force: true });
    this.evictor.stop();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const list of this.waiters.values()) for (const w of list) if (w.timer) clearTimeout(w.timer);
    this.waiters.clear();
    for (const client of this.clients) {
      client.closed = true;
      client.socket?.destroy();
    }
    this.clients.clear();
    this.clientsById.clear();
    const net = this.net;
    this.net = null;
    if (net) await new Promise<void>((resolve) => net.close(() => resolve()));
  }

  /** Log sink handed to the subsystems (persistence): one structured line through Logger. */
  log(level: LogLevelName, message: string, context: LogContext = {}): void {
    Logger[level](message, context);
  }

  // ---- connections ---------------------------------------------------------------------------------------------

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    // clientSetDefaultAuth(): logged in as default when default is `on nopass`
    const client = new Client(this.nextClientId++, socket, !this.acl.defaultLoginAllowed(), this.defaultUser);
    this.clients.add(client);
    this.clientsById.set(client.id, client);
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
    this.clientsById.delete(client.id);
    if (client.tracking) this.tracking.disable(client);
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
      if (!spec) Logger.warn('[RedisLiteServer.runTopLevel] Unknown command', { command: name });
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
    const queueing = Boolean(client.multi) && !MULTI_IMMEDIATE.has(name);
    // performEvictions(): before every command while maxmemory is set; denyoom commands are refused when it fails
    if (this.config.num('maxmemory') > 0) {
      this.preCommandOom = this.evictor.perform() === 'fail';
      // queueing in MULTI could grow memory without bound, so any queued command is refused too
      const denyoom = queueing || meta?.flagSet.has('denyoom') || (name === 'exec' && this.queuedHasFlag(client, 'denyoom'));
      if (this.preCommandOom && denyoom) {
        this.rejectCommand(client, OOM_ERROR, fullname, name === 'exec');
        return;
      }
    } else this.preCommandOom = false;
    // MISCONF: a failed BGSAVE / AOF write stops writes (and PING)
    const diskError = this.persistence.writeDeniedError();
    if (diskError !== null) {
      const write = meta?.flagSet.has('write') || name === 'ping' || (name === 'exec' && this.queuedHasFlag(client, 'write'));
      if (write) {
        this.rejectCommand(client, diskError, fullname, name === 'exec');
        return;
      }
    }
    if (client.resp === 2 && client.subscriptionCount > 0 && !SUBSCRIBER_ALLOWED.has(name)) {
      this.rejectCommand(client, formatMessage(RespMessages.SUBSCRIBE_CONTEXT, { command: name }), fullname);
      return;
    }

    if (queueing && client.multi) {
      client.multi.push(argv);
      client.write(QUEUED);
      return;
    }

    this.tracking.current = client;
    let result: Reply | Block | typeof NO_REPLY;
    try {
      result = this.execute(client, argv, { inScript: false, noBlock: false }, checked);
    } finally {
      this.tracking.current = null;
    }
    if (result instanceof Block) this.block(client, result, argv);
    else if (result !== NO_REPLY) client.write(result);
    this.tracking.flushDeferred(client);
    // CLIENT CACHING applies to the next command only (a whole transaction counts as one)
    if (!client.multi && !(name === 'client' && argv[1]?.toLowerCase() === 'caching')) client.trackingCaching = null;
    this.tracking.enforceLimit();
    this.serveReadyKeys();
  }

  /** Whether a command queued in the client's transaction has a Redis command flag (EXEC inherits write / denyoom). */
  private queuedHasFlag(client: Client, flag: string): boolean {
    return (client.multi ?? []).some((argv) => lookupCommand(argv).meta?.flagSet.has(flag));
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

  /** Reads the ACL file; throws AppError with Redis's ACL LOAD error text. Returns the names whose users changed. */
  loadAclFile(path: string, current: Client | null = null): string[] {
    let text: string;
    try {
      text = readFileSync(path, 'latin1');
    } catch (e) {
      throw new AppError(`ERR Error loading ACLs, opening file '${path}': ${strerror(e)}`);
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

  /** used_memory and friends (getMemoryOverheadData over the whole dataset); also tracks used_memory_peak. */
  memoryReport(): MemoryReport {
    const databases = this.memory.snapshots((id, keys) => {
      if (keys) this.dbAllocated[id] = true;
      return this.dbAllocated[id];
    });
    let report = computeMemory({
      databases,
      clientsNormal: this.clients.size * clientMemory(),
      sizes: {
        listMaxListpackSize: this.config.num('list-max-listpack-size'),
        streamNodeMaxEntries: this.config.num('stream-node-max-entries'),
        streamNodeMaxBytes: this.config.num('stream-node-max-bytes'),
      },
    });
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

  /** used_memory as maxmemory sees it. */
  usedMemoryForEviction(): number {
    return memoryForEviction(this.memoryReport());
  }

  /** Evicts one key (maxmemory): delete, propagate DEL / UNLINK, `evicted` event, WATCH and tracking invalidation. */
  evictKey(dbIndex: number, key: string): void {
    const db = this.databases[dbIndex];
    if (!db.remove(key)) return;
    this.persistence.propagator.also(dbIndex, [this.config.get('lazyfree-lazy-eviction') === 'yes' ? 'UNLINK' : 'DEL', key]);
    this.notify(dbIndex, [{ cls: 'e', event: 'evicted', key }]);
    const k = `${dbIndex}:${key}`;
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
    this.tracking.invalidate(key, null);
  }

  /** CONFIG SET side effects. */
  applyConfig(name: string, value: string): void {
    const canonical = ServerConfig.canonical(name);
    // the memory tracker may not exist yet while the constructor applies startup configs
    if (MEMORY_MODEL_CONFIGS.test(canonical)) this.memory?.invalidateAll();
    switch (canonical) {
      case 'maxmemory':
        // lowering maxmemory evicts right away
        if (this.evictor && Number(value) > 0) this.evictor.perform();
        break;
      case 'maxmemory-policy':
        this.evictor?.clearPool();
        break;
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
      if (!spec) Logger.warn('[RedisLiteServer.execute] Unknown command', { command: name });
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

    if (mode.inScript) {
      // the checks processCommand() makes for top-level commands, for redis.call
      if (spec.flags?.write || meta?.flagSet.has('write')) {
        const diskError = this.persistence.writeDeniedError();
        if (diskError !== null) return new RespError(diskError);
      }
      if (this.preCommandOom && meta?.flagSet.has('denyoom')) return new RespError(OOM_ERROR);
    }

    if (this.monitors.size && !meta?.flagSet.has('skip_monitor') && !meta?.flagSet.has('admin')) this.feedMonitors(client, argv, mode.inScript);
    this.stats.commands++;
    client.commandsProcessed++;
    if (!mode.inScript) client.lastCommand = fullname;
    const dbIndex = client.dbIndex;
    const db = this.databases[dbIndex];
    const ctx: CommandContext = { server: this, client, db, inScript: mode.inScript, noBlock: mode.noBlock, noop: false, name: argv[0] };
    db.touchOnRead = !client.noTouch || name === 'touch';
    const notify = this.notifyFlags();
    // read commands only need their keys for keyspace notifications (keymiss)
    let keys: string[] = [];
    if (spec.keys) keys = specKeys(spec.keys, args);
    else if (notify && meta) keys = (keysFromSpecs(meta, argv) ?? []).map((r) => argv[r.index]);
    const propagator = this.persistence.propagator;
    propagator.enter(name);
    let result: Reply | Block | typeof NO_REPLY;
    const started = process.hrtime.bigint();
    try {
      // the state of the command's keys before it runs: `new` / `keymiss` events, and SET … GET's no-op test
      const before = notify || name === 'set' ? this.keyStates(db, keys) : null;
      const dirtyBefore = this.persistence.dirty;
      let noop = false;
      try {
        result = spec.handler(ctx, args);
        if (!(result instanceof Block) && result !== NO_REPLY) {
          noop = ctx.noop || isNoop(name, args, result, before?.get(keys[0])?.exists ?? false);
          if (spec.flags?.write && !noop) for (const key of keys) this.touch(dbIndex, key);
        }
      } catch (error) {
        if (error instanceof AppError) result = new RespError(error.message);
        else {
          Logger.error('[RedisLiteServer.execute] Internal error', { command: name, err: (error as Error).stack ?? String(error) });
          result = new RespError(`ERR ${(error as Error).message}`);
        }
      }
      if (!(result instanceof Block) && result !== NO_REPLY) {
        propagator.record(dbIndex, argv, result, this.persistence.dirty - dirtyBefore);
        if (notify && before) this.notifyCommand(dbIndex, name, args, result, keys, before, Boolean(spec.flags?.write), noop, meta);
      }
      if (client.tracking && meta?.flagSet.has('readonly')) {
        this.tracking.remember(client, (keysFromSpecs(meta, argv) ?? []).map((r) => argv[r.index]));
      }
    } finally {
      propagator.exit();
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

  // ---- keyspace notifications ----------------------------------------------------------------------------------

  /** Parsed notify-keyspace-events, or null when no notification can be published (or while loading). */
  private notifyFlags(): NotifyFlags | null {
    const raw = this.config.get('notify-keyspace-events') ?? '';
    if (raw !== this.notifyCache.raw) {
      const flags = parseNotifyFlags(raw);
      this.notifyCache = { raw, flags: (flags.keyspace || flags.keyevent) && flags.classes.size ? flags : null };
    }
    return this.persistence.loading ? null : this.notifyCache.flags;
  }

  /** Publishes keyspace / keyevent messages for events in database `dbIndex` (an event may name another db). */
  notify(dbIndex: number, events: readonly KeyEvent[]): void {
    const flags = this.notifyFlags();
    if (!flags || !events.length) return;
    for (const e of events) for (const [channel, message] of notificationMessages(flags, e.db ?? dbIndex, e)) this.publish(channel, message);
  }

  private keyStates(db: Database, keys: readonly string[]): Map<string, { exists: boolean; size: number }> {
    const out = new Map<string, { exists: boolean; size: number }>();
    for (const key of keys) {
      if (out.has(key)) continue;
      const v = db.peek(key);
      out.set(key, { exists: v !== undefined, size: valueSize(v) });
    }
    return out;
  }

  /** Events of one executed command: `new` for created keys, the command's own events, `keymiss` for missed reads. */
  private notifyCommand(
    dbIndex: number,
    name: string,
    args: string[],
    reply: Reply,
    keys: readonly string[],
    before: Map<string, { exists: boolean; size: number }>,
    write: boolean,
    noop: boolean,
    meta: CommandMeta | undefined,
  ): void {
    if (reply instanceof RespError) return;
    const db = this.databases[dbIndex];
    const exists = (key: string): boolean => db.peek(key) !== undefined;
    const events: KeyEvent[] = [];
    if (write && !noop) {
      for (const key of before.keys()) if (!before.get(key)?.exists && exists(key)) events.push({ cls: 'n', event: 'new', key });
      events.push(
        ...keyspaceEvents({
          name,
          args,
          reply,
          existedBefore: (key) => before.get(key)?.exists ?? false,
          existsAfter: exists,
          sizeBefore: (key) => before.get(key)?.size ?? 0,
          sizeAfter: (key) => valueSize(db.peek(key)),
        }),
      );
    }
    if (!write && meta?.flagSet.has('readonly')) {
      for (const [key, state] of before) if (!state.exists) events.push({ cls: 'm', event: 'keymiss', key });
    }
    this.notify(dbIndex, events);
  }

  /** Hash fields expired lazily (hash field TTL): `hexpired`, plus `del` when the hash is gone. */
  fieldsExpired(dbIndex: number, key: string, keyDeleted: boolean): void {
    this.memory.changed(dbIndex, key);
    const events: KeyEvent[] = [{ cls: 'h', event: 'hexpired', key }];
    if (keyDeleted) events.push({ cls: 'g', event: 'del', key });
    this.notify(dbIndex, events);
  }

  /**
   * FLUSHDB / FLUSHALL: empties the databases, counts the removed keys as changes, invalidates WATCHes and every
   * tracking client's cache. FLUSHALL also kills a running BGSAVE and saves at once when save points are configured.
   */
  flushDatabases(indexes: readonly number[], all: boolean): void {
    for (const i of indexes) {
      this.persistence.markDirty(this.databases[i].keys().length);
      this.signalFlushedDb(i);
      this.databases[i].flush();
    }
    this.tracking.flushed();
    this.evictor.clearPool();
    if (all) {
      this.persistence.afterFlushAll();
      this.persistence.markDirty(1);
    }
  }

  /** Marks a key modified: invalidates WATCH and wakes clients blocked on it. */
  touch(dbIndex: number, key: string): void {
    this.persistence.markDirty(1);
    this.memory.changed(dbIndex, key);
    this.tracking.invalidate(key, this.tracking.current);
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

  /** A key expired (on access or by the active cycle): DEL / UNLINK propagation, `expired` event, invalidation. */
  private onExpired(dbIndex: number, key: string): void {
    this.stats.expired++;
    const k = `${dbIndex}:${key}`;
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
    this.persistence.propagator.expired(dbIndex, key);
    this.notify(dbIndex, [{ cls: 'x', event: 'expired', key }]);
    this.tracking.invalidate(key, null);
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
    if (other === undefined && this.databases[dbIndex]?.storedKeys) this.memoryReport();
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
            const reply = this.retryBlocked(waiter);
            if (reply === undefined) continue;
            this.unblock(waiter);
            waiter.client.write(reply);
            this.tracking.flushDeferred(waiter.client);
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

  /**
   * Tries to serve a blocked client. A served command is its own execution unit: it is propagated (as its non-blocking
   * form) and its keyspace events are published, like a command that just ran.
   */
  private retryBlocked(waiter: Waiter): Reply | undefined {
    const { client, argv } = waiter;
    const db = this.databases[client.dbIndex];
    const name = argv?.[0].toLowerCase() ?? '';
    const spec = COMMANDS.get(name);
    const keys = argv ? specKeys(spec?.keys, argv.slice(1)) : [];
    const notify = argv ? this.notifyFlags() : null;
    const before = notify ? this.keyStates(db, keys) : null;
    const dirtyBefore = this.persistence.dirty;
    const propagator = this.persistence.propagator;
    propagator.enter(name);
    this.tracking.current = client;
    try {
      const reply = waiter.retry();
      if (reply !== undefined && argv) {
        propagator.record(client.dbIndex, argv, reply, this.persistence.dirty - dirtyBefore);
        if (before) this.notifyCommand(client.dbIndex, name, argv.slice(1), reply, keys, before, true, false, lookupCommand(argv).meta);
      }
      return reply;
    } finally {
      this.tracking.current = null;
      propagator.exit();
    }
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
