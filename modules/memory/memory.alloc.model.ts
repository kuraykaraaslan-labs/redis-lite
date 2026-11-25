import type { ListpackEntry } from '@/modules/persistence/persistence.types';

import type { SdsType } from './memory.types';

/**
 * Allocation model of Redis 8 on 64-bit Linux with jemalloc: struct sizes, jemalloc usable sizes, sds / mstr headers,
 * the kvobj (key + value object) and dict helpers. A clean-room model of object.c objectComputeSize /
 * getMemoryOverheadData; struct sizes live in `SIZES` so they can be calibrated in one place.
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
    /** kvobj expire slot (long long), present when the key has a TTL. */
    kvobjExpire: 8,
    /** kvobj byte that stores the embedded key's sds header size. */
    kvobjKeyHdrLen: 1,
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
    /** sizeof(listpackEx): ExpireMeta (16), key, lp. */
    listpackEx: 32,
    /** ExpireMeta attached to a hash field that has a TTL (HT encoding). */
    hfieldExpireMeta: 16,
    /** sizeof(stream): rax, length, last_id, first_id, max_deleted_entry_id, entries_added, cgroups, cgroups_ref. */
    stream: 88,
    /** sizeof(streamCG): last_id, entries_read, pel, consumers. */
    streamCG: 40,
    /** sizeof(streamConsumer): seen_time, active_time, name, pel. */
    streamConsumer: 32,
    /** sizeof(streamNACK): delivery_time, delivery_count, consumer. */
    streamNACK: 24,
    streamID: 16,
    /** sizeof(raxNode) header (iskey/isnull/iscompr/size bitfields). */
    raxNode: 4,
    /** Fixed per-node overhead streamRadixTreeMemoryUsage adds: sizeof(long) * 30. */
    raxNodeExtra: 8 * 30,
    /** STREAM_LISTPACK_MAX_PRE_ALLOCATE: a new stream node's listpack is preallocated to this (or node-max-bytes). */
    streamPrealloc: 4096,
    /** sizeof(kvstore) (flags, embedded dictType, dicts, counters, rehashing list, size index, overhead counters). */
    kvstore: 208,
    /** Per-dict kvstore metadata (rehashing list node pointer). */
    kvstoreDictMeta: 8,
    /** PROTO_MBULK_BIG_ARG: bulk arguments this large become the query buffer itself (bulklen + 2 bytes). */
    bigArg: 32 * 1024,
    /** zmalloc'd sizeof(client) (rounded). */
    client: 2048,
    /** Initial dynamic reply buffer (PROTO_REPLY_MIN_BYTES). */
    clientReplyBuffer: 1024,
  });

  private static readonly SDS_HDR: Readonly<Record<SdsType, number>> = { 5: 1, 8: 3, 16: 5, 32: 9, 64: 17 };

  /** (double)(LLONG_MAX / 2): the range in which double2ll accepts a score. */
  private static readonly DOUBLE2LL_LIMIT = 4611686018427387904;

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

  /** mstr (hash field, Redis 7.4+) header bytes: hdr5 = 1, hdr8 = 2, hdr16 = 3, hdr32 = 5, hdr64 = 9. */
  private static mstrHdrSize(len: number): number {
    if (len < 32) return 1;
    if (len < 256) return 2;
    if (len < 65536) return 3;
    if (len < 2 ** 32) return 5;
    return 9;
  }

  /** Bytes the embedded key takes inside the kvobj: 1 byte header size + sds header + key + NUL. */
  private static embeddedKeyBytes(key: string): number {
    const M = MemoryAllocModel;
    return M.SIZES.kvobjKeyHdrLen + M.SDS_HDR[M.sdsNewType(key.length)] + key.length + 1;
  }

  /** fpconv_dtoa (d2string for non-integral doubles): shortest round-trip digits with Redis's notation. */
  private static fpconvDtoa(value: number): string {
    const neg = value < 0;
    const [mant, expStr] = Math.abs(value).toExponential().split('e');
    let digits = mant.replace('.', '');
    const E = Number(expStr);
    let ndigits = digits.length;
    const K = E - (ndigits - 1);
    let exp = Math.abs(K + ndigits - 1);
    let out = neg ? '-' : '';
    if (K >= 0 && exp < ndigits + 7) return out + digits + '0'.repeat(K);
    if (K < 0 && (K > -7 || exp < 4)) {
      const offset = ndigits - Math.abs(K);
      if (offset <= 0) return `${out}0.${'0'.repeat(-offset)}${digits}`;
      return `${out}${digits.slice(0, offset)}.${digits.slice(offset)}`;
    }
    ndigits = Math.min(ndigits, 18 - (neg ? 1 : 0));
    digits = digits.slice(0, ndigits);
    out += digits[0];
    if (ndigits > 1) out += `.${digits.slice(1)}`;
    out += 'e';
    out += K + ndigits - 1 < 0 ? '-' : '+';
    let cent = 0;
    if (exp > 99) {
      cent = Math.floor(exp / 100);
      out += String(cent);
      exp -= cent * 100;
    }
    if (exp > 9) {
      const dec = Math.floor(exp / 10);
      out += String(dec);
      exp -= dec * 10;
    } else if (cent) out += '0';
    return out + String(exp % 10);
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

  /** hfieldZmallocSize: a hash field of an HT-encoded hash, with its ExpireMeta when it has a TTL. */
  static hfieldAllocSize(len: number, hasTtl: boolean): number {
    const M = MemoryAllocModel;
    return M.jemallocSize((hasTtl ? M.SIZES.hfieldExpireMeta : 0) + M.mstrHdrSize(len) + len + 1);
  }

  // ──────────────────────────────────────────────
  // Public Methods: kvobj (Redis 8 key + value object)
  // ──────────────────────────────────────────────

  /**
   * Bytes a key adds to its kvobj before jemalloc rounding: the embedded key (+ the 8-byte expire slot when the key
   * has a TTL). The keyspace dict entry (`SIZES.dictEntryNoValue`) comes on top of this.
   */
  static keyOverhead(key: string, hasExpire = false): number {
    return MemoryAllocModel.embeddedKeyBytes(key) + (hasExpire ? MemoryAllocModel.SIZES.kvobjExpire : 0);
  }

  /** zmalloc_size of a kvobj: robj + [expire] + embedded key + [embstr value: sdshdr8 + bytes + NUL]. */
  static kvobjAllocSize(key: string, hasExpire: boolean, embeddedValueLen?: number): number {
    const M = MemoryAllocModel;
    let n = M.SIZES.robj + M.keyOverhead(key, hasExpire);
    if (embeddedValueLen !== undefined) n += M.SDS_HDR[8] + embeddedValueLen + 1;
    return M.jemallocSize(n);
  }

  /**
   * Allocation of a raw string value as SET leaves it. Arguments of PROTO_MBULK_BIG_ARG bytes or more are the query
   * buffer itself (sized bulklen + 2); tryObjectEncoding trims it only when the free space exceeds len / 10.
   */
  static rawStringAlloc(len: number, fromBigArg: boolean): number {
    const M = MemoryAllocModel;
    if (!fromBigArg || len < M.SIZES.bigArg) return M.sdsAllocSize(len);
    const hdr = M.SDS_HDR[M.sdsReqType(len + 2)];
    const alloc = M.jemallocSize(hdr + len + 3);
    if (alloc - hdr - 1 - len > len / 10) return M.sdsAllocSize(len);
    return alloc;
  }

  // ──────────────────────────────────────────────
  // Public Methods: listpack / intset / dict helpers
  // ──────────────────────────────────────────────

  /** The listpack element zzlInsertAt stores for a score (integer when double2ll succeeds, else d2string text). */
  static scoreEntry(score: number): ListpackEntry {
    if (Number.isFinite(score) && Math.abs(score) <= MemoryAllocModel.DOUBLE2LL_LIMIT && Number.isInteger(score)) {
      return Object.is(score, -0) ? '-0' : BigInt(score);
    }
    if (Number.isNaN(score)) return 'nan';
    if (score === Infinity) return 'inf';
    if (score === -Infinity) return '-inf';
    return MemoryAllocModel.fpconvDtoa(score);
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

  /** kvstoreMemUsage of a single-dict kvstore (standalone) holding `used` entries. */
  static kvstoreMemUsage(used: number, allocated = used > 0): number {
    const S = MemoryAllocModel.SIZES;
    let mem = S.kvstore + used * S.dictEntryNoValue + MemoryAllocModel.dictBuckets(used) * S.bucket;
    if (allocated) mem += S.dict + S.kvstoreDictMeta;
    return mem;
  }
}
