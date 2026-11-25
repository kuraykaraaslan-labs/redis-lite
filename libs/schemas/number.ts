import { z } from 'zod';

import { isInt64, isInteger, toFloat } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';

/** Strict Redis integer (no spaces, `+` or leading zeros) within the JS safe-integer range → number. */
export const IntegerSchema = z
  .string()
  .refine(isInteger, { error: RespMessages.NOT_INTEGER })
  .transform((value) => Number(value));

/** Strict Redis int64 (string2ll rules) within [-2^63, 2^63-1] → bigint. */
export const Int64Schema = z
  .string()
  .refine(isInt64, { error: RespMessages.NOT_INTEGER })
  .transform((value) => BigInt(value));

/** Redis float: decimal, exponent, `inf` / `+inf` / `-inf`; NaN is rejected → number. */
export const FloatSchema = z
  .string()
  .refine((value) => toFloat(value) !== null, { error: RespMessages.NOT_FLOAT })
  .transform((value) => toFloat(value) as number);
