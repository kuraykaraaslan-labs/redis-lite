import type { Database } from '@/modules/database/database.service';
import type { ServerConfig } from '@/modules/server/server.service';
import type { RedisValue } from '@/modules/database/database.types';

// ============================================================================
// Size model
// ============================================================================

export type SdsType = 5 | 8 | 16 | 32 | 64;

/** One sds allocation: its zmalloc usable size and its capacity (the header's alloc field; = len for sdshdr5). */
export interface SdsAlloc {
  size: number;
  cap: number;
}

/** A string value as the sds helpers read it. */
export type StringValue = Extract<RedisValue, { type: 'string' }>;

export interface QuicklistNodeInfo {
  count: number;
  /** node->sz: listpack bytes (uncompressed). */
  bytes: number;
  /** zmalloc_size of the node's data: the listpack, or the compressed form of an interior node. */
  alloc: number;
  compressed: boolean;
}

/** The ql_* fields DEBUG OBJECT prints for a quicklist-encoded list. */
export interface QuicklistDebugInfo {
  nodes: number;
  avgNode: number;
  listpackMax: number;
  compressed: number;
  uncompressedSize: number;
}

/** The kind of value a dict belongs to (the cost of an insert differs). */
export type DictKind = 'set' | 'hash' | 'zset' | 'keyspace' | 'plain';

/** A value dict's tables: size0 (main), size1 (rehash target, 0 when not rehashing). */
export interface DictTables {
  size0: number;
  size1: number;
}

/** A tracked dict: its tables, the rehash steps left and the entries it holds. */
export interface DictState extends DictTables {
  steps: number;
  used: number;
  /** Steps the running rehash needed in all, the entries it started with, and the entries added since. */
  stepsTotal: number;
  usedAtStart: number;
  added: number;
}

/** What a command's key held before the command ran. */
export interface DictSnapshot {
  container: object | undefined;
  size: number;
  hashtable: boolean;
}

/** One node of the rax shape model (rax.c raxNode). */
export interface RaxNode {
  compr: boolean;
  key: boolean;
  chars: number[];
  children: RaxNode[];
}

// ============================================================================
// MEMORY USAGE
// ============================================================================

export interface MemoryUsageOptions {
  /** MEMORY USAGE SAMPLES: default 5; 0 samples every element. */
  samples: number;
  hasExpire: boolean;
  /** list-max-listpack-size (default -2). */
  listMaxListpackSize?: number;
  /** stream-node-max-entries / stream-node-max-bytes (defaults 100 / 4096). */
  streamNodeMaxEntries?: number;
  streamNodeMaxBytes?: number;
  /** What the allocator holds (used_memory) instead of objectComputeSize's sizeof-based figure. */
  allocated?: boolean;
  /** Integers 0..9999 are shared objects (maxmemory off). */
  sharedIntegers?: boolean;
}

/** The struct sizes objectComputeSize adds (sizeof, or the allocator's size class). */
export interface StructSizes {
  dict: number;
  dictEntry: number;
  quicklist: number;
  quicklistNode: number;
  streamCG: number;
  streamConsumer: number;
  streamNACK: number;
}

// ============================================================================
// Dataset / overhead / MEMORY STATS / INFO memory
// ============================================================================

export interface KeyRecord {
  key: string;
  value: RedisValue;
  encoding: string;
  hasExpire: boolean;
}

export interface DbSnapshot {
  id: number;
  /** The keys to size; ignored when `totals` is given. */
  keys?: Iterable<KeyRecord>;
  /** Already-summed figures (incremental accounting keeps them up to date instead of rescanning the keys). */
  totals?: { keys: number; expires: number; dataset: number };
  /** Bucket slots of the main / expires dicts (both tables while rehashing). Default: settled tables. */
  mainSlots?: number;
  expiresSlots?: number;
}

export interface DbOverhead {
  id: number;
  keys: number;
  expires: number;
  /** overhead.hashtable.main: keys × (sizeof(dictEntry) + sizeof(robj)) + slots × sizeof(dictEntry*). */
  main: number;
  /** overhead.hashtable.expires: expires × sizeof(dictEntry) + slots × sizeof(dictEntry*). */
  expiresOverhead: number;
  /** What the keyspace dicts and the keys allocate: dict entries, buckets, key sds and values. */
  allocated: number;
  /** Sum of objectSize over the db's keys. */
  dataset: number;
}

export interface DbSizeOptions {
  samples?: number;
  /** Integers 0..9999 are shared objects (maxmemory off; default true). */
  sharedIntegers?: boolean;
  listMaxListpackSize?: number;
  streamNodeMaxEntries?: number;
  streamNodeMaxBytes?: number;
}

/** What one normal client holds beyond its struct. */
export interface ClientMemoryInput {
  /** The query buffer's allocation (default: the empty buffer of a client that sent nothing yet). */
  queryBuf?: SdsAlloc;
  /** Bytes in the query buffer not consumed yet (the command being run). */
  queryLen?: number;
  /** The arguments of the command being run. */
  argv?: readonly string[] | null;
  /** Commands queued by MULTI. */
  multi?: readonly (readonly string[])[] | null;
  channels?: number;
  patterns?: number;
  shardChannels?: number;
  /** Size of the static reply buffer (rbs). */
  replyBuffer?: number;
  /** Bytes in the reply list (omem). */
  outputBytes?: number;
}

/** The per-client memory figures CLIENT LIST prints. */
export interface ClientMemory {
  qbuf: number;
  qbufFree: number;
  argvMem: number;
  multiMem: number;
  totMem: number;
}

/** A cached script (lua.caches): its SHA1 and body. */
export type ScriptEntry = [sha: string, body: string];

/** A FUNCTION library as functions.caches counts it. */
export interface LibraryEntry {
  name: string;
  code: string;
  functions: readonly string[];
}

export interface MemoryInput {
  databases: Iterable<DbSnapshot>;
  startup?: number;
  /** Previously recorded used_memory_peak; the result is max(peak, used). */
  peak?: number;
  replicationBacklog?: number;
  clientsSlaves?: number;
  /** Bytes pending in the replicas' output buffers (not counted for maxmemory). */
  replicaOutputBuffers?: number;
  clientsNormal?: number;
  clusterLinks?: number;
  aofBuffer?: number;
  luaCaches?: number;
  functionsCaches?: number;
  /** Real or simulated process RSS; default: allocator resident + MEMORY_DEFAULTS.rssExtra. */
  rss?: number;
  sizes?: DbSizeOptions;
}

export interface MemoryReport {
  usedMemory: number;
  peak: number;
  startup: number;
  replicationBacklog: number;
  clientsSlaves: number;
  clientsNormal: number;
  clusterLinks: number;
  aofBuffer: number;
  luaCaches: number;
  functionsCaches: number;
  dbs: DbOverhead[];
  overheadTotal: number;
  keysCount: number;
  bytesPerKey: number;
  dataset: number;
  /** C float values (Math.fround), as Redis stores them. */
  datasetPercentage: number;
  peakPercentage: number;
  allocatorAllocated: number;
  allocatorActive: number;
  allocatorResident: number;
  allocatorMuzzy: number;
  allocatorFragRatio: number;
  allocatorFragBytes: number;
  allocatorRssRatio: number;
  allocatorRssBytes: number;
  rss: number;
  rssOverheadRatio: number;
  rssOverheadBytes: number;
  fragmentation: number;
  fragmentationBytes: number;
  /** freeMemoryGetNotCountedMemory: replica output buffers + AOF buffer. */
  notCountedForEvict: number;
}

/** A MEMORY STATS value: integer (addReplyLongLong), double (addReplyDouble) or a nested map (db.N). */
export type MemoryStatValue = number | { double: number } | Array<[string, number]>;

export interface InfoMemoryExtras {
  peakTime?: number;
  totalSystemMemory?: number;
  luaVmMemory?: number;
  functionsVmMemory?: number;
  cachedScripts?: number;
  functions?: number;
  libraries?: number;
  maxmemory?: number;
  maxmemoryPolicy?: string;
  allocator?: string;
  lazyfreePendingObjects?: number;
  lazyfreedObjects?: number;
  activeDefragRunning?: number;
  replicationBuffers?: number;
}

// ============================================================================
// Runtime: eviction and incremental accounting
// ============================================================================

/** What the evictor needs from the server. */
export interface EvictionHost {
  readonly databases: readonly Database[];
  readonly config: ServerConfig;
  /** used_memory as maxmemory sees it (memory not counted for eviction already subtracted). */
  usedMemoryForEviction(): number;
  /** Deletes the key and does everything an eviction implies (notification, propagation, invalidation). */
  evictKey(dbIndex: number, key: string): void;
  /** True when this server must not evict (a replica with replica-ignore-maxmemory: the master's DELs evict). */
  ignoresMaxmemory?(): boolean;
  /** True while a busy script is suspended: background work must wait so the script stays atomic. */
  scriptSuspended?(): boolean;
}

/** A key the evictor may pick. */
export interface EvictionCandidate {
  db: number;
  key: string;
  /** Higher = better to evict. */
  score: number;
}

/** Cached key sizes of one database (MemoryTracker). */
export interface DbSizes {
  /** Cached objectSize of every key that is not stale. */
  sizes: Map<string, number>;
  /** Sum of `sizes`. */
  total: number;
  /** Keys changed since they were last sized. */
  stale: Set<string>;
  /** Everything must be re-sized (flush, swap, config change). */
  all: boolean;
}
