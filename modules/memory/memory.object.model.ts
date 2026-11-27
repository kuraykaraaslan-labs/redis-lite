import type { ListDeque } from '@/modules/lists/lists.deque.structure';
import PersistenceService from '@/modules/persistence/persistence.service';
import type { ListpackEntry } from '@/modules/persistence/persistence.types';
import { Stream } from '@/modules/streams/streams.structure';
import type { ZSet } from '@/modules/zsets/zsets.structure';
import type { RedisValue } from '@/modules/database/database.types';
import type { ConsumerGroup, PendingEntry, StreamId } from '@/modules/streams/streams.types';

import MemoryAllocModel from './memory.alloc.model';
import MemoryDictModel from './memory.dict.model';
import MemoryQuicklistModel from './memory.quicklist.model';
import MemoryRaxModel from './memory.rax.model';
import MemorySdsModel from './memory.sds.model';
import type { MemoryUsageOptions, StringValue, StructSizes } from './memory.types';

/**
 * What one key costs in Redis 7.0: its key sds plus objectComputeSize of the value (the robj and everything it owns).
 * Sampled aggregates (HT sets/hashes, skiplist zsets, quicklists, stream listpacks) average the first `samples`
 * elements and scale by the element count, exactly like Redis.
 */
export default class MemoryObjectModel {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Integers Redis keeps as shared objects (OBJ_SHARED_INTEGERS). */
  private static readonly SHARED_INT = /^(0|[1-9]\d{0,3})$/;

  /** Struct sizes as objectComputeSize counts them (sizeof). */
  private static readonly SIZEOF: StructSizes = MemoryObjectModel.structs((n) => n);
  /** Struct sizes as the allocator hands them out (used_memory). */
  private static readonly ALLOCATED: StructSizes = MemoryObjectModel.structs((n) => MemoryAllocModel.jemallocSize(n));

  private static structs(size: (n: number) => number): StructSizes {
    const S = MemoryAllocModel.SIZES;
    return Object.freeze({
      dict: size(S.dict),
      dictEntry: size(S.dictEntry),
      quicklist: size(S.quicklist),
      quicklistNode: size(S.quicklistNode),
      streamCG: size(S.streamCG),
      streamConsumer: size(S.streamConsumer),
      streamNACK: size(S.streamNACK),
    });
  }

  // ──────────────────────────────────────────────
  // Private Helpers: sampling
  // ──────────────────────────────────────────────

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

  private static stringSize(v: StringValue, encoding: string): number {
    const M = MemoryAllocModel;
    if (encoding === 'int') return M.SIZES.robj;
    if (encoding === 'embstr') return M.embstrAllocSize(v.value.length);
    return M.SIZES.robj + MemorySdsModel.of(v).size;
  }

  /** A quicklist: the struct, then the first `limit` nodes (struct + data allocation) averaged per node. */
  private static listSize(kv: number, list: ListDeque, limit: number, T: StructSizes): number {
    const asize = kv + T.quicklist;
    const sampled = MemoryQuicklistModel.quicklistNodes(list, limit);
    if (!sampled.length) return asize;
    let elesize = 0;
    for (const node of sampled) elesize += T.quicklistNode + node.alloc;
    return Math.floor(asize + (elesize / sampled.length) * list.layout.nodes.length);
  }

  private static setSize(kv: number, set: Set<string>, encoding: string, limit: number, T: StructSizes): number {
    const M = MemoryAllocModel;
    if (encoding === 'intset') return kv + M.jemallocSize(M.intsetBytes(set));
    const asize = kv + T.dict + M.SIZES.bucket * MemoryDictModel.slots(set, set.size);
    const { sum, n } = MemoryObjectModel.sample(set, limit, (m) => T.dictEntry + M.sdsAllocSize(m.length));
    return MemoryObjectModel.addAverage(asize, sum, n, set.size);
  }

  private static zsetSize(kv: number, z: ZSet, encoding: string, limit: number, T: StructSizes): number {
    const M = MemoryAllocModel;
    const S = M.SIZES;
    if (encoding === 'listpack') {
      const items: ListpackEntry[] = [];
      for (const e of z.entries) items.push(e.member, M.scoreEntry(e.score));
      return kv + M.jemallocSize(PersistenceService.listpackBytes(items));
    }
    const header = M.jemallocSize(S.zskiplistNode + S.zskiplistLevel * S.zskiplistMaxLevel);
    const asize = kv + S.zset + S.zskiplist + T.dict + S.bucket * MemoryDictModel.slots(z, z.size) + header;
    const { sum, n } = MemoryObjectModel.sample(z.entries, limit, (e) => M.sdsAllocSize(e.member.length) + T.dictEntry + M.EXPECTED_ZSL_NODE);
    return MemoryObjectModel.addAverage(asize, sum, n, z.size);
  }

  private static hashSize(kv: number, h: Map<string, string>, encoding: string, limit: number, T: StructSizes): number {
    const M = MemoryAllocModel;
    const O = MemoryObjectModel;
    const listpackBytes = PersistenceService.listpackBytes;
    if (encoding === 'listpack') {
      const items: string[] = [];
      for (const [f, v] of h) items.push(f, v);
      return kv + M.jemallocSize(listpackBytes(items));
    }
    const asize = kv + T.dict + M.SIZES.bucket * MemoryDictModel.slots(h, h.size);
    const { sum, n } = O.sample(h, limit, ([f, v]) => M.sdsAllocSize(f.length) + M.sdsAllocSize(v.length) + T.dictEntry);
    return O.addAverage(asize, sum, n, h.size);
  }

  private static pendingIds(m: ReadonlyMap<string, PendingEntry>): StreamId[] {
    const out: StreamId[] = [];
    for (const p of m.values()) out.push(p.id);
    return out;
  }

  private static groupSize(g: ConsumerGroup, T: StructSizes): number {
    const rax = MemoryRaxModel.streamRaxMemory;
    const ids = MemoryObjectModel.pendingIds;
    let n = T.streamCG + rax(ids(g.pending)) + T.streamNACK * g.pending.size;
    for (const c of g.consumers.values()) {
      n += T.streamConsumer + c.name.length + rax(ids(c.pending));
    }
    return n;
  }

  private static streamSize(kv: number, s: Stream, limit: number, maxEntries: number, maxBytes: number, T: StructSizes): number {
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
    for (const g of s.groups.values()) asize += MemoryObjectModel.groupSize(g, T);
    return asize;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The key sds plus objectComputeSize of the value (see the class comment). */
  static objectSize(key: string, value: RedisValue, encoding: string, opts: MemoryUsageOptions): number {
    return MemoryAllocModel.keyAllocSize(key) + MemoryObjectModel.valueSize(value, encoding, opts);
  }

  /** objectComputeSize: the robj and everything it owns. */
  static valueSize(value: RedisValue, encoding: string, opts: MemoryUsageOptions): number {
    const O = MemoryObjectModel;
    const limit = opts.samples <= 0 ? Infinity : opts.samples;
    const kv = MemoryAllocModel.SIZES.robj;
    const T = opts.allocated ? O.ALLOCATED : O.SIZEOF;
    switch (value.type) {
      case 'string':
        // a shared integer object (0..9999 when maxmemory is off) allocates nothing of its own
        if (opts.allocated && opts.sharedIntegers && encoding === 'int' && O.SHARED_INT.test(value.value)) return 0;
        return O.stringSize(value, encoding);
      case 'list':
        return O.listSize(kv, value.value, limit, T);
      case 'set':
        return O.setSize(kv, value.value, encoding, limit, T);
      case 'zset':
        return O.zsetSize(kv, value.value, encoding, limit, T);
      case 'hash':
        return O.hashSize(kv, value.value, encoding, limit, T);
      case 'stream':
        return O.streamSize(kv, value.value, limit, opts.streamNodeMaxEntries ?? 100, opts.streamNodeMaxBytes ?? 4096, T);
    }
  }
}
