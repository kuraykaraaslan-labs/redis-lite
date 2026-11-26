/**
 * The C library's strtod as Redis's SORT reads weights with it, reproduced from observed behaviour: leading white space
 * skipped, decimal or hexadecimal (`0x…p…`) forms, `inf` / `infinity`, `nan` (refused here), and the conversion
 * stopping at a NUL byte. `ERANGE` is raised on overflow and on an inexact result in the subnormal range (exact
 * subnormals such as 0x1p-1074 are fine).
 */

const SPACE_RE = /^[ \t\n\v\f\r]*/;
const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const HEX_RE = /^([+-]?)0[xX]([0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP]([+-]?\d+))?/;
const SPECIAL_RE = /^[+-]?(?:infinity|inf|nan(?:\([0-9A-Za-z_]*\))?)/i;

const MIN_NORMAL = 2.2250738585072014e-308;

/** The double `x` (finite, non-zero) as m × 2^k with integers m, k. */
function dyadic(x: number): [bigint, number] {
  let k = 0;
  let m = Math.abs(x);
  while (!Number.isInteger(m)) {
    m *= 2;
    k--;
  }
  return [BigInt(m), k];
}

/**
 * glibc's underflow rule: ERANGE when the result is tiny and inexact. Tiny is judged after rounding: the exact value
 * num / den (positive) rounded to 53 bits with an unbounded exponent is below 2^-1022 (so a value just under 2^-1022
 * that rounds up to it is not tiny). Inexact: `x`, the double actually produced, differs from num / den. Only called
 * for small non-zero results, so the bigints stay small.
 */
function tinyAndInexact(num: bigint, den: bigint, x: number): boolean {
  if (num << 1022n >= den) return false;
  // in [2^-1023, 2^-1022) the 53-bit grid step is 2^-1075: does the value round up to 2^-1022?
  const scaled = num << 1075n;
  const q = scaled / den;
  if (q >= 1n << 52n) {
    const twice = (scaled - q * den) * 2n;
    const up = twice > den || (twice === den && (q & 1n) === 1n);
    if (up && q + 1n === 1n << 53n) return false;
  }
  const [m, k] = dyadic(x);
  // num / den = m × 2^k  ⇔  num × 2^-k = m × den (k < 0 here)
  return num << BigInt(-k) !== m * den;
}

/** The decimal text (sign stripped) as digits × 10^exp. */
function decimalParts(text: string): [string, number] {
  const [mantissa, e = '0'] = text.replace(/^[+-]/, '').split(/[eE]/);
  const [int, frac = ''] = mantissa.split('.');
  return [`${int}${frac}`.replace(/^0+(?=\d)/, '') || '0', Number(e) - frac.length];
}

function parseHex(sign: string, body: string, exp: string | undefined): number {
  const [int, frac = ''] = body.split('.');
  const mantissa = BigInt(`0x${int || '0'}${frac}`);
  const shift = Math.max(-1e6, Math.min(1e6, Number(exp ?? '0'))) - 4 * frac.length;
  // scale in two steps so a huge mantissa with a very negative exponent does not overflow to infinity first
  const value = Number(mantissa) * 2 ** Math.max(shift, -1000) * 2 ** Math.min(shift + 1000, 0);
  return sign === '-' ? -value : value;
}

/**
 * Redis SORT's weight conversion: strtod must consume the text up to its end (or a NUL byte), without ERANGE and
 * without a NaN. Returns the weight, or null for `One or more scores can't be converted into double`. An empty text
 * converts nothing and still ends at the NUL: it weighs 0.
 */
export function parseSortWeight(raw: string): number | null {
  const nul = raw.indexOf('\0');
  const text = nul >= 0 ? raw.slice(0, nul) : raw;
  if (text === '') return 0;
  const body = text.slice(SPACE_RE.exec(text)![0].length);
  const special = SPECIAL_RE.exec(body);
  if (special) {
    if (special[0].length !== body.length || /nan/i.test(special[0])) return null;
    return special[0].startsWith('-') ? -Infinity : Infinity;
  }
  const hex = HEX_RE.exec(body);
  if (hex) {
    if (hex[0].length !== body.length) return null;
    const value = parseHex(hex[1], hex[2], hex[3]);
    if (!Number.isFinite(value)) return null;
    if (Math.abs(value) <= MIN_NORMAL && /[1-9a-fA-F]/.test(hex[2])) {
      if (value === 0) return null;
      const [int, frac = ''] = hex[2].split('.');
      const shift = Number(hex[3] ?? '0') - 4 * frac.length;
      const mantissa = BigInt(`0x${int || '0'}${frac}`);
      const [num, den] = shift >= 0 ? [mantissa << BigInt(shift), 1n] : [mantissa, 1n << BigInt(-shift)];
      if (tinyAndInexact(num, den, value)) return null;
    }
    return value;
  }
  const dec = DECIMAL_RE.exec(body);
  if (!dec || dec[0].length !== body.length) return null;
  const value = Number(dec[0]);
  if (!Number.isFinite(value)) return null;
  const [digits, exp] = decimalParts(dec[0]);
  if (Math.abs(value) <= MIN_NORMAL && /[1-9]/.test(digits)) {
    if (value === 0) return null;
    const d = BigInt(digits);
    const [num, den] = exp >= 0 ? [d * 10n ** BigInt(exp), 1n] : [d, 10n ** BigInt(-exp)];
    if (tinyAndInexact(num, den, value)) return null;
  }
  return value;
}
