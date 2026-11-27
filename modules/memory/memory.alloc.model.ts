import { formatFloat } from '@/libs/number';

import type { ListpackEntry } from '@/modules/persistence/persistence.types';

import type { SdsType } from './memory.types';

/**
 * Allocation model of Redis 7.0 on 64-bit Linux with jemalloc: struct sizes, jemalloc usable sizes, sds headers, the
 * key sds + robj of a key, and dict helpers. A clean-room model of objectComputeSize / getMemoryOverheadData; struct sizes live in `SIZES` so they can be calibrated in one place.
 *
 * Models are the building blocks of the memory services (sub-services never import each other, so what several of
 * them need lives in a model). All strings are binary strings (one char per byte), so `.length` is the byte length.
 */
export default class MemoryAllocModel {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  static readonly SIZES = Object.freeze({
    /** sizeof(robj): type/encoding/lru bitfields + refcount (8) + ptr (8). */
    robj: 16,
    /** sizeof(dict) (type, ht_table[2], ht_used[2], rehashidx, pauserehash/flags/ht_size_exp/pauseAutoResize). */
    dict: 56,
    /** sizeof(dictEntry): key, value union, next. */
    dictEntry: 24,
    /** sizeof(dictEntryNoValue): key, next. Used by the keyspace dicts and set dicts. */
    dictEntryNoValue: 16,
    /** One hash-table bucket (dictEntry*). */
    bucket: 8,
    /** sizeof(quicklist): head, tail, count, len, fill/compress/bookmark bitfields. */
    quicklist: 40,
    /** sizeof(quicklistNode): prev, next, entry, sz (size_t), 32 bits of bitfields, padded. */
    quicklistNode: 40,
    /** sizeof(zset): dict*, zsl*. */
    zset: 16,
    /** sizeof(zskiplist): header, tail, length, level. */
    zskiplist: 32,
    /** zskiplistNode without levels: ele, score, backward. */
    zskiplistNode: 24,
    /** One zskiplistLevel: forward, span. */
    zskiplistLevel: 16,
    zskiplistMaxLevel: 32,
    zskiplistP: 0.25,
    /** sizeof(stream): rax, length, last_id, first_id, max_deleted_entry_id, entries_added, cgroups. */
    stream: 80,
    /** sizeof(streamCG): last_id, entries_read, pel, consumers. */
    streamCG: 40,
    /** sizeof(streamConsumer): seen_time, name, pel. */
    streamConsumer: 24,
    /** sizeof(streamNACK): delivery_time, delivery_count, consumer. */
    streamNACK: 24,
    streamID: 16,
    /** sizeof(raxNode) header (iskey/isnull/iscompr/size bitfields). */
    raxNode: 4,
    /** Fixed per-node overhead streamRadixTreeMemoryUsage adds: sizeof(long) * 30. */
    raxNodeExtra: 8 * 30,
    /** STREAM_LISTPACK_MAX_PRE_ALLOCATE: a new stream node's listpack is preallocated to this (or node-max-bytes). */
    streamPrealloc: 4096,
    /** PROTO_MBULK_BIG_ARG: bulk arguments this large become the query buffer itself (bulklen + 2 bytes). */
    bigArg: 32 * 1024,
  });

  private static readonly SDS_HDR: Readonly<Record<SdsType, number>> = { 5: 1, 8: 3, 16: 5, 32: 9, 64: 17 };

  /** Expected zmalloc_size of a skiplist node (random level, P = 0.25, capped at 32 levels). */
  static readonly EXPECTED_ZSL_NODE: number = (() => {
    const S = MemoryAllocModel.SIZES;
    let total = 0;
    let p = 1;
    for (let level = 1; level <= S.zskiplistMaxLevel; level++) {
      const prob = level === S.zskiplistMaxLevel ? p : p * (1 - S.zskiplistP);
      total += prob * MemoryAllocModel.jemallocSize(S.zskiplistNode + S.zskiplistLevel * level);
      p *= S.zskiplistP;
    }
    return total;
  })();

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Type sdsnewlen picks: sdsReqType, but never sdshdr5 for an empty string (it is likely to be appended to). */
  private static sdsNewType(len: number): SdsType {
    const t = MemoryAllocModel.sdsReqType(len);
    return t === 5 && len === 0 ? 8 : t;
  }

  // ──────────────────────────────────────────────
  // Public Methods: jemalloc, sds
  // ──────────────────────────────────────────────

  /**
   * Usable size jemalloc returns for a request of `n` bytes (default size classes, 16-byte quantum, 4 KB pages):
   * 8, 16, 32, 48, …, 128 (step 16), then four classes per doubling: (2^k, 2^(k+1)] in steps of 2^(k-2)
   * (160, 192, 224, 256, 320, …, 4096, 5120, …). Large classes keep the same spacing.
   */
  static jemallocSize(n: number): number {
    if (n <= 8) return 8;
    if (n <= 128) return Math.ceil(n / 16) * 16;
    let p = 128;
    while (p * 2 < n) p *= 2;
    const step = p / 4;
    return Math.ceil(n / step) * step;
  }

  /** sdsReqType (Redis 7+): smallest header able to hold `len` (and its usable-size alloc field). */
  static sdsReqType(len: number): SdsType {
    if (len < 32) return 5;
    if (len <= 256 - 3 - 1) return 8;
    if (len <= 65536 - 5 - 1) return 16;
    if (len <= 2 ** 32 - 9 - 1) return 32;
    return 64;
  }

  static sdsHdrSize(type: SdsType): number {
    return MemoryAllocModel.SDS_HDR[type];
  }

  /** sdsZmallocSize of an sds created with sdsnewlen(len) (or with an explicit header type). */
  static sdsAllocSize(len: number, type: SdsType = MemoryAllocModel.sdsNewType(len)): number {
    return MemoryAllocModel.jemallocSize(MemoryAllocModel.SDS_HDR[type] + len + 1);
  }

  // ──────────────────────────────────────────────
  // Public Methods: keys and string objects (Redis 7.0: key sds + robj)
  // ──────────────────────────────────────────────

  /** sdsZmallocSize of a key as the keyspace stores it (a copy made with sdsnewlen). */
  static keyAllocSize(key: string): number {
    return MemoryAllocModel.sdsAllocSize(key.length);
  }

  /** zmalloc_size of an embstr object: robj and sdshdr8 + bytes + NUL in one allocation. */
  static embstrAllocSize(len: number): number {
    const M = MemoryAllocModel;
    return M.jemallocSize(M.SIZES.robj + M.SDS_HDR[8] + len + 1);
  }

  // ──────────────────────────────────────────────
  // Public Methods: listpack / intset / dict helpers
  // ──────────────────────────────────────────────

  /** The listpack element a sorted set stores for a score (Redis 7.0): an integer within ±2^62, else `%.17g` text. */
  static scoreEntry(score: number): ListpackEntry {
    const text = formatFloat(score);
    return Number.isInteger(score) && /^-?\d+$/.test(text) ? BigInt(text) : text;
  }

  /** Bytes of an intset holding these canonical-integer members: 8-byte header + count × common width. */
  static intsetBytes(members: Iterable<string>): number {
    let width = 2;
    let n = 0;
    for (const m of members) {
      n++;
      const v = BigInt(m);
      if (v < -32768n || v > 32767n) width = Math.max(width, v < -2147483648n || v > 2147483647n ? 8 : 4);
    }
    return 8 + n * width;
  }

  /** Buckets of a dict that grew one insert at a time to `used` entries: 0, or max(4, next power of two ≥ used). */
  static dictBuckets(used: number): number {
    if (used <= 0) return 0;
    let size = 4;
    while (size < used) size *= 2;
    return size;
  }
}
