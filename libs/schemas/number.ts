import { z } from 'zod';

import { isInt64, isInteger, toFloat } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';

import { reject } from './issue';

/**
 * The integer primitives parse in one transform step (no refine + transform pair) and read the common short arguments
 * (counters, indexes, counts) with a character scan instead of a regex and BigInt; anything longer, and anything the scan
 * refuses, goes through the full `@/libs/number` recognition, so what is accepted and every error text are unchanged.
 */

/** A strict Redis integer of at most 15 characters (always a safe integer); null when longer or not one. */
function shortInteger(value: string): number | null {
  const len = value.length;
  if (len === 0 || len > 15) return null;
  let i = 0;
  const negative = value.charCodeAt(0) === 45; /* - */
  if (negative && ++i === len) return null;
  // '0' only on its own: no leading zeros, no "-0"
  if (value.charCodeAt(i) === 48) return !negative && len === 1 ? 0 : null;
  let n = 0;
  for (; i < len; i++) {
    const digit = value.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return null;
    n = n * 10 + digit;
  }
  return negative ? -n : n;
}

/**
 * Strict Redis integer (no spaces, `+` or leading zeros) within the JS safe-integer range → number, whose failure
 * reports `message` (commands that word the error themselves: SWAPDB's index, XCLAIM's IDLE, CLIENT KILL's ID…).
 */
export function IntegerSchemaWith(message: string) {
  return z.string().transform((value, ctx) => {
    const n = shortInteger(value);
    if (n !== null) return n;
    return isInteger(value) ? Number(value) : reject(ctx, message);
  });
}

/** Redis float (decimal, exponent, `inf` / `+inf` / `-inf`; NaN rejected) → number, whose failure reports `message`. */
export function FloatSchemaWith(message: string) {
  return z.string().transform((value, ctx) => {
    const n = toFloat(value);
    return n === null ? reject(ctx, message) : n;
  });
}

/** Strict Redis integer within the JS safe-integer range → number (`ERR value is not an integer or out of range`). */
export const IntegerSchema = IntegerSchemaWith(RespMessages.NOT_INTEGER);

/** Strict Redis int64 (string2ll rules) within [-2^63, 2^63-1] → bigint. */
export const Int64Schema = z.string().transform((value, ctx) => {
  const n = shortInteger(value);
  if (n !== null) return BigInt(n);
  return isInt64(value) ? BigInt(value) : reject(ctx, RespMessages.NOT_INTEGER);
});

/** Redis float → number (`ERR value is not a valid float`). */
export const FloatSchema = FloatSchemaWith(RespMessages.NOT_FLOAT);
