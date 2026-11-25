import { formatMessage } from '@/libs/message-format';

import PersistenceMessages from './persistence.messages';

/**
 * Lowest layer of the RDB binary format: the growable byte writer / bounds-checked reader, Redis's CRC-64, LZF and the
 * little-endian integer helpers the listpack / intset / ziplist codecs share.
 *
 * Codecs are the building blocks of the persistence services (sub-services never import each other, so what several
 * of them need lives in a codec). All Redis strings are "binary strings" (one char code per byte, latin1).
 */

// ============================================================================
// Byte writer / reader
// ============================================================================

/** Growable output buffer. */
export class RdbWriter {
  private buf = Buffer.allocUnsafe(1024);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.length);
    this.buf = next;
  }

  u8(b: number): void {
    this.ensure(1);
    this.buf[this.length++] = b & 0xff;
  }

  bytes(b: Buffer): void {
    this.ensure(b.length);
    b.copy(this.buf, this.length);
    this.length += b.length;
  }

  u16le(v: number): void {
    this.ensure(2);
    this.buf.writeUInt16LE(v, this.length);
    this.length += 2;
  }

  u32be(v: number): void {
    this.ensure(4);
    this.buf.writeUInt32BE(v, this.length);
    this.length += 4;
  }

  u64be(v: bigint): void {
    this.ensure(8);
    this.buf.writeBigUInt64BE(BigInt.asUintN(64, v), this.length);
    this.length += 8;
  }

  u64le(v: bigint): void {
    this.ensure(8);
    this.buf.writeBigUInt64LE(BigInt.asUintN(64, v), this.length);
    this.length += 8;
  }

  doubleLe(v: number): void {
    this.ensure(8);
    this.buf.writeDoubleLE(v, this.length);
    this.length += 8;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.length));
  }
}

/** Bounds-checked input cursor: reading past the end is 'Bad data format'. */
export class RdbReader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) throw PersistenceBytesCodec.badFormat();
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  bytes(n: number): Buffer {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  i64le(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  doubleLe(): number {
    this.need(8);
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
}

// ============================================================================
// CRC-64, LZF, integers
// ============================================================================

export default class PersistenceBytesCodec {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Canonical decimal int64 text (no sign on 0, no leading zeros). */
  static readonly CANONICAL_INT = /^(?:0|-?[1-9][0-9]*)$/;
  static readonly INT64_MIN = -(1n << 63n);
  static readonly INT64_MAX = (1n << 63n) - 1n;

  /** CRC-64 Jones (polynomial 0xad93d23594c935a9, reflected in/out, init 0, xorout 0), split in 32-bit halves. */
  private static readonly CRC_TABLES: { lo: Uint32Array; hi: Uint32Array } = (() => {
    const lo = new Uint32Array(256);
    const hi = new Uint32Array(256);
    const poly = 0xad93d23594c935a9n;
    let reflected = 0n;
    for (let i = 0n; i < 64n; i++) if ((poly >> i) & 1n) reflected |= 1n << (63n - i);
    for (let i = 0; i < 256; i++) {
      let crc = BigInt(i);
      for (let k = 0; k < 8; k++) crc = crc & 1n ? (crc >> 1n) ^ reflected : crc >> 1n;
      lo[i] = Number(crc & 0xffffffffn);
      hi[i] = Number(crc >> 32n);
    }
    return { lo, hi };
  })();

  // LZF (liblzf 3.6 as vendored by Redis: HLOG 16, VERY_FAST, STRICT_ALIGN, offsets in the table)
  private static readonly LZF_HSIZE = 1 << 16;
  private static readonly LZF_MAX_LIT = 1 << 5;
  private static readonly LZF_MAX_OFF = 1 << 13;
  private static readonly LZF_MAX_REF = (1 << 8) + (1 << 3);

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static lzfIdx(h: number): number {
    return ((h >>> 8) - Math.imul(h, 5)) & (PersistenceBytesCodec.LZF_HSIZE - 1);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The error every malformed RDB / DUMP body raises. */
  static badFormat(): Error {
    return new Error(PersistenceMessages.BAD_DATA_FORMAT);
  }

  /** Redis CRC-64 (as used by RDB files and DUMP payloads). `crc` continues a previous value. */
  static crc64(data: Buffer, crc = 0n): bigint {
    const { lo: tableLo, hi: tableHi } = PersistenceBytesCodec.CRC_TABLES;
    let lo = Number(crc & 0xffffffffn) >>> 0;
    let hi = Number((crc >> 32n) & 0xffffffffn) >>> 0;
    for (let i = 0; i < data.length; i++) {
      const idx = (lo ^ data[i]) & 0xff;
      lo = (((lo >>> 8) | (hi << 24)) ^ tableLo[idx]) >>> 0;
      hi = ((hi >>> 8) ^ tableHi[idx]) >>> 0;
    }
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  /**
   * LZF-compresses `input` into at most `outLen` bytes (default `input.length - 4`, which is what
   * Redis allows when saving a string). Returns null when the output does not fit (as lzf_compress
   * returning 0) or when the input is too short.
   */
  static lzfCompress(input: Buffer, outLen = input.length - 4): Buffer | null {
    const C = PersistenceBytesCodec;
    const inEnd = input.length;
    if (inEnd === 0 || outLen <= 0) return null;
    const htab = new Int32Array(C.LZF_HSIZE);
    const out = Buffer.alloc(outLen + 8);
    const outEnd = outLen;
    let ip = 0;
    let op = 0;
    let lit = 0;
    op++;
    let hval = ((input[0] << 8) | (input[1] ?? 0)) >>> 0;
    while (ip < inEnd - 2) {
      hval = ((hval << 8) | input[ip + 2]) >>> 0;
      const slot = C.lzfIdx(hval);
      const ref = htab[slot];
      htab[slot] = ip;
      const off = ip - ref - 1;
      if (
        off >= 0 &&
        off < C.LZF_MAX_OFF &&
        ref > 0 &&
        input[ref + 2] === input[ip + 2] &&
        input[ref] === input[ip] &&
        input[ref + 1] === input[ip + 1]
      ) {
        let len = 2;
        let maxlen = inEnd - ip - len;
        if (maxlen > C.LZF_MAX_REF) maxlen = C.LZF_MAX_REF;
        if (op + 3 + 1 >= outEnd && op - (lit ? 0 : 1) + 3 + 1 >= outEnd) return null;
        out[op - lit - 1] = (lit - 1) & 0xff;
        op -= lit ? 0 : 1;
        let stopped = false;
        if (maxlen > 16) {
          for (let k = 0; k < 16; k++) {
            len++;
            if (input[ref + len] !== input[ip + len]) {
              stopped = true;
              break;
            }
          }
        }
        if (!stopped) {
          do len++;
          while (len < maxlen && input[ref + len] === input[ip + len]);
        }
        len -= 2;
        ip++;
        if (len < 7) {
          out[op++] = (off >> 8) + (len << 5);
        } else {
          out[op++] = (off >> 8) + (7 << 5);
          out[op++] = len - 7;
        }
        out[op++] = off & 0xff;
        lit = 0;
        op++;
        ip += len + 1;
        if (ip >= inEnd - 2) break;
        ip -= 2;
        hval = ((input[ip] << 8) | input[ip + 1]) >>> 0;
        hval = ((hval << 8) | input[ip + 2]) >>> 0;
        htab[C.lzfIdx(hval)] = ip;
        ip++;
        hval = ((hval << 8) | input[ip + 2]) >>> 0;
        htab[C.lzfIdx(hval)] = ip;
        ip++;
      } else {
        if (op >= outEnd) return null;
        lit++;
        out[op++] = input[ip++];
        if (lit === C.LZF_MAX_LIT) {
          out[op - lit - 1] = lit - 1;
          lit = 0;
          op++;
        }
      }
    }
    if (op + 3 > outEnd) return null;
    while (ip < inEnd) {
      lit++;
      out[op++] = input[ip++];
      if (lit === C.LZF_MAX_LIT) {
        out[op - lit - 1] = lit - 1;
        lit = 0;
        op++;
      }
    }
    out[op - lit - 1] = (lit - 1) & 0xff;
    op -= lit ? 0 : 1;
    return Buffer.from(out.subarray(0, op));
  }

  /** Decompresses an LZF block whose uncompressed size is exactly `outLen`. */
  static lzfDecompress(input: Buffer, outLen: number): Buffer {
    const bad = PersistenceBytesCodec.badFormat;
    const out = Buffer.alloc(outLen);
    let ip = 0;
    let op = 0;
    while (ip < input.length) {
      let ctrl = input[ip++];
      if (ctrl < 32) {
        ctrl++;
        if (op + ctrl > outLen || ip + ctrl > input.length) throw bad();
        input.copy(out, op, ip, ip + ctrl);
        op += ctrl;
        ip += ctrl;
      } else {
        let len = ctrl >> 5;
        let ref = op - ((ctrl & 0x1f) << 8) - 1;
        if (len === 7) {
          if (ip >= input.length) throw bad();
          len += input[ip++];
        }
        if (ip >= input.length) throw bad();
        ref -= input[ip++];
        len += 2;
        if (ref < 0 || op + len > outLen) throw bad();
        for (let k = 0; k < len; k++) out[op++] = out[ref++];
      }
    }
    if (op !== outLen) throw bad();
    return out;
  }

  /** string2ll semantics: the canonical decimal form of an int64, else null. */
  static stringToInt64(s: string): bigint | null {
    const C = PersistenceBytesCodec;
    if (s.length === 0 || s.length > 20 || !C.CANONICAL_INT.test(s)) return null;
    const v = BigInt(s);
    return v < C.INT64_MIN || v > C.INT64_MAX ? null : v;
  }

  static toBig(v: number | bigint): bigint {
    if (typeof v === 'bigint') return v;
    if (!Number.isSafeInteger(v)) throw new Error(formatMessage(PersistenceMessages.LISTPACK_INT_OUT_OF_RANGE, { value: v }));
    return BigInt(v);
  }

  static bigToSafe(v: bigint): number {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw PersistenceBytesCodec.badFormat();
    return Number(v);
  }

  /** Whether `v` fits a signed integer of `bits` bits. */
  static inRange(v: bigint, bits: number): boolean {
    const lim = 1n << BigInt(bits - 1);
    return v >= -lim && v < lim;
  }

  static writeIntLE(out: Buffer, at: number, v: bigint, bytes: number): void {
    let u = BigInt.asUintN(bytes * 8, v);
    for (let i = 0; i < bytes; i++) {
      out[at + i] = Number(u & 0xffn);
      u >>= 8n;
    }
  }

  static readIntLE(buf: Buffer, at: number, bytes: number): bigint {
    let u = 0n;
    for (let i = bytes - 1; i >= 0; i--) u = (u << 8n) | BigInt(buf[at + i]);
    return BigInt.asIntN(bytes * 8, u);
  }
}
