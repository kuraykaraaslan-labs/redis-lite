import { z } from 'zod';

import { parseLongDouble } from '@/libs/number/long-double';
import { RespMessages } from '@/libs/resp/messages';

import { reject } from './issue';

const INT64_LIMIT = 1n << 63n;
const MANTISSA_BITS = 64;

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

/**
 * Seconds → milliseconds the way Redis computes it: the long double timeout times 1000, rounded once to the 64-bit
 * significand, then made an integer. A positive fraction of a millisecond still waits (at least 1 ms); a negative one
 * truncates to 0 (wait forever). null when the result does not fit a long long (Redis then sees a negative timeout).
 */
function toMilliseconds(neg: boolean, m: bigint, e: number): bigint | null {
  let p = m * 1000n;
  let exp = e;
  const extra = bitLength(p) - MANTISSA_BITS;
  if (extra > 0) {
    const shift = BigInt(extra);
    let q = p >> shift;
    const rest = p - (q << shift);
    const half = 1n << (shift - 1n);
    if (rest > half || (rest === half && (q & 1n) === 1n)) q++;
    p = q;
    exp += extra;
  }
  let whole: bigint;
  let fraction = false;
  if (exp >= 0) whole = exp > 128 ? INT64_LIMIT : p << BigInt(exp);
  else if (-exp >= bitLength(p)) {
    whole = 0n;
    fraction = p !== 0n;
  } else {
    whole = p >> BigInt(-exp);
    fraction = whole << BigInt(-exp) !== p;
  }
  if (!neg && fraction) whole++;
  if (whole >= INT64_LIMIT) return null;
  return neg ? -whole : whole;
}

/**
 * The timeout of a blocking command in seconds (BLPOP, BLMOVE, BZPOPMIN, BLMPOP…) → milliseconds, 0 = wait forever.
 * Read like Redis: the strtold grammar (`parseLongDouble`: hex, exponents, `inf`; NaN, spaces and out-of-range texts
 * are `ERR timeout is not a float…`), times 1000 in long double precision, then converted to a long long. A value that
 * converts below zero, an infinity, or one past the long long range is `ERR timeout is negative` (the conversion of an
 * out-of-range value yields LLONG_MIN). A negative value above -1 ms converts to 0, so it waits forever, as in Redis.
 */
export const BlockSecondsTimeoutSchema = z.string().transform((raw, ctx) => {
  const seconds = parseLongDouble(raw);
  if (seconds === null) return reject(ctx, RespMessages.TIMEOUT_NOT_FLOAT);
  if (seconds.inf) return reject(ctx, RespMessages.TIMEOUT_NEGATIVE);
  const ms = toMilliseconds(seconds.neg, seconds.m, seconds.e);
  if (ms === null || ms < 0n) return reject(ctx, RespMessages.TIMEOUT_NEGATIVE);
  return Number(ms);
});
