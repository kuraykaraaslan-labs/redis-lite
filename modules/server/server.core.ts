import { randomBytes } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';

import { AppError } from '@/libs/app-error';
import Logger from '@/libs/logger';
import type { LogContext, LogLevelName } from '@/libs/logger';
import { formatMessage } from '@/libs/message-format';
import { Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { AclLogContext } from '@/modules/acl/acl.enums';
import type { Acl } from '@/modules/acl/acl.service';
import type { AclUser } from '@/modules/acl/acl.structure';
import type { AclDenial, AclLogInput } from '@/modules/acl/acl.types';
import type { CommandMeta, HandlerResult } from '@/modules/command/command.types';
import type { Database } from '@/modules/database/database.service';
import type { ExpiryControl } from '@/modules/database/database.types';
import type { MemoryReport } from '@/modules/memory/memory.types';
import { Evictor } from '@/modules/memory/memory.service';
import type { KeyEvent } from '@/modules/notifications/notifications.types';
import { Persistence } from '@/modules/persistence/persistence.service';
import type { Propagator } from '@/modules/persistence/persistence.service';
import { Replication } from '@/modules/replication/replication.service';
import { LuaEngine } from '@/modules/scripting/scripting.engine';
import { LabelIndex } from '@/modules/timeseries/timeseries.index.structure';
import { Tracking } from '@/modules/tracking/tracking.service';

import { ServerAccess } from './server.access';
import { ServerBlocking } from './server.blocking';
import type { Client } from './server.client';
import { ServerConfig } from './server.config';
import { ServerConnections } from './server.connections';
import { ServerDispatcher } from './server.dispatcher';
import { ServerKeyspace } from './server.keyspace';
import { ServerListener } from './server.listener';
import { ServerMemoryModel } from './server.memory_model';
import ServerMessages from './server.messages';
import { ServerObserver } from './server.observer';
import { ServerPubSub } from './server.pubsub';
import { ServerSettings } from './server.settings';
import type { CommandStat, DebugHooks, ExecuteMode, PauseMode, Precheck, ServerOptions, SlowlogEntry } from './server.types';

/**
 * The redis-lite server: one in-memory keyspace, one command at a time (which is what makes every command atomic).
 *
 * This class owns the shared state and the lifecycle (listen, close, SHUTDOWN, config side effects). The work is done by
 * stateful components, one per responsibility, which the public methods below delegate to: `connections` (sockets and
 * I/O), `dispatcher` (checks and execution), `blocking` (blocked clients), `pubsub` (fan-out), `keyspace` (WATCHed
 * keys, key changes, notifications), `access` (ACL wiring), `observer` (stats, SLOWLOG, MONITOR) and `memoryModel`.
 */
export class RedisLiteServer {
  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  readonly runId = randomBytes(20).toString('hex');
  readonly startedAt = Date.now();
  readonly databases: Database[];
  readonly clients = new Set<Client>();
  readonly scripts = new Map<string, string>();
  readonly channels = new Map<string, Set<Client>>();
  readonly patterns = new Map<string, Set<Client>>();
  readonly shardChannels = new Map<string, Set<Client>>();
  readonly monitors = new Set<Client>();
  readonly stats = { commands: 0, connections: 0, expired: 0, errorReplies: 0, netIn: 0, netOut: 0, keyspaceHits: 0, keyspaceMisses: 0 };
  /** INFO commandstats, by full command name (`client|id`). */
  readonly commandStats = new Map<string, CommandStat>();
  /** INFO errorstats, by error code (`ERR`, `WRONGTYPE`…). */
  readonly errorStats = new Map<string, number>();
  readonly slowlog: SlowlogEntry[] = [];
  lua!: LuaEngine;
  /** RDB / AOF, the dirty counter and command propagation. */
  readonly persistence: Persistence;
  /** maxmemory eviction. */
  readonly evictor: Evictor;
  /** CLIENT TRACKING (client-side caching). */
  readonly tracking: Tracking;
  readonly config: ServerConfig;
  /** Users, permissions and ACL LOG. */
  readonly acl: Acl;
  /** INFO stats acl_access_denied_*. */
  readonly aclStats = { auth: 0, command: 0, key: 0, channel: 0 };
  /** How every database treats elapsed TTLs (replicas never expire keys themselves; the replication runtime switches it). */
  readonly keyExpiry: ExpiryControl = { mode: 'active' };
  /** Replication: role, replication IDs and offsets, backlog, replicas, the link to a master, FAILOVER. */
  readonly replication: Replication;
  /** DEBUG SET-ACTIVE-EXPIRE: the background expire cycle runs only while true. */
  activeExpire = true;
  /** used_memory_peak and the unix time (s) it was reached. */
  memoryPeak = 0;
  memoryPeakTime = 0;
  /** The time series label index of every database (kept up to date by each Database's change hook). */
  readonly labelIndex = new LabelIndex();
  /** Extension points for DEBUG subcommands implemented elsewhere. */
  readonly debugHooks: DebugHooks = {};

  // ──────────────────────────────────────────────
  // Components (internal: other modules use the methods below)
  // ──────────────────────────────────────────────

  /** @internal */ readonly connections = new ServerConnections(this);
  /** @internal */ readonly dispatcher = new ServerDispatcher(this);
  /** @internal */ readonly blocking = new ServerBlocking(this);
  /** @internal */ readonly pubsub = new ServerPubSub(this);
  /** @internal */ readonly keyspace = new ServerKeyspace(this);
  /** @internal */ readonly access = new ServerAccess(this);
  /** @internal */ readonly observer = new ServerObserver(this);
  /** @internal */ readonly settings = new ServerSettings(this);
  /** @internal */ readonly memoryModel: ServerMemoryModel;

  private readonly listener = new ServerListener(this);
  private closing: Promise<void> | null = null;
  private readonly closeListeners: Array<() => void> = [];
  /** SHUTDOWN already ran the persistence shutdown steps. */
  private shutdownPrepared = false;

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
    this.databases = this.settings.buildDatabases(options.databases);
    this.memoryModel = new ServerMemoryModel(this);
    this.persistence = new Persistence(this);
    this.evictor = new Evictor(this);
    this.tracking = new Tracking(this);
    this.replication = new Replication(this);
    this.settings.installDebugHooks();
    this.acl = this.settings.buildAcl(options.password ?? '');
    for (const [name, value] of Object.entries(options.config ?? {})) this.settings.init(name, value);
  }

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private async doClose(): Promise<void> {
    // like SIGTERM: final save when save points are configured; an embedded close never refuses to stop
    if (!this.shutdownPrepared) this.persistence.prepareShutdown({ force: true });
    this.evictor.stop();
    this.replication.stop();
    this.blocking.clear();
    this.connections.closeAll();
    await this.listener.close();
  }

  // ──────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────

  async listen(): Promise<AddressInfo> {
    const aclfile = this.config.get('aclfile') ?? '';
    if (aclfile) this.loadAclFile(aclfile);
    this.lua = await LuaEngine.create(this);
    // Busy scripts yield to the event loop; other clients get BUSY (see ServerDispatcher.refused).
    this.lua.cooperative = true;
    if (this.options.persistence) this.persistence.loadAtStartup();
    this.persistence.start();
    let address: AddressInfo;
    try {
      address = await this.listener.open();
    } catch (error) {
      this.persistence.stop();
      throw error;
    }
    this.listener.startSweep();
    this.config.set('port', String(address.port));
    this.options.port = address.port;
    this.replication.start();
    return address;
  }

  /** CONFIG SET port (see ServerListener.rebind). */
  rebind(port: number): void {
    this.listener.rebind(port, this.closing !== null);
  }

  /** True once close() / SHUTDOWN started. */
  isClosing(): boolean {
    return this.closing !== null;
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

  /** Log sink handed to the subsystems (persistence): one structured line through Logger. */
  log(level: LogLevelName, message: string, context: LogContext = {}): void {
    Logger[level](message, context);
  }

  /** CONFIG SET side effects. */
  applyConfig(name: string, value: string): void {
    this.settings.apply(name, value);
  }

  // ──────────────────────────────────────────────
  // Accessors
  // ──────────────────────────────────────────────

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

  /** The `default` ACL user (it can never be deleted). */
  get defaultUser(): AclUser {
    const u = this.acl.user('default');
    if (!u) throw new Error(ServerMessages.DEFAULT_USER_MISSING);
    return u;
  }

  status(text: string): Status {
    return new Status(text);
  }

  // ──────────────────────────────────────────────
  // Connections and Command Execution
  // ──────────────────────────────────────────────

  clientById(id: number): Client | undefined {
    return this.connections.clientById(id);
  }

  /** A client that is not attached to a socket (embedded use, tests). */
  createInternalClient(): Client {
    return this.connections.createInternalClient();
  }

  /** Closes a connection at once (CLIENT KILL) and forgets its state. */
  killClient(client: Client): void {
    this.connections.killClient(client);
  }

  /** Replication: registers a client on a socket this server opened (the link to its master); no request parsing. */
  attachClient(socket: Socket): Client {
    return this.connections.attachClient(socket);
  }

  /** Replication: runs one command of the master's stream as the master client (replies suppressed). */
  runAsMaster(client: Client, argv: string[]): void {
    this.dispatcher.runTopLevel(client, argv);
  }

  /** Answers a client parked by a Block outside the key machinery (WAIT) and runs its next commands. */
  releaseBlocked(client: Client, reply: Reply): void {
    this.blocking.release(client, reply);
  }

  /** FAILOVER: write commands of normal clients wait until resumeWrites() (CLIENT PAUSE WRITE semantics). */
  pauseWrites(): void {
    this.connections.pauseWrites();
  }

  resumeWrites(): void {
    this.connections.resumeWrites();
  }

  /** CLIENT PAUSE timeout WRITE|ALL: normal clients' writes (or every command) wait for UNPAUSE or the timeout. */
  pauseClients(mode: PauseMode, ms: number): void {
    this.connections.pauseClients(mode, ms);
  }

  /** CLIENT UNPAUSE. */
  unpauseClients(): void {
    this.connections.unpauseClients();
  }

  /** Runs one command. Used by sockets, EXEC and Lua `redis.call`. */
  execute(client: Client, argv: string[], mode: ExecuteMode, prechecked?: Precheck): HandlerResult {
    return this.dispatcher.execute(client, argv, mode, prechecked);
  }

  /** authRequired(): the default user needs a password (or is off) and this client has not authenticated. */
  authRequired(client: Client): boolean {
    return this.access.authRequired(client);
  }

  // ──────────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────────

  /** INFO errorstats / total_error_replies. */
  countError(message: string): void {
    this.observer.countError(message);
  }

  /** CONFIG RESETSTAT. */
  resetStats(): void {
    this.observer.resetStats();
  }

  slowlogReset(): void {
    this.observer.slowlogReset();
  }

  // ──────────────────────────────────────────────
  // ACL
  // ──────────────────────────────────────────────

  /** ACLCheckAllPerm() for argv (argv[0] included); null when allowed, the client is a superuser or the command is unknown. */
  aclDenial(client: Client, argv: string[], meta?: CommandMeta): AclDenial | null {
    return this.access.aclDenial(client, argv, meta);
  }

  aclCheckUser(user: AclUser, argv: string[], meta: CommandMeta): AclDenial | null {
    return this.access.aclCheckUser(user, argv, meta);
  }

  /** ACL LOG context of a client: `multi` while queueing or running a transaction. */
  aclContext(client: Client): AclLogContext {
    return this.access.aclContext(client);
  }

  /** addACLLogEntry(): ACL LOG + INFO acl_access_denied_* counters. */
  aclLog(client: Client, entry: Omit<AclLogInput, 'clientInfo'>): void {
    this.access.aclLog(client, entry);
  }

  aclLogDenial(client: Client, denial: AclDenial, context: AclLogContext): void {
    this.access.aclLogDenial(client, denial, context);
  }

  /** ACLFreeUserAndKillClients(): every connection authenticated as `user` is closed (ACL DELUSER, ACL LOAD). */
  killUserClients(user: AclUser, current: Client | null): void {
    this.access.killUserClients(user, current);
  }

  /** ACLKillPubsubClientsIfNeeded(): subscribers of `user` holding a channel or pattern it may no longer access are closed. */
  killRevokedSubscribers(user: AclUser, current: Client | null): void {
    this.access.killRevokedSubscribers(user, current);
  }

  /** Reads the ACL file; throws AppError with Redis's ACL LOAD error text. Returns the names whose users changed. */
  loadAclFile(path: string, current: Client | null = null): string[] {
    return this.access.loadAclFile(path, current);
  }

  // ──────────────────────────────────────────────
  // Memory
  // ──────────────────────────────────────────────

  /** used_memory and friends (getMemoryOverheadData over the whole dataset); also tracks used_memory_peak. */
  memoryReport(): MemoryReport {
    return this.memoryModel.memoryReport();
  }

  /** used_memory as maxmemory sees it. */
  usedMemoryForEviction(): number {
    return this.memoryModel.usedMemoryForEviction();
  }

  /** A replica with replica-ignore-maxmemory never evicts (EvictionHost). */
  ignoresMaxmemory(): boolean {
    return this.replication.ignoresMaxmemory;
  }

  // ──────────────────────────────────────────────
  // Keyspace
  // ──────────────────────────────────────────────

  /** Marks a key modified: invalidates WATCH and wakes clients blocked on it. */
  touch(dbIndex: number, key: string): void {
    this.keyspace.touch(dbIndex, key);
  }

  /** WATCH: registers `key` of `dbIndex` in the client's watched keys; a later change marks the client dirty. */
  watchKey(client: Client, dbIndex: number, key: string, alive: boolean): void {
    client.watched.add(this.keyspace.watches, dbIndex, key, alive);
  }

  /** EXEC: whether a key WATCHed while it existed has expired since (stored, its expiry time elapsed). */
  watchedKeyExpired(client: Client): boolean {
    const now = Date.now();
    return client.watched.expiredSinceWatch((dbIndex, key) => {
      const db = this.databases[dbIndex];
      const at = db.getExpireRaw(key);
      return at !== undefined && at <= now && db.raw(key) !== undefined;
    });
  }

  /** Evicts one key (maxmemory): delete, propagate DEL / UNLINK, `evicted` event, WATCH and tracking invalidation. */
  evictKey(dbIndex: number, key: string): void {
    this.keyspace.evictKey(dbIndex, key);
  }

  /** Publishes keyspace / keyevent messages for events in database `dbIndex` (an event may name another db). */
  notify(dbIndex: number, events: readonly KeyEvent[]): void {
    this.keyspace.notify(dbIndex, events);
  }

  /** Hash fields expired lazily (hash field TTL): `hexpired`, plus `del` when the hash is gone. */
  fieldsExpired(dbIndex: number, key: string, keyDeleted: boolean): void {
    this.keyspace.fieldsExpired(dbIndex, key, keyDeleted);
  }

  /** FLUSHDB / FLUSHALL: empties the databases (see ServerKeyspace.flushDatabases). */
  flushDatabases(indexes: readonly number[], all: boolean): void {
    this.keyspace.flushDatabases(indexes, all);
  }

  /** Invalidates the WATCHes on existing keys of a database about to be flushed or swapped. */
  signalFlushedDb(dbIndex: number, other?: number): void {
    this.keyspace.signalFlushedDb(dbIndex, other);
  }

  /** SWAPDB: exchanges the contents of two databases, invalidates WATCHes and serves clients blocked on keys that now exist. */
  swapDatabases(a: number, b: number): void {
    this.keyspace.swapDatabases(a, b);
  }

  // ──────────────────────────────────────────────
  // Blocking
  // ──────────────────────────────────────────────

  /** CLIENT UNBLOCK: answers the blocked client with its timeout reply, or an UNBLOCKED error. */
  /** True while a busy script is suspended between slices (background work and CLIENT UNBLOCK must leave it alone). */
  scriptSuspended(): boolean {
    return this.lua?.running?.suspended === true;
  }

  unblockClient(client: Client, withError: boolean): boolean {
    // A client waiting for its own suspended script is not blocked on keys: CLIENT UNBLOCK does not apply (as in Redis).
    if (this.scriptSuspended() && this.lua.running?.client === client) return false;
    return this.blocking.unblockClient(client, withError);
  }

  /** Serves clients blocked on keys that changed, FIFO per key, until nothing more can be served. */
  serveReadyKeys(): void {
    this.blocking.serveReadyKeys();
  }

  // ──────────────────────────────────────────────
  // Pub/Sub
  // ──────────────────────────────────────────────

  subscribe(client: Client, channel: string, pattern: boolean): void {
    this.pubsub.subscribe(client, channel, pattern);
  }

  unsubscribe(client: Client, channel: string, pattern: boolean): void {
    this.pubsub.unsubscribe(client, channel, pattern);
  }

  ssubscribe(client: Client, channel: string): void {
    this.pubsub.ssubscribe(client, channel);
  }

  sunsubscribe(client: Client, channel: string): void {
    this.pubsub.sunsubscribe(client, channel);
  }

  publish(channel: string, message: string): number {
    return this.pubsub.publish(channel, message);
  }

  spublish(channel: string, message: string): number {
    return this.pubsub.spublish(channel, message);
  }
}
