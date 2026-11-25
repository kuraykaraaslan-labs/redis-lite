import type { ListDeque } from '@/modules/lists/lists.deque.structure';
import PersistenceService from '@/modules/persistence/persistence.service';
import type { ListpackEntry } from '@/modules/persistence/persistence.types';
import { Stream } from '@/modules/streams/streams.structure';
import type { ZSet } from '@/modules/zsets/zsets.structure';
import type { RedisValue } from '@/modules/database/database.types';
import type { ConsumerGroup, PendingEntry, StreamId } from '@/modules/streams/streams.types';

import MemoryAllocModel from './memory.alloc.model';
import MemoryQuicklistModel from './memory.quicklist.model';
import MemoryRaxModel from './memory.rax.model';
import type { FieldTtls, MemoryUsageOptions } from './memory.types';

/**
 * objectComputeSize for a Redis 8 kvobj: the value object (with its embedded key and expire slot) plus everything it
 * owns. Sampled aggregates (HT sets/hashes, skiplist zsets, quicklists, stream listpacks) average the first `samples`
 * elements and scale by the element count, exactly like Redis.
 */
export default class MemoryObjectModel {
  // ──────────────────────────────────────────────
  // Private Helpers: sampling
  // ──────────────────────────────────────────────

  private static ttlCount(t: FieldTtls | undefined): number {
    if (t === undefined) return 0;
    return typeof t === 'number' ? t : t.size;
  }

  private static hasFieldTtl(t: FieldTtls | undefined, field: string, index: number): boolean {
    if (t === undefined) return false;
    if (typeof t === 'number') return index < t;
    return t.has(field);
  }

  /** Sum of `cost` over the first `limit` items (as objectComputeSize iterates), plus how many were sampled. */
  private static sample<T>(items: Iterable<T>, limit: number, cost: (item: T, index: number) => number): { sum: number; n: number } {
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
  private static addAverage(asize: number, sum: number, n: number, count: number): number {
    return n ? Math.floor(asize + (sum / n) * count) : asize;
  }

  // ──────────────────────────────────────────────
  // Private Helpers: per type
  // ──────────────────────────────────────────────

  private static stringSize(key: string, value: string, encoding: string, hasExpire: boolean, raw: boolean): number {
    const M = MemoryAllocModel;
    if (encoding === 'int') return M.kvobjAllocSize(key, hasExpire);
    if (encoding === 'embstr') return M.kvobjAllocSize(key, hasExpire, value.length);
    return M.kvobjAllocSize(key, hasExpire) + M.rawStringAlloc(value.length, !raw);
  }

  private static listSize(kv: number, list: ListDeque, encoding: string, limit: number, fill: number): number {
    const M = MemoryAllocModel;
    if (encoding !== 'quicklist') return kv + M.jemallocSize(PersistenceService.listpackBytes(list));
    const nodes = MemoryQuicklistModel.quicklistNodes(list, fill);
    const asize = kv + M.SIZES.quicklist;
    let elesize = 0;
    let elecount = 0;
    let samples = 0;
    for (const node of nodes) {
      elesize += M.SIZES.quicklistNode + M.jemallocSize(node.bytes);
      elecount += node.count;
      samples++;
      if (samples >= limit) break;
    }
    return elecount ? Math.floor(asize + (elesize / elecount) * list.length) : asize;
  }

  private static setSize(kv: number, set: Set<string>, encoding: string, limit: number): number {
    const M = MemoryAllocModel;
    if (encoding === 'intset') return kv + M.jemallocSize(M.intsetBytes(set));
    if (encoding === 'listpack') return kv + M.jemallocSize(PersistenceService.listpackBytes([...set]));
    const asize = kv + M.SIZES.dict + M.SIZES.bucket * M.dictBuckets(set.size);
    const { sum, n } = MemoryObjectModel.sample(set, limit, (m) => M.SIZES.dictEntryNoValue + M.sdsAllocSize(m.length));
    return MemoryObjectModel.addAverage(asize, sum, n, set.size);
  }

  private static zsetSize(kv: number, z: ZSet, encoding: string, limit: number): number {
    const M = MemoryAllocModel;
    const S = M.SIZES;
    if (encoding === 'listpack') {
      const items: ListpackEntry[] = [];
      for (const e of z.entries) items.push(e.member, M.scoreEntry(e.score));
      return kv + M.jemallocSize(PersistenceService.listpackBytes(items));
    }
    const header = M.jemallocSize(S.zskiplistNode + S.zskiplistLevel * S.zskiplistMaxLevel);
    const asize = kv + S.zset + S.zskiplist + S.dict + S.bucket * M.dictBuckets(z.size) + header;
    const { sum, n } = MemoryObjectModel.sample(z.entries, limit, (e) => M.sdsAllocSize(e.member.length) + S.dictEntry + M.EXPECTED_ZSL_NODE);
    return MemoryObjectModel.addAverage(asize, sum, n, z.size);
  }

  private static hashSize(kv: number, h: Map<string, string>, encoding: string, limit: number, ttls: FieldTtls | undefined): number {
    const M = MemoryAllocModel;
    const O = MemoryObjectModel;
    const listpackBytes = PersistenceService.listpackBytes;
    if (encoding === 'listpack') {
      const items: string[] = [];
      for (const [f, v] of h) items.push(f, v);
      return kv + M.jemallocSize(listpackBytes(items));
    }
    if (encoding === 'listpackex') {
      // (field, value, ttl) triplets; a TTL is a unix-ms integer (int64 entry), no TTL is stored as 0.
      const withTtl = Math.min(O.ttlCount(ttls), h.size);
      let bytes = 7 + withTtl * 10 + (h.size - withTtl) * 2;
      for (const [f, v] of h) bytes += listpackBytes([f, v]) - 7;
      return kv + M.jemallocSize(M.SIZES.listpackEx) + M.jemallocSize(bytes);
    }
    const asize = kv + M.SIZES.dict + M.SIZES.bucket * M.dictBuckets(h.size);
    const { sum, n } = O.sample(
      h,
      limit,
      ([f, v], i) => M.hfieldAllocSize(f.length, O.hasFieldTtl(ttls, f, i)) + M.sdsAllocSize(v.length) + M.SIZES.dictEntry,
    );
    return O.addAverage(asize, sum, n, h.size);
  }

  private static pendingIds(m: ReadonlyMap<string, PendingEntry>): StreamId[] {
    const out: StreamId[] = [];
    for (const p of m.values()) out.push(p.id);
    return out;
  }

  private static groupSize(g: ConsumerGroup): number {
    const S = MemoryAllocModel.SIZES;
    const rax = MemoryRaxModel.streamRaxMemory;
    const ids = MemoryObjectModel.pendingIds;
    let n = S.streamCG + rax(ids(g.pending)) + S.streamNACK * g.pending.size;
    for (const c of g.consumers.values()) {
      n += S.streamConsumer + c.name.length + rax(ids(c.pending));
    }
    return n;
  }

  private static streamSize(kv: number, s: Stream, limit: number, maxEntries: number, maxBytes: number): number {
    const M = MemoryAllocModel;
    s.ensureNodes(maxEntries, maxBytes);
    const nodes = s.nodes;
    let asize = kv + M.SIZES.stream + MemoryRaxModel.streamRaxMemory(nodes.map((n) => n.masterId));
    const prealloc = maxBytes > 0 && maxBytes < M.SIZES.streamPrealloc ? maxBytes : M.SIZES.streamPrealloc;
    // The tail node keeps its preallocated listpack; nodes closed by streamAppendItem were shrunk to fit.
    const alloc = (i: number): number => {
      const used = M.jemallocSize(Stream.nodeBytes(nodes[i]));
      return i === nodes.length - 1 ? Math.max(M.jemallocSize(prealloc), used) : used;
    };
    let lpsize = 0;
    let samples = 0;
    while (samples < limit && samples < nodes.length) lpsize += alloc(samples++);
    if (nodes.length <= samples) asize += lpsize;
    else {
      if (samples) lpsize = Math.floor(lpsize / samples);
      asize += lpsize * (nodes.length - 1) + alloc(nodes.length - 1);
    }
    for (const g of s.groups.values()) asize += MemoryObjectModel.groupSize(g);
    return asize;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** objectComputeSize: the kvobj and everything it owns (see the class comment). */
  static objectSize(key: string, value: RedisValue, encoding: string, opts: MemoryUsageOptions): number {
    const O = MemoryObjectModel;
    const limit = opts.samples <= 0 ? Infinity : opts.samples;
    const kv = MemoryAllocModel.kvobjAllocSize(key, opts.hasExpire);
    switch (value.type) {
      case 'string':
        return O.stringSize(key, value.value, encoding, opts.hasExpire, value.raw === true);
      case 'list':
        return O.listSize(kv, value.value, encoding, limit, opts.listMaxListpackSize ?? -2);
      case 'set':
        return O.setSize(kv, value.value, encoding, limit);
      case 'zset':
        return O.zsetSize(kv, value.value, encoding, limit);
      case 'hash':
        return O.hashSize(kv, value.value, encoding, limit, opts.fieldTtls);
      case 'stream':
        return O.streamSize(kv, value.value, limit, opts.streamNodeMaxEntries ?? 100, opts.streamNodeMaxBytes ?? 4096);
      case 'timeseries':
        // a module value: the kvobj plus what the series reports as its own memory (TS.INFO memoryUsage)
        return kv + value.value.memoryUsage();
    }
  }
}
