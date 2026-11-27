import { RespError } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { BitCountInput, BitPosBitInput, BitPosInput, GetBitInput, SetBitInput } from './bitmaps.dto';
import BitmapStore from './bitmaps.structure';
import type { BitRangeArgs } from './bitmaps.types';

/** Single bits and bit ranges: GETBIT, SETBIT, BITCOUNT, BITPOS. */
export default class BitmapsBitService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static popcount(b: number): number {
    let n = 0;
    for (let x = b; x; x &= x - 1) n++;
    return n;
  }

  /**
   * Resolves a range given in bytes or bits (negative = from the end) to inclusive bit bounds; null when empty. No
   * range = the whole string; a null end = from `start` byte to the end of the string (BITPOS key bit start). Like
   * Redis 7.0, a negative bound still negative once the length is added is 0 (the end too: the first byte or bit).
   */
  private static resolveRange(totalBytes: number, range: BitRangeArgs | null): [number, number] | null {
    if (!range) return totalBytes ? [0, totalBytes * 8 - 1] : null;
    if (range.end === null) {
      const start = range.start < 0 ? Math.max(0, totalBytes + range.start) : range.start;
      if (start >= totalBytes) return null;
      return [start * 8, totalBytes * 8 - 1];
    }
    let { start, end } = range;
    const total = range.unit === 'bit' ? totalBytes * 8 : totalBytes;
    if (start < 0) start = Math.max(0, total + start);
    if (end < 0) end = Math.max(0, total + end);
    if (end >= total) end = total - 1;
    if (start > end || total === 0) return null;
    return range.unit === 'bit' ? [start, end] : [start * 8, end * 8 + 7];
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** GETBIT on the bytes read before the offset was parsed (WRONGTYPE beats a bad offset). */
  static getBit(ctx: CommandContext, bytes: Uint8Array, { offset }: GetBitInput): number {
    BitmapStore.checkOffset(ctx, offset);
    return BitmapStore.getBit(bytes, offset);
  }

  /** SETBIT: the previous bit. The offset limit is checked before the bit value, as in Redis. */
  static setBit(ctx: CommandContext, { key, offset, bit, issue }: SetBitInput): Reply {
    BitmapStore.checkOffset(ctx, offset);
    if (issue !== null) return new RespError(issue);
    const bytes = BitmapStore.read(ctx, key);
    const old = BitmapStore.getBit(bytes, offset);
    BitmapStore.write(ctx, key, BitmapStore.setBit(bytes, offset, bit));
    return old;
  }

  /** BITCOUNT on the bytes read before the range was parsed. */
  static bitCount(bytes: Uint8Array, { range }: BitCountInput): number {
    const r = BitmapsBitService.resolveRange(bytes.length, range);
    if (!r) return 0;
    let n = 0;
    for (let bit = r[0]; bit <= r[1]; ) {
      if ((bit & 7) === 0 && bit + 7 <= r[1]) {
        n += BitmapsBitService.popcount(bytes[bit >>> 3]);
        bit += 8;
      } else {
        n += BitmapStore.getBit(bytes, bit);
        bit++;
      }
    }
    return n;
  }

  /** BITPOS on a missing key: no set bit, and the first clear bit is bit 0. The range is not parsed. */
  static bitPosMissing({ bit }: BitPosBitInput): number {
    return bit ? -1 : 0;
  }

  /** BITPOS: the first bit equal to `bit` in the range, -1 when none. */
  static bitPos(bytes: Uint8Array, { bit, range, explicitEnd }: BitPosInput): number {
    const r = BitmapsBitService.resolveRange(bytes.length, range);
    if (!r) return -1;
    for (let i = r[0]; i <= r[1]; i++) if (BitmapStore.getBit(bytes, i) === bit) return i;
    // Looking for a clear bit with no explicit end: the string is treated as padded with zeros on the right.
    return bit === 0 && !explicitEnd ? r[1] + 1 : -1;
  }
}
