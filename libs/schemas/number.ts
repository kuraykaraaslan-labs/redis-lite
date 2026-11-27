import { z } from 'zod';

import { isInt64, toFloat } from '@/libs/number';
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
 * Strict Redis int64 (string2ll rules: no spaces, `+` or leading zeros; within [-2^63, 2^63-1]) → number, whose failure
 * reports `message` (commands that word the error themselves: SWAPDB's index, XCLAIM's IDLE, CLIENT KILL's ID…).
 * Beyond ±2^53 the number is the nearest double: right wherever the value is only compared with a length or clamped;
 * an argument whose exact value matters takes `Int64Schema` (bigint).
 */
export function IntegerSchemaWith(message: string) {
  return z.string().transform((value, ctx) => {
    const n = shortInteger(value);
    if (n !== null) return n;
    return isInt64(value) ? Number(value) : reject(ctx, message);
  });
}

const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;

/**
 * A C `int` argument: an int64 first (else `message`), then within the int range (else `rangeMessage`) → number.
 * SWAPDB words both failures itself; SELECT, MOVE and COPY DB take `IntSchema`.
 */
export function IntSchemaWith(message: string, rangeMessage: string) {
  return z.string().transform((value, ctx) => {
    const n = shortInteger(value) ?? (isInt64(value) ? Number(value) : reject(ctx, message));
    return n < INT_MIN || n > INT_MAX ? reject(ctx, rangeMessage) : n;
  });
}

/** A C `int` argument: `ERR value is not an integer…`, then `ERR value is out of range, value must between …`. */
export const IntSchema = IntSchemaWith(RespMessages.NOT_INTEGER, RespMessages.INT_RANGE);

/** Redis float (decimal, exponent, `inf` / `+inf` / `-inf`; NaN rejected) → number, whose failure reports `message`. */
export function FloatSchemaWith(message: string) {
  return z.string().transform((value, ctx) => {
    const n = toFloat(value);
    return n === null ? reject(ctx, message) : n;
  });
}

/** Strict Redis int64 → number (`ERR value is not an integer or out of range`); see `IntegerSchemaWith`. */
export const IntegerSchema = IntegerSchemaWith(RespMessages.NOT_INTEGER);

/** Strict Redis int64 (string2ll rules) within [-2^63, 2^63-1] → bigint. */
export const Int64Schema = z.string().transform((value, ctx) => {
  const n = shortInteger(value);
  if (n !== null) return BigInt(n);
  return isInt64(value) ? BigInt(value) : reject(ctx, RespMessages.NOT_INTEGER);
});

/** Redis float → number (`ERR value is not a valid float`). */
export const FloatSchema = FloatSchemaWith(RespMessages.NOT_FLOAT);
