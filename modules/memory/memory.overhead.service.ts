import MemoryAllocModel from './memory.alloc.model';
import MemoryObjectModel from './memory.object.model';
import type { ClientMemoryInput, DbOverhead, DbSizeOptions, DbSnapshot, MemoryInput, MemoryReport } from './memory.types';

/**
 * getMemoryOverheadData: per-database hash-table overhead, the dataset, client memory and the used_memory report the
 * INFO memory section, MEMORY STATS and maxmemory read.
 */
export default class MemoryOverheadService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Synthetic defaults for numbers that come from the process/allocator in real Redis. */
  static readonly MEMORY_DEFAULTS = Object.freeze({
    /** used_memory_startup of a fresh server. */
    startup: 900_000,
    /** used_memory_functions with no libraries loaded (function engine dicts). */
    functionsCaches: 184,
    /** Allocator resident memory beyond active pages (jemalloc metadata, dirty pages). */
    allocatorResidentExtra: 2 * 1024 * 1024,
    /** Process RSS beyond allocator resident memory (binary, stacks, Lua heap). */
    rssExtra: 4 * 1024 * 1024,
  });

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** kvstoreMemUsage of a single-dict kvstore (standalone) holding `used` entries. */
  static kvstoreMemUsage(used: number, allocated = used > 0): number {
    return MemoryAllocModel.kvstoreMemUsage(used, allocated);
  }

  /** Per-db dataset bytes and hash-table overhead, as getMemoryOverheadData computes them. */
  static dbOverhead(db: DbSnapshot, opts: DbSizeOptions = {}): DbOverhead {
    const M = MemoryAllocModel;
    let keys = db.totals?.keys ?? 0;
    let expires = db.totals?.expires ?? 0;
    let dataset = db.totals?.dataset ?? 0;
    for (const r of db.totals ? [] : (db.keys ?? [])) {
      keys++;
      if (r.hasExpire) expires++;
      dataset += MemoryObjectModel.objectSize(r.key, r.value, r.encoding, {
        samples: opts.samples ?? 0,
        hasExpire: r.hasExpire,
        fieldTtls: r.fieldTtls,
        listMaxListpackSize: opts.listMaxListpackSize,
        streamNodeMaxEntries: opts.streamNodeMaxEntries,
        streamNodeMaxBytes: opts.streamNodeMaxBytes,
      });
    }
    const allocated = db.allocated ?? keys > 0;
    return {
      id: db.id,
      keys,
      expires,
      main: M.kvstoreMemUsage(keys, allocated) + keys * M.SIZES.robj,
      expiresOverhead: M.kvstoreMemUsage(expires, allocated),
      lut: (M.dictBuckets(keys) + M.dictBuckets(expires)) * M.SIZES.bucket,
      dataset,
    };
  }

  /** Bytes of all values (objectSize of every key, every element counted) across the given databases. */
  static datasetBytes(databases: Iterable<DbSnapshot>, opts: DbSizeOptions = {}): number {
    let total = 0;
    for (const db of databases) total += MemoryOverheadService.dbOverhead(db, opts).dataset;
    return total;
  }

  /** Memory of one normal client: zmalloc'd client struct + reply buffer + query buffer + argv. */
  static clientMemory(opts: ClientMemoryInput = {}): number {
    const S = MemoryAllocModel.SIZES;
    return S.client + (opts.replyBuffer ?? S.clientReplyBuffer) + (opts.queryBuffer ?? 0) + (opts.argvBytes ?? 0) + (opts.outputBytes ?? 0);
  }

  /**
   * getMemoryOverheadData over a dataset: used_memory = startup + client/replication/AOF/script overheads + keyspace
   * hash tables + dataset, so overhead.total + dataset.bytes == total.allocated exactly.
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
    let keysCount = 0;
    let dataset = 0;
    let hashtableLut = 0;
    for (const db of input.databases) {
      const o = MemoryOverheadService.dbOverhead(db, input.sizes);
      if (!(db.allocated ?? o.keys > 0)) continue;
      dbs.push(o);
      overheadTotal += o.main + o.expiresOverhead;
      keysCount += o.keys;
      dataset += o.dataset;
      hashtableLut += o.lut;
    }
    const usedMemory = overheadTotal + dataset;
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
      hashtableLut,
      hashtableRehashing: 0,
      dictRehashingCount: 0,
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
      notCountedForEvict: clientsSlaves + aofBuffer,
    };
  }

  /** used_memory as maxmemory sees it (freeMemoryGetNotCountedMemory subtracted). */
  static memoryForEviction(report: MemoryReport): number {
    return Math.max(0, report.usedMemory - report.notCountedForEvict);
  }
}
