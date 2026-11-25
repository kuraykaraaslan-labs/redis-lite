import type { SparseRun } from './hyperloglog.types';

/**
 * HyperLogLog value layout (P=14, Q=50, 6-bit registers), shared by the structure, the hash and the estimator.
 *
 * Value layout (a plain Redis string):
 *   "HYLL" | encoding (0 dense, 1 sparse) | 3 unused bytes | 8-byte cached cardinality (little endian,
 *   MSB of the last byte set = cache invalid) | registers.
 * Dense: 16384 6-bit registers packed LSB-first. Sparse: ZERO (00xxxxxx), XZERO (01xxxxxx xxxxxxxx)
 * and VAL (1vvvvvxx) run-length opcodes.
 */

// ============================================================================
// Constants
// ============================================================================

export const HLL_P = 14;
export const HLL_Q = 64 - HLL_P;
export const HLL_REGISTERS = 1 << HLL_P;
export const HLL_P_MASK = HLL_REGISTERS - 1;
const HLL_BITS = 6;
const HLL_REGISTER_MAX = (1 << HLL_BITS) - 1;
export const HLL_HDR_SIZE = 16;
export const HLL_DENSE_SIZE = HLL_HDR_SIZE + Math.floor((HLL_REGISTERS * HLL_BITS + 7) / 8);
export const HLL_DENSE = 0;
export const HLL_SPARSE = 1;
/** Internal-only encoding: one byte per register (multi-key PFCOUNT). */
export const HLL_RAW = 255;
export const HLL_MAX_ENCODING = 1;

export const SPARSE_VAL_MAX_VALUE = 32;
export const SPARSE_VAL_MAX_LEN = 4;
export const SPARSE_ZERO_MAX_LEN = 64;
export const SPARSE_XZERO_MAX_LEN = 16384;

// ============================================================================
// Dense registers
// ============================================================================

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
export function denseSet(b: Uint8Array, index: number, count: number): number {
  if (count > denseGet(b, HLL_HDR_SIZE, index)) {
    denseSetReg(b, HLL_HDR_SIZE, index, count);
    return 1;
  }
  return 0;
}

// ============================================================================
// Sparse opcodes
// ============================================================================

export const isZero = (op: number): boolean => (op & 0xc0) === 0x00;
export const isXzero = (op: number): boolean => (op & 0xc0) === 0x40;
export const isVal = (op: number): boolean => (op & 0x80) !== 0;
export const zeroLen = (op: number): number => (op & 0x3f) + 1;
export const xzeroLen = (op: number, next: number | undefined): number => (((op & 0x3f) << 8) | (next ?? 0)) + 1;
export const valValue = (op: number): number => ((op >> 2) & 0x1f) + 1;
export const valLen = (op: number): number => (op & 0x3) + 1;
export const valOp = (val: number, len: number): number => (((val - 1) << 2) | (len - 1) | 0x80) & 0xff;
export const zeroOp = (len: number): number => len - 1;
export const xzeroOps = (len: number): [number, number] => [((len - 1) >> 8) | 0x40, (len - 1) & 0xff];

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
