import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';

import type { CommandContext } from '@/modules/command/command.types';

import type { BitOpInput } from './bitmaps.dto';
import type { BitOp } from './bitmaps.enums';
import BitmapsMessages from './bitmaps.messages';
import BitmapStore from './bitmaps.structure';

/** BITOP: bitwise operations between strings, shorter ones padded with zero bytes. */
export default class BitmapsOpService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** One result byte from the first source's byte `x` and the other sources' bytes `rest`. */
  private static combine(operation: BitOp, x: number, rest: number[]): number {
    const anyRest = rest.reduce((acc, b) => acc | b, 0);
    switch (operation) {
      case 'not':
        return ~x & 0xff;
      case 'and':
        return rest.reduce((acc, b) => acc & b, x);
      case 'or':
        return x | anyRest;
      case 'xor':
        return rest.reduce((acc, b) => acc ^ b, x);
      case 'diff': // bits of the first key set in none of the others
        return x & ~anyRest & 0xff;
      case 'diff1': // bits set in one of the others but not in the first key
        return ~x & anyRest & 0xff;
      case 'andor': // bits of the first key set in at least one of the others
        return x & anyRest;
      case 'one': {
        // bits set in exactly one source key
        let ones = 0;
        let twos = 0;
        for (const b of [x, ...rest]) {
          twos |= ones & b;
          ones ^= b;
        }
        return ones & ~twos & 0xff;
      }
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /**
   * BITOP: the destination's new length (an empty result deletes it). The sources are read (WRONGTYPE) before their
   * number is checked, as in Redis.
   */
  static bitOp(ctx: CommandContext, { operation, destination, sources: keys }: BitOpInput): number {
    const sources = keys.map((k) => BitmapStore.read(ctx, k));
    if (operation === 'not' && sources.length !== 1) throw new AppError(BitmapsMessages.BITOP_NOT_SINGLE);
    if ((operation === 'diff' || operation === 'diff1' || operation === 'andor') && sources.length < 2) {
      throw new AppError(formatMessage(BitmapsMessages.BITOP_TWO_SOURCES, { operation: operation.toUpperCase() }));
    }
    const len = Math.max(0, ...sources.map((s) => s.length));
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = BitmapsOpService.combine(operation, sources[0][i] ?? 0, sources.slice(1).map((s) => s[i] ?? 0));
    }
    if (out.length) BitmapStore.write(ctx, destination, out);
    else ctx.db.remove(destination);
    return out.length;
  }
}
