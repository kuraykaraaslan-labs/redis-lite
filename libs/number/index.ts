/**
 * Pure Redis number helpers: recognising integers and floats the way Redis reads them, int64 bounds, reply formatting
 * and range normalisation. No error replies: argument grammar is in the DTOs (`@/libs/schemas`), and a service that
 * finds a stored value unusable throws its own AppError.
 */

/** string2ll's accepted forms: no '+', no leading zeros, no "-0". */
const INTEGER_RE = /^(0|-?[1-9]\d*)$/;

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

/** The largest SCAN cursor (an unsigned 64-bit integer). */
const UINT64_MAX = 2n ** 64n - 1n;

/** Strict Redis int64 (string2ll rules): no '+', no leading zeros, no spaces, within [-2^63, 2^63-1]. */
export function isInt64(value: string): boolean {
  if (!INTEGER_RE.test(value) || value.length > 20) return false;
  const n = BigInt(value);
  return n >= INT64_MIN && n <= INT64_MAX;
}

/** An int64 as a reply: a JS number when exact, otherwise a bigint. */
export function intReply(n: bigint): number | bigint {
  return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

/** The sum `addInt64` computed (a number when it is a safe integer, else a bigint), or why there is none. */
export type Int64Sum = number | bigint | 'not-integer' | 'overflow';

/** Longest decimal text (sign included) that is always a safe integer: 15 characters stay below 10^15 < 2^53. */
const SAFE_DIGITS = 15;
const SAFE_DELTA = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * INCRBY / HINCRBY: `stored` (an int64 as text; undefined = 0) plus `delta`. `not-integer` when `stored` is not a
 * strict int64, `overflow` when the sum leaves the int64 range. Small counters take a float64 fast path (exact: both
 * operands and the sum are checked to be safe integers); anything else is computed with bigints.
 */
export function addInt64(stored: string | undefined, delta: bigint): Int64Sum {
  if (stored === undefined || (stored.length <= SAFE_DIGITS && INTEGER_RE.test(stored))) {
    if (delta <= SAFE_DELTA && delta >= -SAFE_DELTA) {
      const sum = (stored === undefined ? 0 : Number(stored)) + Number(delta);
      if (Number.isSafeInteger(sum)) return sum;
    }
  } else if (!isInt64(stored)) return 'not-integer';
  const result = (stored === undefined ? 0n : BigInt(stored)) + delta;
  if (result < INT64_MIN || result > INT64_MAX) return 'overflow';
  return intReply(result);
}

/** Strict Redis integer (no spaces, no `+`, no leading zeros) within the JS safe-integer range. */
export function isInteger(value: string): boolean {
  return INTEGER_RE.test(value) && Number.isSafeInteger(Number(value));
}

/** Redis float: decimal, exponent, `inf`/`+inf`/`-inf` → number; NaN or anything else → null. */
export function toFloat(value: string): number | null {
  const lower = value.toLowerCase();
  if (lower === 'inf' || lower === '+inf' || lower === 'infinity' || lower === '+infinity') return Infinity;
  if (lower === '-inf' || lower === '-infinity') return -Infinity;
  if (value.length === 0 || /\s/.test(value)) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return n;
}

/**
 * A SCAN cursor read like strtoul (base 10) with Redis's checks → number, or null when Redis answers `invalid cursor`:
 * an optional sign, digits only (no spaces), at most 2^64-1 in magnitude; a negative cursor wraps modulo 2^64 and an
 * empty one is 0. Cursors past 2^53 lose precision, which no cursor this server hands out ever needs.
 */
export function parseScanCursor(raw: string): number | null {
  if (raw === '') return 0;
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const magnitude = BigInt(raw[0] === '-' || raw[0] === '+' ? raw.slice(1) : raw);
  if (magnitude > UINT64_MAX) return null;
  return Number(raw[0] === '-' && magnitude > 0n ? UINT64_MAX + 1n - magnitude : magnitude);
}

/** 2^62: the largest magnitude a sorted set score is stored as an integer in a listpack. */
const LISTPACK_INT_SCORE_MAX = 2 ** 62;

/**
 * A sorted set score as a listpack stores it (what ZSCAN of a listpack sorted set returns): an integral score within
 * ±2^62 as an integer, anything else as C `%.17g`, `inf` / `-inf` as Redis writes them.
 */
export function formatFloat(n: number): string {
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  if (Number.isInteger(n) && Math.abs(n) <= LISTPACK_INT_SCORE_MAX) return BigInt(n).toString();
  return formatG17(n);
}

/** C `%.17g`: 17 significant digits, trailing zeros dropped, exponent form below 1e-4 and from 1e17. */
export function formatG17(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  if (n === 0) return Object.is(n, -0) ? '-0' : '0';
  const [mantissa, exponent] = n.toExponential(16).split('e');
  const e = Number(exponent);
  if (e < -4 || e >= 17) return `${stripZeros(mantissa)}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  return stripZeros(n.toFixed(16 - e));
}

/** C `%.<digits>f`: like toFixed, except that an exact tie rounds to even (as printf does), not up. */
export function formatFixed(n: number, digits: number): string {
  const scale = 10 ** digits;
  const twice = n * scale * 2;
  if (!Number.isInteger(twice) || Math.abs(twice) % 2 !== 1 || !Number.isSafeInteger(twice)) return n.toFixed(digits);
  const down = (twice - 1) / 2;
  const v = down % 2 === 0 ? down : down + 1;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const int = Math.floor(abs / scale);
  return digits === 0 ? `${sign}${int}` : `${sign}${int}.${String(abs % scale).padStart(digits, '0')}`;
}

/** Drops the trailing zeros of a fraction (and the point when nothing is left), as `%g` does. */
function stripZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** Normalizes a Redis range (negative = from the end) to [start, stop] inclusive, or null if empty. */
export function normalizeRange(start: number, stop: number, length: number): [number, number] | null {
  let s = start < 0 ? length + start : start;
  let e = stop < 0 ? length + stop : stop;
  if (s < 0) s = 0;
  if (e >= length) e = length - 1;
  if (s > e || s >= length) return null;
  return [s, e];
}
