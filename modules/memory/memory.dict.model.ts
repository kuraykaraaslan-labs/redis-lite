// Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
import MemoryAllocModel from './memory.alloc.model';
import type { DictKind, DictSnapshot, DictState, DictTables } from './memory.types';

/**
 * The hash tables behind hashtable-encoded sets, hashes and skiplist sorted sets in Redis 7.0, as MEMORY USAGE and
 * DEBUG HTSTATS-KEY show them. A table grows to the next power of two when an insert finds it full, then rehashes
 * incrementally: every lookup / insert / delete on the dict moves one bucket (skipping at most 10 empty ones). After a
 * delete that leaves it under 10 % full it shrinks the same way. Both tables count while a rehash is running.
 *
 * Redis's bucket layout depends on a random hash seed, so how many steps a rehash takes is simulated with random
 * bucket positions; whether a dict is rehashing right after a write, and the settled sizes, are deterministic.
 * The state is kept per container object (Set / Map / ZSet) and follows the value across RENAME / MOVE.
 */
export default class MemoryDictModel {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  private static readonly states = new WeakMap<object, DictState>();

  private static readonly INITIAL_SIZE = 4;
  /** A dict shrinks once fewer than this percentage of its buckets are used. */
  private static readonly MIN_FILL = 10;
  /** Empty buckets one rehash step may skip before giving up. */
  private static readonly EMPTY_VISITS = 10;
  /** Extra steps an insert costs beyond the one every dict access costs (a hash or zset looks the key up first). */
  private static readonly ADD_EXTRA: Readonly<Record<DictKind, number>> = { set: 0, hash: 1, zset: 1, keyspace: 0, plain: 0 };
  /** Kinds whose dict shrinks right after a delete (the keyspace dicts shrink in serverCron instead). */
  private static readonly SHRINK_ON_DELETE: ReadonlySet<DictKind> = new Set(['set', 'hash', 'zset']);
  /** Rehash steps serverCron's active rehashing performs per run (1 ms of 100-bucket steps: plenty for most dicts). */
  private static readonly ACTIVE_REHASH_STEPS = 100_000;

  // ──────────────────────────────────────────────
  // Private Helpers: the table model
  // ──────────────────────────────────────────────

  /** Buckets dictExpand allocates for `n` entries: 0, or the next power of two ≥ n (at least 4). */
  private static tableFor(n: number): number {
    return MemoryAllocModel.dictBuckets(n);
  }

  /** Rehash steps needed to empty a table of `size` buckets holding `used` entries at random positions. */
  private static rehashSteps(size: number, used: number): number {
    const chains = new Uint32Array(size);
    for (let i = 0; i < used; i++) chains[Math.floor(Math.random() * size)]++;
    let steps = 0;
    let idx = 0;
    let left = used;
    while (left > 0) {
      steps++;
      let visits = MemoryDictModel.EMPTY_VISITS;
      while (chains[idx] === 0 && visits > 0) {
        idx++;
        visits--;
      }
      // a step that met too many empty buckets ends without moving anything
      if (chains[idx] === 0) continue;
      left -= chains[idx++];
    }
    return Math.max(1, steps);
  }

  private static startRehash(st: DictState, target: number): void {
    st.size1 = target;
    st.steps = MemoryDictModel.rehashSteps(st.size0, st.used);
    st.stepsTotal = st.steps;
    st.usedAtStart = st.used;
    st.added = 0;
  }

  private static step(st: DictState, n = 1): void {
    if (!st.size1) return;
    st.steps -= n;
    if (st.steps > 0) return;
    st.size0 = st.size1;
    st.size1 = 0;
    st.steps = 0;
  }

  private static add(st: DictState, kind: DictKind): void {
    MemoryDictModel.step(st, 1 + MemoryDictModel.ADD_EXTRA[kind]);
    if (!st.size1) {
      if (st.size0 === 0) st.size0 = MemoryDictModel.INITIAL_SIZE;
      else if (st.used >= st.size0) MemoryDictModel.startRehash(st, MemoryDictModel.tableFor(st.used + 1));
    }
    // while rehashing, new entries go to the new table
    if (st.size1) st.added++;
    st.used++;
  }

  private static remove(st: DictState, kind: DictKind): void {
    MemoryDictModel.step(st);
    st.used = Math.max(0, st.used - 1);
    if (MemoryDictModel.SHRINK_ON_DELETE.has(kind)) MemoryDictModel.shrinkIfNeeded(st);
  }

  /** htNeedsResize + dictResize: a table under 10 % full shrinks to the next power of two ≥ its entries. */
  private static shrinkIfNeeded(st: DictState): void {
    const { size0, used } = st;
    if (st.size1 || size0 <= MemoryDictModel.INITIAL_SIZE) return;
    if ((used * 100) / size0 < MemoryDictModel.MIN_FILL) MemoryDictModel.startRehash(st, MemoryDictModel.tableFor(Math.max(used, MemoryDictModel.INITIAL_SIZE)));
  }

  /** `accesses` dict operations in all: the inserts / deletes (the size difference), the rest lookups. */
  private static replay(st: DictState, size: number, kind: DictKind, accesses: number, removeCost = 1): void {
    let diff = size - st.used;
    // the lookups come first (a command finds its key / member before inserting or deleting it)
    const lookups = Math.max(0, accesses - (diff > 0 ? diff : -diff * removeCost));
    if (lookups) MemoryDictModel.step(st, lookups);
    for (; diff > 0; diff--) MemoryDictModel.add(st, kind);
    for (; diff < 0; diff++) MemoryDictModel.remove(st, kind);
    st.used = size;
  }

  /** A dict built by dictExpand(n) then filled (conversion, load, copy). */
  private static preallocated(n: number): DictState {
    return { size0: MemoryDictModel.tableFor(n), size1: 0, steps: 0, used: n, stepsTotal: 0, usedAtStart: 0, added: 0 };
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** What a command's key held before it ran (see `afterCommand`). */
  static snapshot(container: object | undefined, size: number, hashtable: boolean): DictSnapshot {
    return { container, size, hashtable };
  }

  /**
   * Replays a command on the dict of `container` (now `size` entries, `hashtable` encoded): the entries it inserted
   * or deleted (the size difference) and `accesses` dict operations in all. A dict met for the first time was
   * either converted from a compact encoding at `convertAt` entries (preallocated), or, when it was already a hash
   * table nobody tracked (loaded, restored, copied), preallocated to its size. Returns true when its slot count
   * changed.
   */
  static afterCommand(
    before: DictSnapshot,
    container: object | undefined,
    size: number,
    hashtable: boolean,
    kind: DictKind,
    accesses: number,
    convertAt: (beforeSize: number) => number,
  ): boolean {
    const S = MemoryDictModel.states;
    if (!container || !hashtable) {
      if (container) S.delete(container);
      return false;
    }
    let st = S.get(container);
    const slotsBefore = st ? st.size0 + st.size1 : -1;
    if (!st) {
      const same = before.container === container;
      if (same && before.hashtable) st = MemoryDictModel.preallocated(before.size);
      else {
        // the entries written before the conversion went to the compact encoding: no dict work
        const from = same ? before.size : 0;
        const at = Math.min(size, convertAt(from));
        st = MemoryDictModel.preallocated(at);
        accesses = Math.max(0, accesses - Math.max(0, at - from));
      }
      S.set(container, st);
    }
    MemoryDictModel.replay(st, size, kind, accesses);
    return st.size0 + st.size1 !== slotsBefore;
  }

  /**
   * A dict that starts empty and is kept in step by its owner (the keyspace dicts, the script and function dicts):
   * replays the inserts / deletes since the last call and the lookups among its `accesses` dict operations (a delete
   * counting as `removeCost` of them).
   */
  static sync(container: object, size: number, kind: DictKind, accesses = 0, removeCost = 1): void {
    let st = MemoryDictModel.states.get(container);
    if (!st) {
      st = MemoryDictModel.preallocated(0);
      MemoryDictModel.states.set(container, st);
    }
    MemoryDictModel.replay(st, size, kind, accesses, removeCost);
  }

  /** serverCron on a keyspace dict: shrink a mostly empty table, then (activerehashing) finish a running rehash. */
  static cron(container: object, activeRehashing: boolean): void {
    const st = MemoryDictModel.states.get(container);
    if (!st) return;
    MemoryDictModel.shrinkIfNeeded(st);
    if (activeRehashing) MemoryDictModel.step(st, MemoryDictModel.ACTIVE_REHASH_STEPS);
  }

  /** Bucket slots of the dict (both tables while rehashing); untracked dicts are preallocated to `used`. */
  static slots(container: object, used: number): number {
    const st = MemoryDictModel.states.get(container);
    return st ? st.size0 + st.size1 : MemoryDictModel.tableFor(used);
  }

  /** Table sizes (DEBUG HTSTATS / HTSTATS-KEY); `rehashed`: entries already moved to the new table (estimated). */
  static tables(container: object, used: number): DictTables & { rehashed: number } {
    const st = MemoryDictModel.states.get(container);
    if (!st) return { size0: MemoryDictModel.tableFor(used), size1: 0, rehashed: 0 };
    if (!st.size1) return { size0: st.size0, size1: 0, rehashed: 0 };
    const moved = Math.round(st.usedAtStart * (1 - st.steps / Math.max(1, st.stepsTotal)));
    return { size0: st.size0, size1: st.size1, rehashed: Math.min(st.used, moved + st.added) };
  }
}
