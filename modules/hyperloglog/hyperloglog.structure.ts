/**
 * Redis-compatible HyperLogLog (P=14, Q=50, 6-bit registers).
 *
 * Value layout (a plain Redis string):
 *   "HYLL" | encoding (0 dense, 1 sparse) | 3 unused bytes | 8-byte cached cardinality (little endian,
 *   MSB of the last byte set = cache invalid) | registers.
 * Dense: 16384 6-bit registers packed LSB-first. Sparse: ZERO (00xxxxxx), XZERO (01xxxxxx xxxxxxxx)
 * and VAL (1vvvvvxx) run-length opcodes.
 */

export const HLL_P = 14;
export const HLL_Q = 64 - HLL_P;
export const HLL_REGISTERS = 1 << HLL_P;
const HLL_P_MASK = HLL_REGISTERS - 1;
const HLL_BITS = 6;
const HLL_REGISTER_MAX = (1 << HLL_BITS) - 1;
export const HLL_HDR_SIZE = 16;
export const HLL_DENSE_SIZE = HLL_HDR_SIZE + Math.floor((HLL_REGISTERS * HLL_BITS + 7) / 8);
export const HLL_DENSE = 0;
export const HLL_SPARSE = 1;
/** Internal-only encoding: one byte per register (multi-key PFCOUNT). */
export const HLL_RAW = 255;
const HLL_MAX_ENCODING = 1;

const SPARSE_VAL_MAX_VALUE = 32;
const SPARSE_VAL_MAX_LEN = 4;
const SPARSE_ZERO_MAX_LEN = 64;
const SPARSE_XZERO_MAX_LEN = 16384;

const HLL_ALPHA_INF = 0.721347520444481703680;
const HASH_SEED = 0xadc83b19;

export const HLL_WRONGTYPE = 'WRONGTYPE Key is not a valid HyperLogLog string value.';
export const HLL_INVALID = 'INVALIDOBJ Corrupted HLL object detected';

/* ---------------------------------------------------------------- hashing */

const M = 0xc6a4a7935bd1e995n;
const R = 47n;
const MASK64 = (1n << 64n) - 1n;

/** MurmurHash64A (Austin Appleby), little-endian block reads, as used by Redis. */
export function murmurHash64A(data: Uint8Array, seed: number): bigint {
  const len = data.length;
  let h = BigInt(seed >>> 0) ^ ((BigInt(len) * M) & MASK64);
  const blocksEnd = len - (len & 7);
  for (let i = 0; i < blocksEnd; i += 8) {
    const lo = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
    const hi = (data[i + 4] | (data[i + 5] << 8) | (data[i + 6] << 16) | (data[i + 7] << 24)) >>> 0;
    let k = BigInt(lo) | (BigInt(hi) << 32n);
    k = (k * M) & MASK64;
    k ^= k >> R;
    k = (k * M) & MASK64;
    h ^= k;
    h = (h * M) & MASK64;
  }
  const rem = len & 7;
  if (rem) {
    for (let i = rem - 1; i >= 0; i--) h ^= BigInt(data[blocksEnd + i]) << BigInt(8 * i);
    h = (h * M) & MASK64;
  }
  h ^= h >> R;
  h = (h * M) & MASK64;
  h ^= h >> R;
  return h;
}

/** Register index (low P bits of the hash) and run length of the "000..1" pattern of the remaining bits (1..Q+1). */
export function hllPatLen(ele: Uint8Array): { index: number; count: number } {
  const hash = murmurHash64A(ele, HASH_SEED);
  const index = Number(hash & BigInt(HLL_P_MASK));
  // Remaining bits plus the sentinel bit Q, so the count is at most Q+1. Fits a double exactly (< 2^51).
  let rest = Number((hash >> BigInt(HLL_P)) | (1n << BigInt(HLL_Q)));
  let count = 1;
  while (rest % 2 === 0) {
    count++;
    rest /= 2;
  }
  return { index, count };
}

/* ---------------------------------------------------------------- dense registers */

/** Register `regnum` of a dense register area starting at `offset` (reads past the end count as 0, like the sds NUL). */
export function denseGet(b: Uint8Array, offset: number, regnum: number): number {
  const byte = offset + ((regnum * HLL_BITS) >> 3);
  const fb = (regnum * HLL_BITS) & 7;
  const fb8 = 8 - fb;
  const b0 = b[byte] ?? 0;
  const b1 = byte + 1 < b.length ? b[byte + 1] : 0;
  return ((b0 >> fb) | (b1 << fb8)) & HLL_REGISTER_MAX;
}

export function denseSetReg(b: Uint8Array, offset: number, regnum: number, val: number): void {
  const byte = offset + ((regnum * HLL_BITS) >> 3);
  const fb = (regnum * HLL_BITS) & 7;
  const fb8 = 8 - fb;
  b[byte] &= ~(HLL_REGISTER_MAX << fb);
  b[byte] |= val << fb;
  if (byte + 1 < b.length) {
    b[byte + 1] &= ~(HLL_REGISTER_MAX >> fb8);
    b[byte + 1] |= val >> fb8;
  }
}

/** Sets the register when `count` is bigger. 1 = changed. */
function denseSet(b: Uint8Array, index: number, count: number): number {
  if (count > denseGet(b, HLL_HDR_SIZE, index)) {
    denseSetReg(b, HLL_HDR_SIZE, index, count);
    return 1;
  }
  return 0;
}

/* ---------------------------------------------------------------- sparse opcodes */

const isZero = (op: number): boolean => (op & 0xc0) === 0x00;
const isXzero = (op: number): boolean => (op & 0xc0) === 0x40;
const isVal = (op: number): boolean => (op & 0x80) !== 0;
const zeroLen = (op: number): number => (op & 0x3f) + 1;
const xzeroLen = (op: number, next: number | undefined): number => (((op & 0x3f) << 8) | (next ?? 0)) + 1;
const valValue = (op: number): number => ((op >> 2) & 0x1f) + 1;
const valLen = (op: number): number => (op & 0x3) + 1;
const valOp = (val: number, len: number): number => (((val - 1) << 2) | (len - 1) | 0x80) & 0xff;
const zeroOp = (len: number): number => len - 1;
const xzeroOps = (len: number): [number, number] => [((len - 1) >> 8) | 0x40, (len - 1) & 0xff];

/** One sparse opcode: the registers [first, first+len) all hold `value` (0 for ZERO/XZERO). */
export interface SparseRun {
  kind: 'zero' | 'xzero' | 'val';
  value: number;
  len: number;
}

/** Decodes the sparse opcodes after the header (lenient, like PFDEBUG DECODE). */
export function sparseRuns(b: Uint8Array): SparseRun[] {
  const out: SparseRun[] = [];
  let p = HLL_HDR_SIZE;
  while (p < b.length) {
    const op = b[p];
    if (isZero(op)) {
      out.push({ kind: 'zero', value: 0, len: zeroLen(op) });
      p++;
    } else if (isXzero(op)) {
      out.push({ kind: 'xzero', value: 0, len: xzeroLen(op, b[p + 1]) });
      p += 2;
    } else {
      out.push({ kind: 'val', value: valValue(op), len: valLen(op) });
      p++;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- the object */

/** A HyperLogLog value being worked on; `bytes` is replaced when the representation changes size. */
export class Hll {
  constructor(public bytes: Uint8Array) {}

  /** A new empty HLL: sparse, XZERO runs covering every register, valid cached cardinality 0. */
  static create(): Hll {
    const runs = Math.ceil(HLL_REGISTERS / SPARSE_XZERO_MAX_LEN);
    const b = new Uint8Array(HLL_HDR_SIZE + runs * 2);
    b.set([0x48, 0x59, 0x4c, 0x4c]); // "HYLL"
    b[4] = HLL_SPARSE;
    let left = HLL_REGISTERS;
    let p = HLL_HDR_SIZE;
    while (left) {
      const xz = Math.min(left, SPARSE_XZERO_MAX_LEN);
      b.set(xzeroOps(xz), p);
      p += 2;
      left -= xz;
    }
    return new Hll(b);
  }

  /** Parses a stored string; undefined when it is not a valid HyperLogLog (the WRONGTYPE case). */
  static fromString(s: string): Hll | undefined {
    if (s.length < HLL_HDR_SIZE) return undefined;
    if (!s.startsWith('HYLL')) return undefined;
    const enc = s.charCodeAt(4);
    if (enc > HLL_MAX_ENCODING) return undefined;
    if (enc === HLL_DENSE && s.length !== HLL_DENSE_SIZE) return undefined;
    return new Hll(new Uint8Array(Buffer.from(s, 'latin1')));
  }

  toString(): string {
    return Buffer.from(this.bytes.buffer, this.bytes.byteOffset, this.bytes.length).toString('latin1');
  }

  get encoding(): number {
    return this.bytes[4];
  }

  get cacheValid(): boolean {
    return (this.bytes[15] & 0x80) === 0;
  }

  invalidateCache(): void {
    this.bytes[15] |= 0x80;
  }

  get cachedCardinality(): number {
    let card = 0;
    for (let i = 7; i >= 0; i--) card = card * 256 + this.bytes[8 + i];
    return card;
  }

  set cachedCardinality(card: number) {
    let c = BigInt(card);
    for (let i = 0; i < 8; i++) {
      this.bytes[8 + i] = Number(c & 0xffn);
      c >>= 8n;
    }
  }

  /** Adds an element. 1 = a register changed, 0 = no change, -1 = corrupted HLL. */
  add(ele: Uint8Array, sparseMaxBytes: number): number {
    const { index, count } = hllPatLen(ele);
    return this.set(index, count, sparseMaxBytes);
  }

  /** Raises register `index` to `count`. 1 = changed, 0 = no change, -1 = corrupted HLL. */
  set(index: number, count: number, sparseMaxBytes: number): number {
    if (this.encoding === HLL_DENSE) return denseSet(this.bytes, index, count);
    if (this.encoding === HLL_SPARSE) return this.sparseSet(index, count, sparseMaxBytes);
    return -1;
  }

  /** Converts a sparse HLL to dense in place, keeping the header (cached cardinality included). False = corrupted. */
  toDense(): boolean {
    if (this.encoding === HLL_DENSE) return true;
    const dense = new Uint8Array(HLL_DENSE_SIZE);
    dense.set(this.bytes.subarray(0, HLL_HDR_SIZE));
    dense[4] = HLL_DENSE;
    const b = this.bytes;
    let idx = 0;
    let p = HLL_HDR_SIZE;
    while (p < b.length) {
      const op = b[p];
      if (isZero(op)) {
        idx += zeroLen(op);
        p++;
      } else if (isXzero(op)) {
        idx += xzeroLen(op, b[p + 1]);
        p += 2;
      } else {
        let runlen = valLen(op);
        const regval = valValue(op);
        if (runlen + idx > HLL_REGISTERS) break;
        while (runlen--) denseSetReg(dense, HLL_HDR_SIZE, idx++, regval);
        p++;
      }
    }
    if (idx !== HLL_REGISTERS) return false;
    this.bytes = dense;
    return true;
  }

  private promote(index: number, count: number): number {
    if (!this.toDense()) return -1;
    return denseSet(this.bytes, index, count);
  }

  private sparseSet(index: number, count: number, sparseMaxBytes: number): number {
    if (count > SPARSE_VAL_MAX_VALUE) return this.promote(index, count);
    let b = this.bytes;
    let end = b.length;

    // Step 1: locate the opcode covering `index`.
    let p = HLL_HDR_SIZE;
    let first = 0;
    let prev = -1;
    let span = 0;
    while (p < end) {
      const op = b[p];
      let oplen = 1;
      if (isZero(op)) span = zeroLen(op);
      else if (isVal(op)) span = valLen(op);
      else {
        span = xzeroLen(op, b[p + 1]);
        oplen = 2;
      }
      if (index <= first + span - 1) break;
      prev = p;
      p += oplen;
      first += span;
    }
    if (span === 0 || p >= end) return -1;

    const op = b[p];
    const zero = isZero(op);
    const xzero = isXzero(op);
    const val = !zero && !xzero;
    const runlen = zero ? zeroLen(op) : xzero ? xzeroLen(op, b[p + 1]) : valLen(op);

    let updated = false;
    // Step 2: trivial cases.
    if (val) {
      if (valValue(op) >= count) return 0;
      if (runlen === 1) {
        b[p] = valOp(count, 1);
        updated = true;
      }
    }
    if (!updated && zero && runlen === 1) {
      b[p] = valOp(count, 1);
      updated = true;
    }

    if (!updated) {
      // General case: split the opcode into up to three (at most 5 bytes).
      const seq: number[] = [];
      const last = first + span - 1;
      if (zero || xzero) {
        if (index !== first) {
          const len = index - first;
          if (len > SPARSE_ZERO_MAX_LEN) seq.push(...xzeroOps(len));
          else seq.push(zeroOp(len));
        }
        seq.push(valOp(count, 1));
        if (index !== last) {
          const len = last - index;
          if (len > SPARSE_ZERO_MAX_LEN) seq.push(...xzeroOps(len));
          else seq.push(zeroOp(len));
        }
      } else {
        const curval = valValue(op);
        if (index !== first) seq.push(valOp(curval, index - first));
        seq.push(valOp(count, 1));
        if (index !== last) seq.push(valOp(curval, last - index));
      }

      // Step 3: substitute the new sequence for the old opcode.
      const oldlen = xzero ? 2 : 1;
      const deltalen = seq.length - oldlen;
      if (deltalen > 0 && b.length + deltalen > sparseMaxBytes) return this.promote(index, count);
      const nb = new Uint8Array(b.length + deltalen);
      nb.set(b.subarray(0, p));
      nb.set(seq, p);
      nb.set(b.subarray(p + oldlen), p + seq.length);
      b = nb;
      end = b.length;
    }

    // Step 4: merge adjacent VAL opcodes with the same value, scanning up to 5 opcodes from prev.
    p = prev >= 0 ? prev : HLL_HDR_SIZE;
    let scanlen = 5;
    while (p < end && scanlen--) {
      if (isXzero(b[p])) {
        p += 2;
        continue;
      }
      if (isZero(b[p])) {
        p++;
        continue;
      }
      if (p + 1 < end && isVal(b[p + 1])) {
        const v1 = valValue(b[p]);
        const v2 = valValue(b[p + 1]);
        if (v1 === v2) {
          const len = valLen(b[p]) + valLen(b[p + 1]);
          if (len <= SPARSE_VAL_MAX_LEN) {
            const nb = new Uint8Array(end - 1);
            nb.set(b.subarray(0, p));
            nb[p] = valOp(v1, len);
            nb.set(b.subarray(p + 2), p + 1);
            b = nb;
            end--;
            continue;
          }
        }
      }
      p++;
    }

    this.bytes = b;
    this.invalidateCache();
    return 1;
  }

  /** Register histogram (64 slots). `invalid` is set for a sparse HLL that does not cover exactly all registers. */
  histogram(): { histo: number[]; invalid: boolean } {
    const histo = new Array<number>(64).fill(0);
    const b = this.bytes;
    if (this.encoding === HLL_DENSE) {
      for (let j = 0; j < HLL_REGISTERS; j++) histo[denseGet(b, HLL_HDR_SIZE, j)]++;
      return { histo, invalid: false };
    }
    if (this.encoding === HLL_RAW) {
      for (let j = 0; j < HLL_REGISTERS; j++) histo[b[HLL_HDR_SIZE + j] & 63]++;
      return { histo, invalid: false };
    }
    let idx = 0;
    let p = HLL_HDR_SIZE;
    while (p < b.length) {
      const op = b[p];
      if (isZero(op)) {
        const runlen = zeroLen(op);
        idx += runlen;
        histo[0] += runlen;
        p++;
      } else if (isXzero(op)) {
        const runlen = xzeroLen(op, b[p + 1]);
        idx += runlen;
        histo[0] += runlen;
        p += 2;
      } else {
        const runlen = valLen(op);
        idx += runlen;
        histo[valValue(op)] += runlen;
        p++;
      }
    }
    return { histo, invalid: idx !== HLL_REGISTERS };
  }

  /** Estimated cardinality (undefined = corrupted sparse HLL). Does not touch the cache. */
  count(): number | undefined {
    const { histo, invalid } = this.histogram();
    if (invalid) return undefined;
    return estimate(histo);
  }

  /** max[i] = MAX(max[i], register i). False = corrupted sparse HLL. */
  mergeInto(max: Uint8Array): boolean {
    const b = this.bytes;
    if (this.encoding === HLL_DENSE) {
      for (let i = 0; i < HLL_REGISTERS; i++) {
        const v = denseGet(b, HLL_HDR_SIZE, i);
        if (v > max[i]) max[i] = v;
      }
      return true;
    }
    let i = 0;
    let p = HLL_HDR_SIZE;
    while (p < b.length) {
      const op = b[p];
      if (isZero(op)) {
        i += zeroLen(op);
        p++;
      } else if (isXzero(op)) {
        i += xzeroLen(op, b[p + 1]);
        p += 2;
      } else {
        let runlen = valLen(op);
        const regval = valValue(op);
        if (runlen + i > HLL_REGISTERS) break;
        while (runlen--) {
          if (regval > max[i]) max[i] = regval;
          i++;
        }
        p++;
      }
    }
    return i === HLL_REGISTERS;
  }

  /** Every register value (sparse or dense). */
  registers(): Uint8Array {
    const out = new Uint8Array(HLL_REGISTERS);
    if (this.encoding === HLL_DENSE) {
      for (let i = 0; i < HLL_REGISTERS; i++) out[i] = denseGet(this.bytes, HLL_HDR_SIZE, i);
    } else this.mergeInto(out);
    return out;
  }
}

/** Cardinality of a raw register array (the multi-key PFCOUNT path). */
export function countRaw(registers: Uint8Array): number {
  const b = new Uint8Array(HLL_HDR_SIZE + HLL_REGISTERS);
  b[4] = HLL_RAW;
  b.set(registers, HLL_HDR_SIZE);
  return estimate(new Hll(b).histogram().histo);
}

/* ---------------------------------------------------------------- estimator (Ertl, arXiv:1702.01284) */

function hllSigma(x: number): number {
  if (x === 1) return Infinity;
  let zPrime: number;
  let y = 1;
  let z = x;
  do {
    x *= x;
    zPrime = z;
    z += x * y;
    y += y;
  } while (zPrime !== z);
  return z;
}

function hllTau(x: number): number {
  if (x === 0 || x === 1) return 0;
  let zPrime: number;
  let y = 1.0;
  let z = 1 - x;
  do {
    x = Math.sqrt(x);
    zPrime = z;
    y *= 0.5;
    const d = 1 - x;
    z -= d * d * y;
  } while (zPrime !== z);
  return z / 3;
}

function estimate(histo: number[]): number {
  const m = HLL_REGISTERS;
  let z = m * hllTau((m - histo[HLL_Q + 1]) / m);
  for (let j = HLL_Q; j >= 1; --j) {
    z += histo[j];
    z *= 0.5;
  }
  z += m * hllSigma(histo[0] / m);
  // llroundl: round half away from zero (the value is never negative).
  return Math.round((HLL_ALPHA_INF * m * m) / z);
}
