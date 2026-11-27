import MemoryAllocModel from './memory.alloc.model';
import MemoryObjectModel from './memory.object.model';
import MemorySdsModel from './memory.sds.model';
import type {
  ClientMemory,
  ClientMemoryInput,
  DbOverhead,
  DbSizeOptions,
  DbSnapshot,
  LibraryEntry,
  MemoryInput,
  MemoryReport,
  ScriptEntry,
} from './memory.types';

/**
 * getMemoryOverheadData (Redis 7.0): per-database hash-table overhead, client / script / function memory, the dataset
 * and the used_memory report the INFO memory section, MEMORY STATS and maxmemory read.
 *
 * used_memory is modelled as the startup allocation plus what Redis's allocator would hold for the clients, scripts,
 * functions, keyspace dicts and keys; overhead.total + dataset.bytes == total.allocated exactly, and the dataset is
 * what is not overhead (so it does not count the robj that overhead.hashtable.main already charges per key).
 */
export default class MemoryOverheadService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Synthetic defaults for numbers that come from the process/allocator in real Redis. */
  static readonly MEMORY_DEFAULTS = Object.freeze({
    /** used_memory_startup of a fresh Redis 7.0.15 with the default configuration. */
    startup: 876_136,
    /** used_memory_functions with no libraries loaded (function engine and empty dicts). */
    functionsCaches: 200,
    /** Allocator resident memory beyond active pages (jemalloc metadata, dirty pages). */
    allocatorResidentExtra: 2 * 1024 * 1024,
    /** Process RSS beyond allocator resident memory (binary, stacks, Lua heap). */
    rssExtra: 4 * 1024 * 1024,
  });

  /** zmalloc_size(client) and the client's static reply buffer (PROTO_REPLY_CHUNK_BYTES). */
  private static readonly CLIENT_STRUCT = 768;
  private static readonly CLIENT_REPLY_BUFFER = 16 * 1024;
  /** sizeof(multiCmd): argv, argv_len, argc, cmd. */
  private static readonly MULTI_CMD = 24;
  /** sizeof(listNode) of a pattern subscription. */
  private static readonly LIST_NODE = 24;
  /** functions.caches per library (libraryInfo) and per function (dict entries, functionInfo, compiled ref). */
  private static readonly LIBRARY_FIXED = 32;
  private static readonly FUNCTION_FIXED = 80;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** A dict's entries and buckets (sizeof(dictEntry) per entry, a pointer per slot). */
  private static dictOverhead(entries: number, slots: number): number {
    const S = MemoryAllocModel.SIZES;
    return entries * S.dictEntry + slots * S.bucket;
  }

  /** What a string object holding `s` allocates (embstr up to 44 bytes, else robj + sds). */
  private static stringObjectSize(s: string): number {
    const M = MemoryAllocModel;
    return s.length <= MemorySdsModel.EMBSTR_MAX ? M.embstrAllocSize(s.length) : M.SIZES.robj + M.sdsAllocSize(s.length);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Per-db dataset bytes and hash-table overhead, as getMemoryOverheadData computes them. */
  static dbOverhead(db: DbSnapshot, opts: DbSizeOptions = {}): DbOverhead {
    const M = MemoryAllocModel;
    const O = MemoryOverheadService;
    let keys = db.totals?.keys ?? 0;
    let expires = db.totals?.expires ?? 0;
    let dataset = db.totals?.dataset ?? 0;
    for (const r of db.totals ? [] : (db.keys ?? [])) {
      keys++;
      if (r.hasExpire) expires++;
      dataset += MemoryObjectModel.objectSize(r.key, r.value, r.encoding, {
        samples: opts.samples ?? 0,
        hasExpire: r.hasExpire,
        listMaxListpackSize: opts.listMaxListpackSize,
        streamNodeMaxEntries: opts.streamNodeMaxEntries,
        streamNodeMaxBytes: opts.streamNodeMaxBytes,
        allocated: true,
        sharedIntegers: opts.sharedIntegers ?? true,
      });
    }
    const mainSlots = db.mainSlots ?? M.dictBuckets(keys);
    const expiresSlots = db.expiresSlots ?? M.dictBuckets(expires);
    const expiresOverhead = O.dictOverhead(expires, expiresSlots);
    return {
      id: db.id,
      keys,
      expires,
      main: O.dictOverhead(keys, mainSlots) + keys * M.SIZES.robj,
      expiresOverhead,
      // a dictEntry is a 32-byte allocation
      allocated: (keys + expires) * M.jemallocSize(M.SIZES.dictEntry) + (mainSlots + expiresSlots) * M.SIZES.bucket + dataset,
      dataset,
    };
  }

  /** Bytes of all values (objectSize of every key, every element counted) across the given databases. */
  static datasetBytes(databases: Iterable<DbSnapshot>, opts: DbSizeOptions = {}): number {
    let total = 0;
    for (const db of databases) total += MemoryOverheadService.dbOverhead(db, opts).dataset;
    return total;
  }

  /**
   * getClientMemoryUsage: the client struct, its reply buffer and query buffer, the arguments of the running command,
   * the MULTI queue and the pubsub subscriptions.
   */
  static clientMemory(c: ClientMemoryInput = {}): ClientMemory {
    const O = MemoryOverheadService;
    const S = MemoryAllocModel.SIZES;
    const queryBuf = c.queryBuf ?? MemorySdsModel.fresh(0);
    const qbuf = Math.min(c.queryLen ?? 0, queryBuf.cap);
    let argvMem = 0;
    for (const a of c.argv ?? []) argvMem += a.length;
    let multiMem = 0;
    const multi = c.multi ?? [];
    for (const cmd of multi) {
      multiMem += cmd.length * S.bucket;
      for (const a of cmd) multiMem += a.length;
    }
    // the queue array grows by doubling
    const multiSlots = multi.length ? 2 ** Math.ceil(Math.log2(multi.length)) : 0;
    const channels = c.channels ?? 0;
    const shard = c.shardChannels ?? 0;
    const pubsub = O.dictOverhead(channels, MemoryAllocModel.dictBuckets(channels)) + O.dictOverhead(shard, MemoryAllocModel.dictBuckets(shard)) + (c.patterns ?? 0) * O.LIST_NODE;
    const totMem =
      O.CLIENT_STRUCT + (c.replyBuffer ?? O.CLIENT_REPLY_BUFFER) + queryBuf.size + argvMem + (c.argv?.length ?? 0) * S.bucket +
      multiMem + multiSlots * O.MULTI_CMD + pubsub + (c.outputBytes ?? 0);
    return { qbuf, qbufFree: queryBuf.cap - qbuf, argvMem, multiMem, totMem };
  }

  /** lua.caches: the scripts dict (entries, buckets), each script's SHA1 sds and body object. */
  static luaCaches(scripts: Iterable<ScriptEntry>, slots: number): number {
    const O = MemoryOverheadService;
    let n = 0;
    let mem = 0;
    for (const [sha, body] of scripts) {
      n++;
      mem += MemoryAllocModel.sdsAllocSize(sha.length) + O.stringObjectSize(body);
    }
    return mem + O.dictOverhead(n, slots);
  }

  /** functions.caches: the engine baseline, each library (name, code) and function, and the functions dict's buckets. */
  static functionsCaches(libraries: Iterable<LibraryEntry>, slots: number): number {
    const O = MemoryOverheadService;
    const sds = MemoryAllocModel.sdsAllocSize;
    let mem = O.MEMORY_DEFAULTS.functionsCaches + slots * MemoryAllocModel.SIZES.bucket;
    for (const lib of libraries) {
      mem += O.LIBRARY_FIXED + sds(lib.name.length) + MemorySdsModel.fresh(lib.code.length).size;
      for (const f of lib.functions) mem += O.FUNCTION_FIXED + sds(f.length);
    }
    return mem;
  }

  /**
   * getMemoryOverheadData over a dataset: used_memory = startup + client/replication/AOF/script overheads + keyspace
   * dicts and keys, so overhead.total + dataset.bytes == total.allocated exactly. Only databases holding keys are
   * listed (db.N).
   */
  static computeMemory(input: MemoryInput): MemoryReport {
    const D = MemoryOverheadService.MEMORY_DEFAULTS;
    const startup = input.startup ?? D.startup;
    const replicationBacklog = input.replicationBacklog ?? 0;
    const clientsSlaves = input.clientsSlaves ?? 0;
    const clientsNormal = input.clientsNormal ?? 0;
    const clusterLinks = input.clusterLinks ?? 0;
    const aofBuffer = input.aofBuffer ?? 0;
    const luaCaches = input.luaCaches ?? 0;
    const functionsCaches = input.functionsCaches ?? D.functionsCaches;
    const dbs: DbOverhead[] = [];
    let overheadTotal = startup + replicationBacklog + clientsSlaves + clientsNormal + clusterLinks + aofBuffer + luaCaches + functionsCaches;
    let usedMemory = overheadTotal;
    let keysCount = 0;
    for (const db of input.databases) {
      const o = MemoryOverheadService.dbOverhead(db, input.sizes);
      usedMemory += o.allocated;
      if (!o.keys) continue;
      dbs.push(o);
      overheadTotal += o.main + o.expiresOverhead;
      keysCount += o.keys;
    }
    const dataset = usedMemory - overheadTotal;
    const peak = Math.max(input.peak ?? 0, usedMemory);
    const netUsage = usedMemory > startup ? usedMemory - startup : 1;
    const allocatorAllocated = usedMemory;
    const allocatorActive = Math.ceil(allocatorAllocated / 4096) * 4096;
    const allocatorResident = allocatorActive + D.allocatorResidentExtra;
    const rss = input.rss ?? allocatorResident + D.rssExtra;
    return {
      usedMemory,
      peak,
      startup,
      replicationBacklog,
      clientsSlaves,
      clientsNormal,
      clusterLinks,
      aofBuffer,
      luaCaches,
      functionsCaches,
      dbs,
      overheadTotal,
      keysCount,
      bytesPerKey: keysCount ? Math.floor(netUsage / keysCount) : 0,
      dataset,
      datasetPercentage: Math.fround((dataset * 100) / netUsage),
      peakPercentage: Math.fround((usedMemory * 100) / peak),
      allocatorAllocated,
      allocatorActive,
      allocatorResident,
      allocatorMuzzy: 0,
      allocatorFragRatio: Math.fround(allocatorActive / allocatorAllocated),
      allocatorFragBytes: allocatorActive - allocatorAllocated,
      allocatorRssRatio: Math.fround(allocatorResident / allocatorActive),
      allocatorRssBytes: allocatorResident - allocatorActive,
      rss,
      rssOverheadRatio: Math.fround(rss / allocatorResident),
      rssOverheadBytes: rss - allocatorResident,
      fragmentation: Math.fround(rss / usedMemory),
      fragmentationBytes: rss - usedMemory,
      // replica output buffers and the AOF buffer (the replica clients' own structs and query buffers do count)
      notCountedForEvict: (input.replicaOutputBuffers ?? 0) + aofBuffer,
    };
  }

  /** used_memory as maxmemory sees it (freeMemoryGetNotCountedMemory subtracted). */
  static memoryForEviction(report: MemoryReport): number {
    return Math.max(0, report.usedMemory - report.notCountedForEvict);
  }
}
