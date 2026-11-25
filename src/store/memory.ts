import type { RedisValue } from './database';
import { encodeObject, listpackBytes } from './rdb';
import type { FieldExpires, ListpackEntry, RdbOptions } from './rdb';
import { Stream, compareIds } from './stream';
import type { ConsumerGroup, PendingEntry, StreamId } from './stream';
import type { ZSet } from './zset';

/**
 * Redis-style memory accounting (clean-room model of Redis 8 on 64-bit Linux with jemalloc).
 *
 * Numbers follow object.c objectComputeSize / memoryCommand / getMemoryOverheadData: the same encodings, the same
 * struct sizes, sampling rule and jemalloc usable sizes (je_malloc_usable_size). Redis 8 stores the key inside the
 * value object (kvobj: robj + optional expire + embedded key sds [+ embedded embstr value]); the keyspace dicts are
 * no-value dicts whose entries are 16 bytes. Struct sizes live in `SIZES` so they can be calibrated in one place.
 *
 * All strings are binary strings (one char per byte), so `.length` is the byte length.
 */

// ---- struct sizes ------------------------------------------------------------------------------------------------

export const SIZES = Object.freeze({
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

// ---- jemalloc ----------------------------------------------------------------------------------------------------

/**
 * Usable size jemalloc returns for a request of `n` bytes (default size classes, 16-byte quantum, 4 KB pages):
 * 8, 16, 32, 48, …, 128 (step 16), then four classes per doubling: (2^k, 2^(k+1)] in steps of 2^(k-2)
 * (160, 192, 224, 256, 320, …, 4096, 5120, …). Large classes keep the same spacing.
 */
export function jemallocSize(n: number): number {
  if (n <= 8) return 8;
  if (n <= 128) return Math.ceil(n / 16) * 16;
  let p = 128;
  while (p * 2 < n) p *= 2;
  const step = p / 4;
  return Math.ceil(n / step) * step;
}

// ---- sds ---------------------------------------------------------------------------------------------------------

export type SdsType = 5 | 8 | 16 | 32 | 64;

const SDS_HDR: Record<SdsType, number> = { 5: 1, 8: 3, 16: 5, 32: 9, 64: 17 };

/** sdsReqType (Redis 7+): smallest header able to hold `len` (and its usable-size alloc field). */
export function sdsReqType(len: number): SdsType {
  if (len < 32) return 5;
  if (len <= 256 - 3 - 1) return 8;
  if (len <= 65536 - 5 - 1) return 16;
  if (len <= 2 ** 32 - 9 - 1) return 32;
  return 64;
}

export function sdsHdrSize(type: SdsType): number {
  return SDS_HDR[type];
}

/** Type sdsnewlen picks: sdsReqType, but never sdshdr5 for an empty string (it is likely to be appended to). */
function sdsNewType(len: number): SdsType {
  const t = sdsReqType(len);
  return t === 5 && len === 0 ? 8 : t;
}

/** sdsZmallocSize of an sds created with sdsnewlen(len) (or with an explicit header type). */
export function sdsAllocSize(len: number, type: SdsType = sdsNewType(len)): number {
  return jemallocSize(SDS_HDR[type] + len + 1);
}

/** mstr (hash field, Redis 7.4+) header bytes: hdr5 = 1, hdr8 = 2, hdr16 = 3, hdr32 = 5, hdr64 = 9. */
function mstrHdrSize(len: number): number {
  if (len < 32) return 1;
  if (len < 256) return 2;
  if (len < 65536) return 3;
  if (len < 2 ** 32) return 5;
  return 9;
}

/** hfieldZmallocSize: a hash field of an HT-encoded hash, with its ExpireMeta when it has a TTL. */
export function hfieldAllocSize(len: number, hasTtl: boolean): number {
  return jemallocSize((hasTtl ? SIZES.hfieldExpireMeta : 0) + mstrHdrSize(len) + len + 1);
}

// ---- kvobj (Redis 8 key + value object) --------------------------------------------------------------------------

/** Bytes the embedded key takes inside the kvobj: 1 byte header size + sds header + key + NUL. */
function embeddedKeyBytes(key: string): number {
  return SIZES.kvobjKeyHdrLen + SDS_HDR[sdsNewType(key.length)] + key.length + 1;
}

/**
 * Bytes a key adds to its kvobj before jemalloc rounding: the embedded key (+ the 8-byte expire slot when the key
 * has a TTL). The keyspace dict entry (`SIZES.dictEntryNoValue`) comes on top of this.
 */
export function keyOverhead(key: string, hasExpire = false): number {
  return embeddedKeyBytes(key) + (hasExpire ? SIZES.kvobjExpire : 0);
}

/** zmalloc_size of a kvobj: robj + [expire] + embedded key + [embstr value: sdshdr8 + bytes + NUL]. */
export function kvobjAllocSize(key: string, hasExpire: boolean, embeddedValueLen?: number): number {
  let n = SIZES.robj + keyOverhead(key, hasExpire);
  if (embeddedValueLen !== undefined) n += SDS_HDR[8] + embeddedValueLen + 1;
  return jemallocSize(n);
}

/**
 * Allocation of a raw string value as SET leaves it. Arguments of PROTO_MBULK_BIG_ARG bytes or more are the query
 * buffer itself (sized bulklen + 2); tryObjectEncoding trims it only when the free space exceeds len / 10.
 */
function rawStringAlloc(len: number, fromBigArg: boolean): number {
  if (!fromBigArg || len < SIZES.bigArg) return sdsAllocSize(len);
  const hdr = SDS_HDR[sdsReqType(len + 2)];
  const alloc = jemallocSize(hdr + len + 3);
  if (alloc - hdr - 1 - len > len / 10) return sdsAllocSize(len);
  return alloc;
}

// ---- listpack / intset / dict helpers ----------------------------------------------------------------------------

const DOUBLE2LL_LIMIT = 4611686018427387904;

/** fpconv_dtoa (d2string for non-integral doubles): shortest round-trip digits with Redis's notation. */
function fpconvDtoa(value: number): string {
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

/** The listpack element zzlInsertAt stores for a score (integer when double2ll succeeds, else d2string text). */
function scoreEntry(score: number): ListpackEntry {
  if (Number.isFinite(score) && Math.abs(score) <= DOUBLE2LL_LIMIT && Number.isInteger(score)) {
    return Object.is(score, -0) ? '-0' : BigInt(score);
  }
  if (Number.isNaN(score)) return 'nan';
  if (score === Infinity) return 'inf';
  if (score === -Infinity) return '-inf';
  return fpconvDtoa(score);
}

/** Bytes of an intset holding these canonical-integer members: 8-byte header + count × common width. */
export function intsetBytes(members: Iterable<string>): number {
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
export function dictBuckets(used: number): number {
  if (used <= 0) return 0;
  let size = 4;
  while (size < used) size *= 2;
  return size;
}

/** Expected zmalloc_size of a skiplist node (random level, P = 0.25, capped at 32 levels). */
const EXPECTED_ZSL_NODE: number = (() => {
  let total = 0;
  let p = 1;
  for (let level = 1; level <= SIZES.zskiplistMaxLevel; level++) {
    const prob = level === SIZES.zskiplistMaxLevel ? p : p * (1 - SIZES.zskiplistP);
    total += prob * jemallocSize(SIZES.zskiplistNode + SIZES.zskiplistLevel * level);
    p *= SIZES.zskiplistP;
  }
  return total;
})();

// ---- quicklist ---------------------------------------------------------------------------------------------------

export interface QuicklistNodeInfo {
  /** PLAIN node (one large element stored as a raw buffer) vs PACKED (listpack). */
  plain: boolean;
  count: number;
  /** node->sz: listpack bytes, or the element length for a plain node. */
  bytes: number;
}

const QL_OPT_LEVEL = [4096, 8192, 16384, 32768, 65536];
const QL_SIZE_SAFETY_LIMIT = 8192;
const QL_SIZE_ESTIMATE_OVERHEAD = 8;

function qlSizeLimit(fill: number): number {
  return QL_OPT_LEVEL[Math.min(-fill - 1, QL_OPT_LEVEL.length - 1)];
}

function qlExceedsLimit(fill: number, newSz: number, newCount: number): boolean {
  if (fill < 0) return newSz > qlSizeLimit(fill);
  if (newSz > QL_SIZE_SAFETY_LIMIT) return true;
  return newCount > (fill === 0 ? 1 : fill);
}

function qlIsLargeElement(fill: number, sz: number): boolean {
  return fill < 0 ? sz > qlSizeLimit(fill) : sz > QL_SIZE_SAFETY_LIMIT;
}

/**
 * Quicklist node layout of a list built by appending one element at a time (same rule as the RDB writer): one
 * listpack until list-max-listpack-size is exceeded, which becomes the first node, then tail-node appends.
 */
export function quicklistNodes(list: readonly string[], fill: number): QuicklistNodeInfo[] {
  const nodes: QuicklistNodeInfo[] = [];
  const lpEntry = (s: string): number => listpackBytes([s]) - 7;
  let quick = false;
  let tail: QuicklistNodeInfo = { plain: false, count: 0, bytes: 7 };
  for (const el of list) {
    const sz = el.length;
    if (!quick) {
      if (!qlExceedsLimit(fill, tail.bytes + sz, tail.count + 1)) {
        tail.count++;
        tail.bytes += lpEntry(el);
        continue;
      }
      quick = true;
      if (tail.count) nodes.push(tail);
    }
    if (qlIsLargeElement(fill, sz)) {
      nodes.push({ plain: true, count: 1, bytes: sz });
      continue;
    }
    const last = nodes[nodes.length - 1];
    if (last && !last.plain && !qlExceedsLimit(fill, last.bytes + sz + QL_SIZE_ESTIMATE_OVERHEAD, last.count + 1)) {
      last.count++;
      last.bytes += lpEntry(el);
    } else {
      tail = { plain: false, count: 1, bytes: 7 + lpEntry(el) };
      nodes.push(tail);
    }
  }
  if (!quick && tail.count) nodes.push(tail);
  return nodes;
}

/** The ql_* fields DEBUG OBJECT prints for a quicklist-encoded list (compression not modelled: ql_compressed = depth != 0). */
export function debugQuicklistInfo(
  list: readonly string[],
  fill: number,
  compressDepth = 0,
): { nodes: number; avgNode: number; listpackMax: number; compressed: number; uncompressedSize: number } {
  const nodes = quicklistNodes(list, fill);
  return {
    nodes: nodes.length,
    avgNode: nodes.length ? list.length / nodes.length : 0,
    listpackMax: fill,
    compressed: compressDepth !== 0 ? 1 : 0,
    uncompressedSize: nodes.reduce((n, q) => n + q.bytes, 0),
  };
}

// ---- rax (stream radix trees) ------------------------------------------------------------------------------------

interface RaxNode {
  compr: boolean;
  key: boolean;
  chars: number[];
  children: RaxNode[];
}

function newRaxNode(): RaxNode {
  return { compr: false, key: false, chars: [], children: [] };
}

/** Structural model of rax.c raxInsert, tracking numnodes / numele exactly for a given insertion order. */
export class RaxShape {
  numnodes = 1;
  numele = 0;
  private head: RaxNode = newRaxNode();

  insert(s: Uint8Array): boolean {
    const len = s.length;
    let h = this.head;
    let parent: RaxNode | null = null;
    let pidx = 0;
    let i = 0;
    let j = 0;
    while (h.chars.length && i < len) {
      if (h.compr) {
        for (j = 0; j < h.chars.length && i < len; j++, i++) if (h.chars[j] !== s[i]) break;
        if (j !== h.chars.length) break;
        parent = h;
        pidx = 0;
        h = h.children[0];
      } else {
        const idx = h.chars.indexOf(s[i]);
        if (idx < 0) break;
        i++;
        parent = h;
        pidx = idx;
        h = h.children[idx];
      }
      j = 0;
    }
    const replace = (n: RaxNode): void => {
      if (parent) parent.children[pidx] = n;
      else this.head = n;
    };
    if (i === len && (!h.compr || j === 0)) {
      if (h.key) return false;
      h.key = true;
      this.numele++;
      return true;
    }
    if (h.compr && i === len) {
      // The key ends inside a compressed node: split it into trimmed (key) + postfix.
      const postfix: RaxNode = { compr: h.chars.length - j > 1, key: true, chars: h.chars.slice(j), children: [h.children[0]] };
      replace({ compr: j > 1, key: h.key, chars: h.chars.slice(0, j), children: [postfix] });
      this.numnodes++;
      this.numele++;
      return true;
    }
    if (h.compr) {
      // Mismatch inside a compressed node: [trimmed] -> split (1 char) -> [postfix] -> old child.
      const next = h.children[0];
      const split: RaxNode = { compr: false, key: false, chars: [h.chars[j]], children: [] };
      if (j === 0) {
        split.key = h.key;
        replace(split);
      } else {
        replace({ compr: j > 1, key: h.key, chars: h.chars.slice(0, j), children: [split] });
        this.numnodes++;
      }
      const postLen = h.chars.length - j - 1;
      if (postLen > 0) {
        split.children.push({ compr: postLen > 1, key: false, chars: h.chars.slice(j + 1), children: [next] });
        this.numnodes++;
      } else split.children.push(next);
      h = split;
    }
    while (i < len) {
      const child = newRaxNode();
      if (h.chars.length === 0 && len - i > 1) {
        h.compr = true;
        h.chars = Array.from(s.subarray(i));
        h.children = [child];
        i = len;
      } else {
        let pos = 0;
        while (pos < h.chars.length && h.chars[pos] < s[i]) pos++;
        h.chars.splice(pos, 0, s[i]);
        h.children.splice(pos, 0, child);
        i++;
      }
      this.numnodes++;
      h = child;
    }
    h.key = true;
    this.numele++;
    return true;
  }
}

function streamIdKey(id: StreamId): Uint8Array {
  const b = Buffer.alloc(16);
  b.writeBigUInt64BE(BigInt(id.ms), 0);
  b.writeBigUInt64BE(BigInt(id.seq), 8);
  return b;
}

/**
 * streamRadixTreeMemoryUsage for a rax keyed by stream IDs, inserted in ascending order:
 * numele × sizeof(streamID) + numnodes × (sizeof(raxNode) + sizeof(long) × 30). (Redis overwrites, rather than adds
 * to, its initial sizeof(rax) term, so the rax struct itself is not counted.)
 */
export function streamRaxMemory(ids: Iterable<StreamId>): number {
  const sorted = [...ids].sort(compareIds);
  const rax = new RaxShape();
  for (const id of sorted) rax.insert(streamIdKey(id));
  return rax.numele * SIZES.streamID + rax.numnodes * (SIZES.raxNode + SIZES.raxNodeExtra);
}

// ---- MEMORY USAGE ------------------------------------------------------------------------------------------------

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

export const DEFAULT_SAMPLES = 5;

function ttlCount(t: FieldTtls | undefined): number {
  if (t === undefined) return 0;
  return typeof t === 'number' ? t : t.size;
}

function hasFieldTtl(t: FieldTtls | undefined, field: string, index: number): boolean {
  if (t === undefined) return false;
  if (typeof t === 'number') return index < t;
  return t.has(field);
}

/** Sum of `cost` over the first `limit` items (as objectComputeSize iterates), plus how many were sampled. */
function sample<T>(items: Iterable<T>, limit: number, cost: (item: T, index: number) => number): { sum: number; n: number } {
  let sum = 0;
  let n = 0;
  for (const item of items) {
    if (n >= limit) break;
    sum += cost(item, n);
    n++;
  }
  return { sum, n };
}

/** `asize += (double)elesize/samples*count` with C's size_t truncation. */
function addAverage(asize: number, sum: number, n: number, count: number): number {
  return n ? Math.floor(asize + (sum / n) * count) : asize;
}

function stringSize(key: string, value: string, encoding: string, hasExpire: boolean, raw: boolean): number {
  if (encoding === 'int') return kvobjAllocSize(key, hasExpire);
  if (encoding === 'embstr') return kvobjAllocSize(key, hasExpire, value.length);
  return kvobjAllocSize(key, hasExpire) + rawStringAlloc(value.length, !raw);
}

function listSize(kv: number, list: string[], encoding: string, limit: number, fill: number): number {
  if (encoding !== 'quicklist') return kv + jemallocSize(listpackBytes(list));
  const nodes = quicklistNodes(list, fill);
  let asize = kv + SIZES.quicklist;
  let elesize = 0;
  let elecount = 0;
  let samples = 0;
  for (const node of nodes) {
    elesize += SIZES.quicklistNode + jemallocSize(node.bytes);
    elecount += node.count;
    samples++;
    if (samples >= limit) break;
  }
  return elecount ? Math.floor(asize + (elesize / elecount) * list.length) : asize;
}

function setSize(kv: number, set: Set<string>, encoding: string, limit: number): number {
  if (encoding === 'intset') return kv + jemallocSize(intsetBytes(set));
  if (encoding === 'listpack') return kv + jemallocSize(listpackBytes([...set]));
  const asize = kv + SIZES.dict + SIZES.bucket * dictBuckets(set.size);
  const { sum, n } = sample(set, limit, (m) => SIZES.dictEntryNoValue + sdsAllocSize(m.length));
  return addAverage(asize, sum, n, set.size);
}

function zsetSize(kv: number, z: ZSet, encoding: string, limit: number): number {
  if (encoding === 'listpack') {
    const items: ListpackEntry[] = [];
    for (const e of z.entries) items.push(e.member, scoreEntry(e.score));
    return kv + jemallocSize(listpackBytes(items));
  }
  const header = jemallocSize(SIZES.zskiplistNode + SIZES.zskiplistLevel * SIZES.zskiplistMaxLevel);
  const asize = kv + SIZES.zset + SIZES.zskiplist + SIZES.dict + SIZES.bucket * dictBuckets(z.size) + header;
  const { sum, n } = sample(z.entries, limit, (e) => sdsAllocSize(e.member.length) + SIZES.dictEntry + EXPECTED_ZSL_NODE);
  return addAverage(asize, sum, n, z.size);
}

function hashSize(kv: number, h: Map<string, string>, encoding: string, limit: number, ttls: FieldTtls | undefined): number {
  if (encoding === 'listpack') {
    const items: string[] = [];
    for (const [f, v] of h) items.push(f, v);
    return kv + jemallocSize(listpackBytes(items));
  }
  if (encoding === 'listpackex') {
    // (field, value, ttl) triplets; a TTL is a unix-ms integer (int64 entry), no TTL is stored as 0.
    const withTtl = Math.min(ttlCount(ttls), h.size);
    let bytes = 7 + withTtl * 10 + (h.size - withTtl) * 2;
    for (const [f, v] of h) bytes += listpackBytes([f, v]) - 7;
    return kv + jemallocSize(SIZES.listpackEx) + jemallocSize(bytes);
  }
  const asize = kv + SIZES.dict + SIZES.bucket * dictBuckets(h.size);
  const { sum, n } = sample(
    h,
    limit,
    ([f, v], i) => hfieldAllocSize(f.length, hasFieldTtl(ttls, f, i)) + sdsAllocSize(v.length) + SIZES.dictEntry,
  );
  return addAverage(asize, sum, n, h.size);
}

function pendingIds(m: ReadonlyMap<string, PendingEntry>): StreamId[] {
  const out: StreamId[] = [];
  for (const p of m.values()) out.push(p.id);
  return out;
}

function groupSize(g: ConsumerGroup): number {
  let n = SIZES.streamCG + streamRaxMemory(pendingIds(g.pending)) + SIZES.streamNACK * g.pending.size;
  for (const c of g.consumers.values()) {
    n += SIZES.streamConsumer + c.name.length + streamRaxMemory(pendingIds(c.pending));
  }
  return n;
}

function streamSize(kv: number, s: Stream, limit: number, maxEntries: number, maxBytes: number): number {
  s.ensureNodes(maxEntries, maxBytes);
  const nodes = s.nodes;
  let asize = kv + SIZES.stream + streamRaxMemory(nodes.map((n) => n.masterId));
  const prealloc = maxBytes > 0 && maxBytes < SIZES.streamPrealloc ? maxBytes : SIZES.streamPrealloc;
  // The tail node keeps its preallocated listpack; nodes closed by streamAppendItem were shrunk to fit.
  const alloc = (i: number): number => {
    const used = jemallocSize(Stream.nodeBytes(nodes[i]));
    return i === nodes.length - 1 ? Math.max(jemallocSize(prealloc), used) : used;
  };
  let lpsize = 0;
  let samples = 0;
  while (samples < limit && samples < nodes.length) lpsize += alloc(samples++);
  if (nodes.length <= samples) asize += lpsize;
  else {
    if (samples) lpsize = Math.floor(lpsize / samples);
    asize += lpsize * (nodes.length - 1) + alloc(nodes.length - 1);
  }
  for (const g of s.groups.values()) asize += groupSize(g);
  return asize;
}

/**
 * objectComputeSize for a Redis 8 kvobj: the value object (with its embedded key and expire slot) plus everything it
 * owns. Sampled aggregates (HT sets/hashes, skiplist zsets, quicklists, stream listpacks) average the first `samples`
 * elements and scale by the element count, exactly like Redis.
 */
export function objectSize(key: string, value: RedisValue, encoding: string, opts: MemoryUsageOptions): number {
  const limit = opts.samples <= 0 ? Infinity : opts.samples;
  const kv = kvobjAllocSize(key, opts.hasExpire);
  switch (value.type) {
    case 'string':
      return stringSize(key, value.value, encoding, opts.hasExpire, value.raw === true);
    case 'list':
      return listSize(kv, value.value, encoding, limit, opts.listMaxListpackSize ?? -2);
    case 'set':
      return setSize(kv, value.value, encoding, limit);
    case 'zset':
      return zsetSize(kv, value.value, encoding, limit);
    case 'hash':
      return hashSize(kv, value.value, encoding, limit, opts.fieldTtls);
    case 'stream':
      return streamSize(kv, value.value, limit, opts.streamNodeMaxEntries ?? 100, opts.streamNodeMaxBytes ?? 4096);
  }
}

/** MEMORY USAGE key [SAMPLES n]: objectComputeSize + the keyspace dict entry (no-value dict, 16 bytes). */
export function memoryUsage(key: string, value: RedisValue, encoding: string, opts: MemoryUsageOptions): number {
  return objectSize(key, value, encoding, opts) + SIZES.dictEntryNoValue;
}

// ---- DEBUG OBJECT ------------------------------------------------------------------------------------------------

/** DEBUG OBJECT serializedlength: rdbSavedObjectLen, i.e. the RDB object body (no type byte, no DUMP footer). */
export function serializedLength(value: RedisValue, opts?: Partial<RdbOptions>, fieldExpires?: FieldExpires): number {
  return encodeObject(value, opts, fieldExpires).body.length;
}

// ---- dataset / overhead / MEMORY STATS / INFO memory -------------------------------------------------------------

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

/** kvstoreMemUsage of a single-dict kvstore (standalone) holding `used` entries. */
export function kvstoreMemUsage(used: number, allocated = used > 0): number {
  let mem = SIZES.kvstore + used * SIZES.dictEntryNoValue + dictBuckets(used) * SIZES.bucket;
  if (allocated) mem += SIZES.dict + SIZES.kvstoreDictMeta;
  return mem;
}

export interface DbSizeOptions {
  samples?: number;
  listMaxListpackSize?: number;
  streamNodeMaxEntries?: number;
  streamNodeMaxBytes?: number;
}

/** Per-db dataset bytes and hash-table overhead, as getMemoryOverheadData computes them. */
export function dbOverhead(db: DbSnapshot, opts: DbSizeOptions = {}): DbOverhead {
  let keys = db.totals?.keys ?? 0;
  let expires = db.totals?.expires ?? 0;
  let dataset = db.totals?.dataset ?? 0;
  for (const r of db.totals ? [] : (db.keys ?? [])) {
    keys++;
    if (r.hasExpire) expires++;
    dataset += objectSize(r.key, r.value, r.encoding, {
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
    main: kvstoreMemUsage(keys, allocated) + keys * SIZES.robj,
    expiresOverhead: kvstoreMemUsage(expires, allocated),
    lut: (dictBuckets(keys) + dictBuckets(expires)) * SIZES.bucket,
    dataset,
  };
}

/** Bytes of all values (objectSize of every key, every element counted) across the given databases. */
export function datasetBytes(databases: Iterable<DbSnapshot>, opts: DbSizeOptions = {}): number {
  let total = 0;
  for (const db of databases) total += dbOverhead(db, opts).dataset;
  return total;
}

/** Memory of one normal client: zmalloc'd client struct + reply buffer + query buffer + argv. */
export function clientMemory(opts: { replyBuffer?: number; queryBuffer?: number; argvBytes?: number; outputBytes?: number } = {}): number {
  return (
    SIZES.client + (opts.replyBuffer ?? SIZES.clientReplyBuffer) + (opts.queryBuffer ?? 0) + (opts.argvBytes ?? 0) + (opts.outputBytes ?? 0)
  );
}

/** Synthetic defaults for numbers that come from the process/allocator in real Redis. */
export const MEMORY_DEFAULTS = Object.freeze({
  /** used_memory_startup of a fresh server. */
  startup: 900_000,
  /** used_memory_functions with no libraries loaded (function engine dicts). */
  functionsCaches: 184,
  /** Allocator resident memory beyond active pages (jemalloc metadata, dirty pages). */
  allocatorResidentExtra: 2 * 1024 * 1024,
  /** Process RSS beyond allocator resident memory (binary, stacks, Lua heap). */
  rssExtra: 4 * 1024 * 1024,
});

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

/**
 * getMemoryOverheadData over a dataset: used_memory = startup + client/replication/AOF/script overheads + keyspace
 * hash tables + dataset, so overhead.total + dataset.bytes == total.allocated exactly.
 */
export function computeMemory(input: MemoryInput): MemoryReport {
  const startup = input.startup ?? MEMORY_DEFAULTS.startup;
  const replicationBacklog = input.replicationBacklog ?? 0;
  const clientsSlaves = input.clientsSlaves ?? 0;
  const clientsNormal = input.clientsNormal ?? 0;
  const clusterLinks = input.clusterLinks ?? 0;
  const aofBuffer = input.aofBuffer ?? 0;
  const luaCaches = input.luaCaches ?? 0;
  const functionsCaches = input.functionsCaches ?? MEMORY_DEFAULTS.functionsCaches;
  const dbs: DbOverhead[] = [];
  let overheadTotal =
    startup + replicationBacklog + clientsSlaves + clientsNormal + clusterLinks + aofBuffer + luaCaches + functionsCaches;
  let keysCount = 0;
  let dataset = 0;
  let hashtableLut = 0;
  for (const db of input.databases) {
    const o = dbOverhead(db, input.sizes);
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
  const allocatorResident = allocatorActive + MEMORY_DEFAULTS.allocatorResidentExtra;
  const rss = input.rss ?? allocatorResident + MEMORY_DEFAULTS.rssExtra;
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
export function memoryForEviction(report: MemoryReport): number {
  return Math.max(0, report.usedMemory - report.notCountedForEvict);
}

/** A MEMORY STATS value: integer (addReplyLongLong), double (addReplyDouble) or a nested map (db.N). */
export type MemoryStatValue = number | { double: number } | Array<[string, number]>;

/** MEMORY STATS, in Redis's reply order. */
export function memoryStats(r: MemoryReport): Array<[string, MemoryStatValue]> {
  const d = (v: number): { double: number } => ({ double: v });
  const out: Array<[string, MemoryStatValue]> = [
    ['peak.allocated', r.peak],
    ['total.allocated', r.usedMemory],
    ['startup.allocated', r.startup],
    ['replication.backlog', r.replicationBacklog],
    ['clients.slaves', r.clientsSlaves],
    ['clients.normal', r.clientsNormal],
    ['cluster.links', r.clusterLinks],
    ['aof.buffer', r.aofBuffer],
    ['lua.caches', r.luaCaches],
    ['functions.caches', r.functionsCaches],
  ];
  for (const db of r.dbs) {
    out.push([
      `db.${db.id}`,
      [
        ['overhead.hashtable.main', db.main],
        ['overhead.hashtable.expires', db.expiresOverhead],
      ],
    ]);
  }
  out.push(
    ['overhead.db.hashtable.lut', r.hashtableLut],
    ['overhead.db.hashtable.rehashing', r.hashtableRehashing],
    ['overhead.total', r.overheadTotal],
    ['db.dict.rehashing.count', r.dictRehashingCount],
    ['keys.count', r.keysCount],
    ['keys.bytes-per-key', r.bytesPerKey],
    ['dataset.bytes', r.dataset],
    ['dataset.percentage', d(r.datasetPercentage)],
    ['peak.percentage', d(r.peakPercentage)],
    ['allocator.allocated', r.allocatorAllocated],
    ['allocator.active', r.allocatorActive],
    ['allocator.resident', r.allocatorResident],
    ['allocator.muzzy', r.allocatorMuzzy],
    ['allocator-fragmentation.ratio', d(r.allocatorFragRatio)],
    ['allocator-fragmentation.bytes', r.allocatorFragBytes],
    ['allocator.rss-ratio', d(r.allocatorRssRatio)],
    ['allocator.rss-bytes', r.allocatorRssBytes],
    ['rss-overhead.ratio', d(r.rssOverheadRatio)],
    ['rss-overhead.bytes', r.rssOverheadBytes],
    ['fragmentation', d(r.fragmentation)],
    ['fragmentation.bytes', r.fragmentationBytes],
  );
  return out;
}

/** bytesToHuman: B, then K/M/G/T/P/E with two decimals. */
export function bytesToHuman(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ['K', 'M', 'G', 'T', 'P', 'E'];
  let d = n / 1024;
  let i = 0;
  while (i < units.length - 1 && d >= 1024) {
    d /= 1024;
    i++;
  }
  return `${d.toFixed(2)}${units[i]}`;
}

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

/** The INFO memory section (field, value) pairs in Redis order; values are rendered as Redis prints them. */
export function infoMemory(r: MemoryReport, x: InfoMemoryExtras = {}): Array<[string, string | number]> {
  const pct = (v: number): string => `${v.toFixed(2)}%`;
  const ratio = (v: number): string => v.toFixed(2);
  const luaVm = x.luaVmMemory ?? 32768;
  const fnVm = x.functionsVmMemory ?? 32768;
  const scripts = r.luaCaches + r.functionsCaches;
  const sys = x.totalSystemMemory ?? 0;
  const maxmemory = x.maxmemory ?? 0;
  return [
    ['used_memory', r.usedMemory],
    ['used_memory_human', bytesToHuman(r.usedMemory)],
    ['used_memory_rss', r.rss],
    ['used_memory_rss_human', bytesToHuman(r.rss)],
    ['used_memory_peak', r.peak],
    ['used_memory_peak_time', x.peakTime ?? 0],
    ['used_memory_peak_human', bytesToHuman(r.peak)],
    ['used_memory_peak_perc', pct(r.peakPercentage)],
    ['used_memory_overhead', r.overheadTotal],
    ['used_memory_startup', r.startup],
    ['used_memory_dataset', r.dataset],
    ['used_memory_dataset_perc', pct(r.datasetPercentage)],
    ['allocator_allocated', r.allocatorAllocated],
    ['allocator_active', r.allocatorActive],
    ['allocator_resident', r.allocatorResident],
    ['allocator_muzzy', r.allocatorMuzzy],
    ['total_system_memory', sys],
    ['total_system_memory_human', bytesToHuman(sys)],
    ['used_memory_lua', luaVm],
    ['used_memory_vm_eval', luaVm],
    ['used_memory_lua_human', bytesToHuman(luaVm)],
    ['used_memory_scripts_eval', r.luaCaches],
    ['number_of_cached_scripts', x.cachedScripts ?? 0],
    ['number_of_functions', x.functions ?? 0],
    ['number_of_libraries', x.libraries ?? 0],
    ['used_memory_vm_functions', fnVm],
    ['used_memory_vm_total', luaVm + fnVm],
    ['used_memory_vm_total_human', bytesToHuman(luaVm + fnVm)],
    ['used_memory_functions', r.functionsCaches],
    ['used_memory_scripts', scripts],
    ['used_memory_scripts_human', bytesToHuman(scripts)],
    ['maxmemory', maxmemory],
    ['maxmemory_human', bytesToHuman(maxmemory)],
    ['maxmemory_policy', x.maxmemoryPolicy ?? 'noeviction'],
    ['allocator_frag_ratio', ratio(r.allocatorFragRatio)],
    ['allocator_frag_bytes', r.allocatorFragBytes],
    ['allocator_rss_ratio', ratio(r.allocatorRssRatio)],
    ['allocator_rss_bytes', r.allocatorRssBytes],
    ['rss_overhead_ratio', ratio(r.rssOverheadRatio)],
    ['rss_overhead_bytes', r.rssOverheadBytes],
    ['mem_fragmentation_ratio', ratio(r.fragmentation)],
    ['mem_fragmentation_bytes', r.fragmentationBytes],
    ['mem_not_counted_for_evict', r.notCountedForEvict],
    ['mem_replication_backlog', r.replicationBacklog],
    ['mem_total_replication_buffers', x.replicationBuffers ?? 0],
    ['mem_clients_slaves', r.clientsSlaves],
    ['mem_clients_normal', r.clientsNormal],
    ['mem_cluster_links', r.clusterLinks],
    ['mem_aof_buffer', r.aofBuffer],
    ['mem_allocator', x.allocator ?? 'jemalloc-5.3.0'],
    ['mem_overhead_db_hashtable_rehashing', r.hashtableRehashing],
    ['active_defrag_running', x.activeDefragRunning ?? 0],
    ['lazyfree_pending_objects', x.lazyfreePendingObjects ?? 0],
    ['lazyfreed_objects', x.lazyfreedObjects ?? 0],
  ];
}
