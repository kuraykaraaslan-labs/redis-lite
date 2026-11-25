import { AppError } from '@/libs/app-error';
import { RespMessages } from '@/libs/resp/messages';

const INTEGER_RE = /^-?(0|[1-9]\d*)$/;

/** Strict Redis integer argument (no spaces, no `+`, no leading zeros), within JS safe-integer range. */
export function parseInteger(value: string, message: string = RespMessages.NOT_INTEGER): number {
  if (!INTEGER_RE.test(value)) throw new AppError(message);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new AppError(message);
  return n;
}

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

/** Strict Redis int64 (string2ll rules): no '+', no leading zeros, no spaces, within [-2^63, 2^63-1]. */
export function parseInt64(value: string, message: string = RespMessages.NOT_INTEGER): bigint {
  if (!INTEGER_RE.test(value) || value.length > 20) throw new AppError(message);
  const n = BigInt(value);
  if (n < INT64_MIN || n > INT64_MAX) throw new AppError(message);
  return n;
}

export function isInt64(value: string): boolean {
  if (!INTEGER_RE.test(value) || value.length > 20) return false;
  const n = BigInt(value);
  return n >= INT64_MIN && n <= INT64_MAX;
}

/** An int64 as a reply: a JS number when exact, otherwise a bigint. */
export function intReply(n: bigint): number | bigint {
  return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

export function isInteger(value: string): boolean {
  return INTEGER_RE.test(value) && Number.isSafeInteger(Number(value));
}

/** Redis float argument: decimal, exponent, `inf`/`+inf`/`-inf`; NaN is rejected. */
export function parseFloatArg(value: string, message: string = RespMessages.NOT_FLOAT): number {
  const n = toFloat(value);
  if (n === null) throw new AppError(message);
  return n;
}

export function toFloat(value: string): number | null {
  const lower = value.toLowerCase();
  if (lower === 'inf' || lower === '+inf' || lower === 'infinity' || lower === '+infinity') return Infinity;
  if (lower === '-inf' || lower === '-infinity') return -Infinity;
  if (value.length === 0 || /\s/.test(value)) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return n;
}

/** Float in a reply: shortest round-trip form, `inf`/`-inf` as Redis writes them. */
export function formatFloat(n: number): string {
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  if (Object.is(n, -0)) return '0';
  return String(n);
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
