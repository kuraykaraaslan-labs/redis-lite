import { intReply } from '@/libs/number';
import { RespError } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { BitfieldInput } from './bitmaps.dto';
import type { OverflowPolicy } from './bitmaps.enums';
import BitmapStore from './bitmaps.structure';
import type { FieldType } from './bitmaps.types';

/** BITFIELD / BITFIELD_RO: integers of arbitrary width at arbitrary bit offsets. */
export default class BitmapsFieldService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static readField(bytes: Uint8Array, offset: number, t: FieldType): bigint {
    let v = 0n;
    for (let i = 0; i < t.bits; i++) v = (v << 1n) | BigInt(BitmapStore.getBit(bytes, offset + i));
    if (t.signed && v >> BigInt(t.bits - 1)) v -= 1n << BigInt(t.bits);
    return v;
  }

  /** Writes the field, growing the bytes first; returns the (possibly new) bytes. */
  private static writeField(bytes: Uint8Array, offset: number, t: FieldType, value: bigint): Uint8Array {
    let out = BitmapStore.grow(bytes, Math.floor((offset + t.bits - 1) / 8) + 1);
    let v = BigInt.asUintN(t.bits, value);
    for (let i = t.bits - 1; i >= 0; i--) {
      out = BitmapStore.setBit(out, offset + i, Number(v & 1n));
      v >>= 1n;
    }
    return out;
  }

  /** Applies the overflow policy; null when FAIL rejects the value. */
  private static overflow(value: bigint, t: FieldType, policy: OverflowPolicy): bigint | null {
    const min = t.signed ? -(1n << BigInt(t.bits - 1)) : 0n;
    const max = t.signed ? (1n << BigInt(t.bits - 1)) - 1n : (1n << BigInt(t.bits)) - 1n;
    if (value >= min && value <= max) return value;
    if (policy === 'fail') return null;
    if (policy === 'sat') return value < min ? min : max;
    return t.signed ? BigInt.asIntN(t.bits, value) : BigInt.asUintN(t.bits, value);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /**
   * BITFIELD on the bytes read before the subcommands were parsed: one reply per GET / SET / INCRBY (SET answers the
   * old value, INCRBY the new one, nil when OVERFLOW FAIL refuses it). Nothing is stored when an error is met.
   */
  static bitfield(ctx: CommandContext, read: Uint8Array, { key, steps, issue }: BitfieldInput): Reply {
    let bytes = read;
    const out: Reply[] = [];
    let dirty = false;
    for (const { op, type, offset, value, policy } of steps) {
      BitmapStore.checkOffset(ctx, offset);
      if (op === 'get') {
        out.push(intReply(BitmapsFieldService.readField(bytes, offset, type)));
        continue;
      }
      const arg = value as bigint;
      const old = BitmapsFieldService.readField(bytes, offset, type);
      const next = BitmapsFieldService.overflow(op === 'set' ? arg : old + arg, type, policy);
      if (next === null) {
        out.push(null);
        continue;
      }
      bytes = BitmapsFieldService.writeField(bytes, offset, type, next);
      dirty = true;
      out.push(intReply(op === 'set' ? old : next));
    }
    if (issue !== null) {
      if (issue.offset !== null) BitmapStore.checkOffset(ctx, issue.offset);
      return new RespError(issue.message);
    }
    if (dirty) BitmapStore.write(ctx, key, bytes);
    return out;
  }
}
