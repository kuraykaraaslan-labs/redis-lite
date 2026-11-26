/**
 * An emulation of the x87 80-bit extended `long double` that Redis uses for INCRBYFLOAT and HINCRBYFLOAT: a 64-bit
 * significand (explicit integer bit), round-to-nearest-even, gradual underflow, and the text forms Redis reads and
 * writes. Built from the observable behaviour of a real server (black box): every value is an exact binary fraction
 * kept in bigints, every operation is computed exactly and then rounded once, so results match the hardware bit for bit.
 *
 * - Reading (`parseLongDouble`): the strtold grammar (decimal with optional exponent, hexadecimal with optional `p`
 *   exponent, `inf` / `infinity`), with Redis's extra checks: no leading space, the whole text consumed, at most
 *   5119 characters, NaN refused, a finite text that overflows or underflows to zero refused (subnormals are kept).
 * - Writing (`formatLongDouble`): printf `%.17Lf` (exact decimal expansion, ties to even), trailing zeros and a
 *   trailing dot removed, `-0` written `0`.
 */

/** A finite long double: (-1)^neg × m × 2^e, with m < 2^64 (m = 0 is a signed zero); or an infinity. */
export type LongDouble = { neg: boolean; m: bigint; e: number; inf?: false } | { neg: boolean; inf: true };

const MANTISSA_BITS = 64;
const TOP = 1n << BigInt(MANTISSA_BITS);
const HIDDEN = 1n << BigInt(MANTISSA_BITS - 1);
/** Exponent of the lowest significand bit of the smallest subnormal (2^-16445) and of the largest finite value. */
const E_MIN = -16445;
const E_MAX = 16383 - (MANTISSA_BITS - 1);
/** Redis refuses longer float texts (its conversion buffer is 5 KB). */
const MAX_TEXT = 5120;
/** Digits printed after the dot (`%.17Lf`). */
const FRACTION_DIGITS = 17;
const FRACTION_SCALE = 10n ** BigInt(FRACTION_DIGITS);

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const HEX_RE = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/;
const INF_RE = /^([+-]?)(?:inf|infinity)$/i;

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

function infinity(neg: boolean): LongDouble {
  return { neg, inf: true };
}

/**
 * Rounds the exact positive rational num / den × 2^e0 to a long double (ties to even, gradual underflow, overflow to
 * infinity). `num` = 0 gives a signed zero.
 */
function roundRational(neg: boolean, num: bigint, den: bigint, e0: number): LongDouble {
  if (num === 0n) return { neg, m: 0n, e: 0 };
  let e = Math.max(E_MIN, e0 + bitLength(num) - bitLength(den) - MANTISSA_BITS);
  for (;;) {
    const shift = e0 - e;
    const n = shift >= 0 ? num << BigInt(shift) : num;
    const d = shift >= 0 ? den : den << BigInt(-shift);
    let q = n / d;
    if (q >= TOP) {
      e++;
      continue;
    }
    if (q < HIDDEN && e > E_MIN) {
      e--;
      continue;
    }
    const twice = (n - q * d) * 2n;
    if (twice > d || (twice === d && (q & 1n) === 1n)) q++;
    if (q === TOP) {
      q = HIDDEN;
      e++;
    }
    return e > E_MAX ? infinity(neg) : { neg, m: q, e };
  }
}

/** The exact value of a finite long double as num × 2^e (num signed). */
function signedMantissa(x: { neg: boolean; m: bigint }): bigint {
  return x.neg ? -x.m : x.m;
}

/** Decimal digits × 10^exp, with guards that keep absurd exponents from building huge bigints. */
function fromDecimal(neg: boolean, digits: string, exp: number): LongDouble | null {
  const trimmed = digits.replace(/^0+/, '');
  if (!trimmed) return { neg, m: 0n, e: 0 };
  const magnitude = trimmed.length + exp; // value < 10^magnitude
  if (magnitude > 4934) return null; // ≥ 10^4933 overflows
  if (magnitude < -4952) return null; // < 10^-4952 rounds to zero
  const d = BigInt(trimmed);
  const result = exp >= 0 ? roundRational(neg, d * 10n ** BigInt(exp), 1n, 0) : roundRational(neg, d, 10n ** BigInt(-exp), 0);
  return result.inf || result.m === 0n ? null : result;
}

/** Hex digits × 2^exp (the fraction digits already folded into `exp`). */
function fromHex(neg: boolean, digits: string, exp: number): LongDouble | null {
  const trimmed = digits.replace(/^0+/, '');
  if (!trimmed) return { neg, m: 0n, e: 0 };
  const bits = trimmed.length * 4 + exp;
  if (bits > 16400) return null;
  if (bits < -16520) return null;
  const result = roundRational(neg, BigInt(`0x${trimmed}`), 1n, exp);
  return result.inf || result.m === 0n ? null : result;
}

/** A decimal exponent text → number, saturated far beyond any representable range. */
function exponent(text: string | undefined): number {
  if (!text) return 0;
  const n = Number(text);
  return Math.max(-1e7, Math.min(1e7, n));
}

/** Redis's long double reading of `text`, or null when Redis answers `value is not a valid float`. */
export function parseLongDouble(text: string): LongDouble | null {
  if (text.length === 0 || text.length >= MAX_TEXT) return null;
  const inf = INF_RE.exec(text);
  if (inf) return infinity(inf[1] === '-');
  const hex = HEX_RE.exec(text);
  if (hex) {
    const [, sign, int, frac = '', exp] = hex;
    if (!int && !frac) return null;
    return fromHex(sign === '-', int + frac, exponent(exp) - 4 * frac.length);
  }
  const dec = DECIMAL_RE.exec(text);
  if (!dec) return null;
  const [, sign, int, frac = '', exp] = dec;
  if (!int && !frac) return null;
  return fromDecimal(sign === '-', int + frac, exponent(exp) - frac.length);
}

export function isLongDoubleFinite(x: LongDouble): x is { neg: boolean; m: bigint; e: number } {
  return !x.inf;
}

/** a + b rounded once (the hardware's FADD); null when the sum is NaN (inf - inf). */
export function addLongDouble(a: LongDouble, b: LongDouble): LongDouble | null {
  if (a.inf || b.inf) {
    if (a.inf && b.inf && a.neg !== b.neg) return null;
    return infinity(a.inf ? a.neg : b.neg);
  }
  if (a.m === 0n && b.m === 0n) return { neg: a.neg && b.neg, m: 0n, e: 0 };
  if (a.m === 0n) return b;
  if (b.m === 0n) return a;
  const e = Math.min(a.e, b.e);
  const sum = (signedMantissa(a) << BigInt(a.e - e)) + (signedMantissa(b) << BigInt(b.e - e));
  // an exact zero sum is +0 under round-to-nearest
  return roundRational(sum < 0n, sum < 0n ? -sum : sum, 1n, e);
}

/** printf `%.17Lf` with Redis's trimming: no trailing zeros, no trailing dot, `-0` written `0`. Finite values only. */
export function formatLongDouble(x: LongDouble): string {
  if (x.inf) return x.neg ? '-inf' : 'inf';
  const scaled = x.m * FRACTION_SCALE;
  let units: bigint;
  if (x.e >= 0) units = scaled << BigInt(x.e);
  else {
    const shift = BigInt(-x.e);
    units = scaled >> shift;
    const twice = (scaled - (units << shift)) * 2n;
    const one = 1n << shift;
    if (twice > one || (twice === one && (units & 1n) === 1n)) units++;
  }
  const text = units.toString().padStart(FRACTION_DIGITS + 1, '0');
  const fraction = text.slice(-FRACTION_DIGITS).replace(/0+$/, '');
  const body = text.slice(0, -FRACTION_DIGITS) + (fraction ? `.${fraction}` : '');
  return x.neg && body !== '0' ? `-${body}` : body;
}
