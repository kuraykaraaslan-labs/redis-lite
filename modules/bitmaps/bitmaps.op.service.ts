import { AppError } from '@/libs/app-error';

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
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /**
   * BITOP: the destination's new length (an empty result deletes it). NOT's single source is checked before the
   * sources are read (WRONGTYPE), as in Redis 7.0.
   */
  static bitOp(ctx: CommandContext, { operation, destination, sources: keys }: BitOpInput): number {
    if (operation === 'not' && keys.length !== 1) throw new AppError(BitmapsMessages.BITOP_NOT_SINGLE);
    const sources = keys.map((k) => BitmapStore.read(ctx, k));
    const len = Math.max(0, ...sources.map((s) => s.length));
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = BitmapsOpService.combine(operation, sources[0][i] ?? 0, sources.slice(1).map((s) => s[i] ?? 0));
    }
    if (out.length) BitmapStore.write(ctx, destination, out, false);
    else ctx.db.remove(destination);
    return out.length;
  }
}
