import { z } from 'zod';

import { isInt64, isInteger, toFloat } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';

/**
 * Strict Redis integer (no spaces, `+` or leading zeros) within the JS safe-integer range → number, whose failure
 * reports `message` (commands that word the error themselves: SWAPDB's index, XCLAIM's IDLE, CLIENT KILL's ID…).
 */
export function IntegerSchemaWith(message: string) {
  return z
    .string()
    .refine(isInteger, { error: message })
    .transform((value) => Number(value));
}

/** Redis float (decimal, exponent, `inf` / `+inf` / `-inf`; NaN rejected) → number, whose failure reports `message`. */
export function FloatSchemaWith(message: string) {
  return z
    .string()
    .refine((value) => toFloat(value) !== null, { error: message })
    .transform((value) => toFloat(value) as number);
}

/** Strict Redis integer within the JS safe-integer range → number (`ERR value is not an integer or out of range`). */
export const IntegerSchema = IntegerSchemaWith(RespMessages.NOT_INTEGER);

/** Strict Redis int64 (string2ll rules) within [-2^63, 2^63-1] → bigint. */
export const Int64Schema = z
  .string()
  .refine(isInt64, { error: RespMessages.NOT_INTEGER })
  .transform((value) => BigInt(value));

/** Redis float → number (`ERR value is not a valid float`). */
export const FloatSchema = FloatSchemaWith(RespMessages.NOT_FLOAT);
