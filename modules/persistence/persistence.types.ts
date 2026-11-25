import type { LogContext, LogLevelName } from '@/libs/logger';
import type { Reply } from '@/libs/resp';

import type { Database } from '@/modules/database/database.service';
import type { LuaEngine } from '@/modules/scripting/scripting.service';
import type { Client, ServerConfig } from '@/modules/server/server.service';
import type { RedisValue } from '@/modules/database/database.types';

import type { AofFileType, LoadSource, PropagationTarget } from './persistence.enums';

// ============================================================================
// RDB format
// ============================================================================

/** Encoding thresholds (Redis CONFIG names in comments). Defaults are Redis's defaults. */
export interface RdbOptions {
  hashMaxListpackEntries: number; // hash-max-listpack-entries
  hashMaxListpackValue: number; // hash-max-listpack-value
  setMaxIntsetEntries: number; // set-max-intset-entries
  setMaxListpackEntries: number; // set-max-listpack-entries
  setMaxListpackValue: number; // set-max-listpack-value
  zsetMaxListpackEntries: number; // zset-max-listpack-entries
  zsetMaxListpackValue: number; // zset-max-listpack-value
  listMaxListpackSize: number; // list-max-listpack-size
  streamNodeMaxEntries: number; // stream-node-max-entries
  streamNodeMaxBytes: number; // stream-node-max-bytes
  rdbCompression: boolean; // rdbcompression
  rdbChecksum: boolean; // rdbchecksum (RDB files only; DUMP always carries a CRC)
}

/** A listpack element: strings that look like canonical int64s are stored as integers (lpAppend). */
export type ListpackEntry = string | number | bigint;

/** Field TTLs (absolute ms) for hashes using Redis 7.4+ hash field expiration. */
export type FieldExpires = Map<string, number>;

export interface EncodedObject {
  type: number;
  body: Buffer;
}

export interface DecodedObject {
  value: RedisValue;
  /** Absolute ms field TTLs for hashes saved with field expiration (types 22-25). */
  fieldExpires?: FieldExpires;
}

/** One key in an RDB database. `expireAt` and field TTLs are absolute unix ms. */
export interface RdbKeyEntry {
  value: RedisValue;
  expireAt?: number;
  fieldExpires?: FieldExpires;
  /** LRU idle seconds (RDB_OPCODE_IDLE), only written when set. */
  idle?: number;
  /** LFU counter (RDB_OPCODE_FREQ), only written when set. */
  freq?: number;
}

/** key → entry, in the order keys should be written. */
export type RdbDatabase = Map<string, RdbKeyEntry>;

/** AUX fields in write order; numbers use Redis's integer string encoding. */
export type RdbAux = Array<[string, string | number]>;

export interface RdbFile {
  version: number;
  aux: Map<string, string>;
  /** Library source code of each FUNCTION2 record, in file order. */
  functions: string[];
  /** Index = db number; databases absent from the file are empty maps. */
  dbs: RdbDatabase[];
}

export interface RdbAuxInput {
  redisVer?: string;
  ctime?: number; // unix seconds
  usedMem?: number;
  aofBase?: boolean;
}

// ============================================================================
// AOF
// ============================================================================

/** One manifest line: `file <name> seq <n> type <b|h|i>`. */
export interface AofInfo {
  name: string;
  seq: number;
  type: AofFileType;
}

export interface AofManifest {
  base: AofInfo | null;
  incr: AofInfo[];
  history: AofInfo[];
  /** Highest base / incr sequence used so far. */
  baseSeq: number;
  incrSeq: number;
}

export type AofParseStep = { argv: string[]; next: number } | { incomplete: true } | { error: string };

/** The dataset as RDB entries plus the FUNCTION libraries (input of an RDB file or a command-form base AOF). */
export interface Snapshot {
  dbs: RdbDatabase[];
  functions: string[];
}

// ============================================================================
// Persistence runtime
// ============================================================================

/** What Persistence needs from the server. RedisLiteServer satisfies it structurally. */
export interface PersistenceHost {
  readonly databases: Database[];
  readonly config: ServerConfig;
  /** Needed to save / load FUNCTION libraries; undefined before the engine is created. */
  readonly lua?: LuaEngine;
  execute(client: Client, argv: string[], mode: { inScript: boolean; noBlock: boolean }): unknown;
  createInternalClient(): Client;
  log(level: LogLevelName, message: string, context?: LogContext): void;
  /** Invalidates WATCHes on a database about to be emptied (DEBUG RELOAD / LOADAOF). */
  signalFlushedDb?(dbIndex: number): void;
}

export interface LoadResult {
  source: LoadSource;
  keysLoaded: number;
  keysExpired: number;
}

export type LoadedKeys = { keysLoaded: number; keysExpired: number };

/** A background save in flight (the fork's stand-in). */
export interface BgsaveJob {
  startedAt: number;
  cancelled: boolean;
  tmp: string;
  done: Promise<void>;
}

// ============================================================================
// Propagation
// ============================================================================

/** One propagated command. `db` is the database it runs in; -1 for MULTI / EXEC (no SELECT is emitted for them). */
export interface PropagatedOp {
  db: number;
  argv: string[];
  target: PropagationTarget;
}

/** The keyspace a rewrite reads (after the command ran). */
export type KeyspaceView = Pick<Database, 'peek' | 'getExpire'>;

export interface PropagateContext {
  /** Database the command ran in. */
  db: number;
  /** That database, after the command ran. */
  database: KeyspaceView;
  /** lazyfree-lazy-expire: deletions caused by an expire in the past propagate as UNLINK instead of DEL. */
  lazyfreeLazyExpire?: boolean;
  /** lazyfree-lazy-server-del: server-side deletions (SPOP of a whole set, RESTORE with a past TTL) propagate as UNLINK. */
  lazyfreeLazyServerDel?: boolean;
  /**
   * Keys on which XREADGROUP created the reading consumer (Redis propagates XGROUP CREATECONSUMER first).
   * The post-command state cannot tell, so the stream code has to report it.
   */
  createdConsumerKeys?: readonly string[];
}

/** A propagation rule: the ops one executed command turns into. */
export type PropagationRule = (argv: readonly string[], reply: Reply, ctx: PropagateContext) => PropagatedOp[];

/** Receives each finished unit's ops (already wrapped in MULTI/EXEC when needed). Filter on `target`. */
export type PropagationSink = (ops: readonly PropagatedOp[]) => void;

export interface PropagatorOptions {
  /** The server's databases (read after a command ran, to compute absolute expires etc.). */
  databases: readonly KeyspaceView[];
  /** Live config: lazyfree-lazy-expire, lazyfree-lazy-server-del. */
  config: { get(name: string): string | undefined };
}

/** Extra facts a command reports that the post-command keyspace cannot tell. */
export interface RecordHints {
  createdConsumerKeys?: readonly string[];
}
