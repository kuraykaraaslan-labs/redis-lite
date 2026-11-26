import type { Database } from '@/modules/database/database.service';
import type { ServerConfig } from '@/modules/server/server.service';
import type { RedisValue } from '@/modules/database/database.types';

// ============================================================================
// Size model
// ============================================================================

export type SdsType = 5 | 8 | 16 | 32 | 64;

export interface QuicklistNodeInfo {
  /** PLAIN node (one large element stored as a raw buffer) vs PACKED (listpack). */
  plain: boolean;
  count: number;
  /** node->sz: listpack bytes, or the element length for a plain node. */
  bytes: number;
}

/** The ql_* fields DEBUG OBJECT prints for a quicklist-encoded list. */
export interface QuicklistDebugInfo {
  nodes: number;
  avgNode: number;
  listpackMax: number;
  compressed: number;
  uncompressedSize: number;
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

/** Hash fields with a TTL: their names, or just how many (enough for listpackex; HT then assumes the first N). */
export type FieldTtls = number | ReadonlySet<string> | ReadonlyMap<string, number>;

export interface MemoryUsageOptions {
  /** MEMORY USAGE SAMPLES: default 5; 0 samples every element. */
  samples: number;
  hasExpire: boolean;
  fieldTtls?: FieldTtls;
  /** list-max-listpack-size (default -2). */
  listMaxListpackSize?: number;
  /** stream-node-max-entries / stream-node-max-bytes (defaults 100 / 4096). */
  streamNodeMaxEntries?: number;
  streamNodeMaxBytes?: number;
}

// ============================================================================
// Dataset / overhead / MEMORY STATS / INFO memory
// ============================================================================

export interface KeyRecord {
  key: string;
  value: RedisValue;
  encoding: string;
  hasExpire: boolean;
  fieldTtls?: FieldTtls;
}

export interface DbSnapshot {
  id: number;
  /** The keys to size; ignored when `totals` is given. */
  keys?: Iterable<KeyRecord>;
  /** Already-summed figures (incremental accounting keeps them up to date instead of rescanning the keys). */
  totals?: { keys: number; expires: number; dataset: number };
  /**
   * Whether the db's dicts are allocated. Standalone Redis allocates a db's dicts on first use and keeps them after
   * the db empties (shown in MEMORY STATS as db.N). Default: the db has keys.
   */
  allocated?: boolean;
}

export interface DbOverhead {
  id: number;
  keys: number;
  expires: number;
  /** overhead.hashtable.main: kvstoreMemUsage(keys) + keys × sizeof(robj). */
  main: number;
  /** overhead.hashtable.expires: kvstoreMemUsage(expires). */
  expiresOverhead: number;
  /** Bucket arrays of both dicts (overhead.db.hashtable.lut contribution). */
  lut: number;
  /** Sum of objectSize over the db's keys. */
  dataset: number;
}

export interface DbSizeOptions {
  samples?: number;
  listMaxListpackSize?: number;
  streamNodeMaxEntries?: number;
  streamNodeMaxBytes?: number;
}

/** What one normal client holds beyond its struct. */
export interface ClientMemoryInput {
  replyBuffer?: number;
  queryBuffer?: number;
  argvBytes?: number;
  outputBytes?: number;
}

export interface MemoryInput {
  databases: Iterable<DbSnapshot>;
  startup?: number;
  /** Previously recorded used_memory_peak; the result is max(peak, used). */
  peak?: number;
  replicationBacklog?: number;
  clientsSlaves?: number;
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
  hashtableLut: number;
  hashtableRehashing: number;
  dictRehashingCount: number;
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
