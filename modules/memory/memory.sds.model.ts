// Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
import MemoryAllocModel from './memory.alloc.model';
import type { SdsAlloc, SdsType, StringValue } from './memory.types';

/**
 * The allocation behind a raw string value in Redis 7.0, as MEMORY USAGE reveals it: a fresh sds keeps the whole
 * usable size as capacity (sdshdr5 has none), a SET argument / loaded value is trimmed when its spare room exceeds a
 * tenth of its length, and an in-place growth (APPEND, SETRANGE, SETBIT, BITFIELD, sparse HLL updates) preallocates
 * greedily: twice the needed length below 1 MB, the needed length + 1 MB above.
 */
export default class MemorySdsModel {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Longest string kept embstr-encoded. */
  static readonly EMBSTR_MAX = 44;

  /** Greedy preallocation switches from doubling to + this many bytes. */
  private static readonly MAX_PREALLOC = 1024 * 1024;

  private static readonly TYPE_MAX: Readonly<Record<SdsType, number>> = { 5: 31, 8: 255, 16: 65535, 32: 2 ** 32 - 1, 64: Number.MAX_SAFE_INTEGER };

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** An allocation of header type `type` sized for `len` bytes, whose capacity is the whole usable size. */
  private static usable(type: SdsType, len: number): SdsAlloc {
    const hdr = MemoryAllocModel.sdsHdrSize(type);
    const size = MemoryAllocModel.jemallocSize(hdr + len + 1);
    return { size, cap: type === 5 ? len : Math.min(size - hdr - 1, MemorySdsModel.TYPE_MAX[type]) };
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** A fresh sds of `len` bytes (sdsnewlen): an exact request whose capacity is the usable size. */
  static fresh(len: number): SdsAlloc {
    const type = MemoryAllocModel.sdsReqType(len);
    return MemorySdsModel.usable(type === 5 && len === 0 ? 8 : type, len);
  }

  /**
   * A raw value created from a command argument or loaded from RDB: the argument's sds (the query buffer itself for a
   * big argument), trimmed to its length when the spare room exceeds len / 10.
   */
  static argument(len: number, fromBigArg = true): SdsAlloc {
    const M = MemoryAllocModel;
    let alloc = MemorySdsModel.fresh(len);
    if (fromBigArg && len >= M.SIZES.bigArg) {
      const hdr = M.sdsHdrSize(M.sdsReqType(len + 2));
      const size = M.jemallocSize(hdr + len + 3);
      alloc = { size, cap: size - hdr - 1 };
    }
    if (alloc.cap - len > Math.floor(len / 10)) return { size: M.sdsAllocSize(len), cap: len };
    return alloc;
  }

  /** sdsMakeRoomFor (greedy): `cur` (holding `len` bytes) with room for `addlen` more. */
  static makeRoom(cur: SdsAlloc, len: number, addlen: number): SdsAlloc {
    if (cur.cap - len >= addlen) return cur;
    let newlen = len + addlen;
    newlen = newlen < MemorySdsModel.MAX_PREALLOC ? newlen * 2 : newlen + MemorySdsModel.MAX_PREALLOC;
    const type = MemoryAllocModel.sdsReqType(newlen);
    return MemorySdsModel.usable(type === 5 ? 8 : type, newlen);
  }

  /** The allocation of a string value; an embstr / int value gives the raw copy a write unshares it into. */
  static of(v: StringValue): SdsAlloc {
    if (v.sds) return v.sds;
    const len = v.value.length;
    if (v.raw || len <= MemorySdsModel.EMBSTR_MAX) return MemorySdsModel.fresh(len);
    return MemorySdsModel.argument(len);
  }

  /**
   * The allocation after an in-place write grew the value to `newLen` bytes: a missing key gets a fresh sds of that
   * length, an existing one is unshared (embstr / int) and grown greedily when it lacks room.
   */
  static modified(prev: StringValue | undefined, newLen: number): SdsAlloc {
    if (!prev) return MemorySdsModel.fresh(newLen);
    const cur = MemorySdsModel.of(prev);
    const len = prev.value.length;
    return newLen > len ? MemorySdsModel.makeRoom(cur, len, newLen - len) : cur;
  }
}
