/**
 * Redis RDB binary format: CRC-64, LZF, listpack / intset / ziplist / zipmap, per-type object
 * serialization, DUMP payloads and whole RDB files.
 *
 * All Redis strings are "binary strings" (one char code per byte, latin1).
 */
import type { RedisValue } from '@/modules/database/database.core';
import { compareIds, idToString, Stream } from '@/modules/streams/streams.structure';
import type { Consumer, ConsumerGroup, PendingEntry, StreamEntry, StreamId } from '@/modules/streams/streams.structure';
import { ZSet } from '@/modules/zsets/zsets.structure';

/**
 * RDB version written by this implementation (DUMP footer and the `REDIS00NN` file magic).
 * Redis 7.4 and 8.0 write RDB version 12 (introduced with hash field expiration types 24/25).
 * Kept as a single constant: if Redis 8.8 turns out to write 13, change it here.
 */
export const RDB_VERSION = 12;

export const RDB_TYPE = {
  STRING: 0,
  LIST: 1,
  SET: 2,
  ZSET: 3,
  HASH: 4,
  ZSET_2: 5,
  MODULE_PRE_GA: 6,
  MODULE_2: 7,
  HASH_ZIPMAP: 9,
  LIST_ZIPLIST: 10,
  SET_INTSET: 11,
  ZSET_ZIPLIST: 12,
  HASH_ZIPLIST: 13,
  LIST_QUICKLIST: 14,
  STREAM_LISTPACKS: 15,
  HASH_LISTPACK: 16,
  ZSET_LISTPACK: 17,
  LIST_QUICKLIST_2: 18,
  STREAM_LISTPACKS_2: 19,
  SET_LISTPACK: 20,
  STREAM_LISTPACKS_3: 21,
  HASH_METADATA_PRE_GA: 22,
  HASH_LISTPACK_EX_PRE_GA: 23,
  HASH_METADATA: 24,
  HASH_LISTPACK_EX: 25,
} as const;

export const RDB_OPCODE = {
  SLOT_INFO: 0xf4,
  FUNCTION2: 0xf5,
  FUNCTION_PRE_GA: 0xf6,
  MODULE_AUX: 0xf7,
  IDLE: 0xf8,
  FREQ: 0xf9,
  AUX: 0xfa,
  RESIZEDB: 0xfb,
  EXPIRETIME_MS: 0xfc,
  EXPIRETIME: 0xfd,
  SELECTDB: 0xfe,
  EOF: 0xff,
} as const;

const QUICKLIST_NODE_CONTAINER_PLAIN = 1;
const QUICKLIST_NODE_CONTAINER_PACKED = 2;

const BAD_FORMAT = 'Bad data format';
const DUMP_ERROR = 'DUMP payload version or checksum are wrong';

function bad(): Error {
  return new Error(BAD_FORMAT);
}

/** Encoding thresholds (Redis CONFIG names in comments). Defaults are Redis's defaults. */
export interface RdbOptions {
  hashMaxListpackEntries: number; // hash-max-listpack-entries
  hashMaxListpackValue: number; // hash-max-listpack-value
  setMaxIntsetEntries: number; // set-max-intset-entries
  setMaxListpackEntries: number; // set-max-listpack-entries
  setMaxListpackValue: number; // set-max-listpack-value
  zsetMaxListpackEntries: number; // zset-max-listpack-entries
  zsetMaxListpackValue: number; // zset-max-listpack-value
  listMaxListpackSize: number; // list-max-listpack-size
  streamNodeMaxEntries: number; // stream-node-max-entries
  streamNodeMaxBytes: number; // stream-node-max-bytes
  rdbCompression: boolean; // rdbcompression
  rdbChecksum: boolean; // rdbchecksum (RDB files only; DUMP always carries a CRC)
}

export const DEFAULT_RDB_OPTIONS: Readonly<RdbOptions> = Object.freeze({
  hashMaxListpackEntries: 128,
  hashMaxListpackValue: 64,
  setMaxIntsetEntries: 512,
  setMaxListpackEntries: 128,
  setMaxListpackValue: 64,
  zsetMaxListpackEntries: 128,
  zsetMaxListpackValue: 64,
  listMaxListpackSize: -2,
  streamNodeMaxEntries: 100,
  streamNodeMaxBytes: 4096,
  rdbCompression: true,
  rdbChecksum: true,
});

function resolveOptions(opts?: Partial<RdbOptions>): RdbOptions {
  return { ...DEFAULT_RDB_OPTIONS, ...opts };
}

// ---------------------------------------------------------------------------------------------
// CRC-64 (Jones polynomial 0xad93d23594c935a9, reflected in/out, init 0, xorout 0)
// ---------------------------------------------------------------------------------------------

const CRC_TABLE_LO = new Uint32Array(256);
const CRC_TABLE_HI = new Uint32Array(256);
(() => {
  const poly = 0xad93d23594c935a9n;
  let reflected = 0n;
  for (let i = 0n; i < 64n; i++) if ((poly >> i) & 1n) reflected |= 1n << (63n - i);
  for (let i = 0; i < 256; i++) {
    let crc = BigInt(i);
    for (let k = 0; k < 8; k++) crc = crc & 1n ? (crc >> 1n) ^ reflected : crc >> 1n;
    CRC_TABLE_LO[i] = Number(crc & 0xffffffffn);
    CRC_TABLE_HI[i] = Number(crc >> 32n);
  }
})();

/** Redis CRC-64 (as used by RDB files and DUMP payloads). `crc` continues a previous value. */
export function crc64(data: Buffer, crc = 0n): bigint {
  let lo = Number(crc & 0xffffffffn) >>> 0;
  let hi = Number((crc >> 32n) & 0xffffffffn) >>> 0;
  for (let i = 0; i < data.length; i++) {
    const idx = (lo ^ data[i]) & 0xff;
    lo = (((lo >>> 8) | (hi << 24)) ^ CRC_TABLE_LO[idx]) >>> 0;
    hi = ((hi >>> 8) ^ CRC_TABLE_HI[idx]) >>> 0;
  }
  return (BigInt(hi) << 32n) | BigInt(lo);
}

// ---------------------------------------------------------------------------------------------
// LZF (liblzf 3.6 as vendored by Redis: HLOG 16, VERY_FAST, STRICT_ALIGN, offsets in the table)
// ---------------------------------------------------------------------------------------------

const LZF_HSIZE = 1 << 16;
const LZF_MAX_LIT = 1 << 5;
const LZF_MAX_OFF = 1 << 13;
const LZF_MAX_REF = (1 << 8) + (1 << 3);

function lzfIdx(h: number): number {
  return ((h >>> 8) - Math.imul(h, 5)) & (LZF_HSIZE - 1);
}

/**
 * LZF-compresses `input` into at most `outLen` bytes (default `input.length - 4`, which is what
 * Redis allows when saving a string). Returns null when the output does not fit (as lzf_compress
 * returning 0) or when the input is too short.
 */
export function lzfCompress(input: Buffer, outLen = input.length - 4): Buffer | null {
  const inEnd = input.length;
  if (inEnd === 0 || outLen <= 0) return null;
  const htab = new Int32Array(LZF_HSIZE);
  const out = Buffer.alloc(outLen + 8);
  const outEnd = outLen;
  let ip = 0;
  let op = 0;
  let lit = 0;
  op++;
  let hval = ((input[0] << 8) | (input[1] ?? 0)) >>> 0;
  while (ip < inEnd - 2) {
    hval = ((hval << 8) | input[ip + 2]) >>> 0;
    const slot = lzfIdx(hval);
    const ref = htab[slot];
    htab[slot] = ip;
    const off = ip - ref - 1;
    if (
      off >= 0 &&
      off < LZF_MAX_OFF &&
      ref > 0 &&
      input[ref + 2] === input[ip + 2] &&
      input[ref] === input[ip] &&
      input[ref + 1] === input[ip + 1]
    ) {
      let len = 2;
      let maxlen = inEnd - ip - len;
      if (maxlen > LZF_MAX_REF) maxlen = LZF_MAX_REF;
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
      htab[lzfIdx(hval)] = ip;
      ip++;
      hval = ((hval << 8) | input[ip + 2]) >>> 0;
      htab[lzfIdx(hval)] = ip;
      ip++;
    } else {
      if (op >= outEnd) return null;
      lit++;
      out[op++] = input[ip++];
      if (lit === LZF_MAX_LIT) {
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
    if (lit === LZF_MAX_LIT) {
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
export function lzfDecompress(input: Buffer, outLen: number): Buffer {
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

// ---------------------------------------------------------------------------------------------
// Byte writer / reader
// ---------------------------------------------------------------------------------------------

class Writer {
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

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) throw bad();
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

// ---------------------------------------------------------------------------------------------
// Integer helpers
// ---------------------------------------------------------------------------------------------

const CANONICAL_INT = /^(?:0|-?[1-9][0-9]*)$/;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

/** string2ll semantics: the canonical decimal form of an int64, else null. */
function stringToInt64(s: string): bigint | null {
  if (s.length === 0 || s.length > 20 || !CANONICAL_INT.test(s)) return null;
  const v = BigInt(s);
  return v < INT64_MIN || v > INT64_MAX ? null : v;
}

function toBig(v: number | bigint): bigint {
  if (typeof v === 'bigint') return v;
  if (!Number.isSafeInteger(v)) throw new Error(`listpack integer out of range: ${v}`);
  return BigInt(v);
}

function bigToSafe(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw bad();
  return Number(v);
}

function inRange(v: bigint, bits: number): boolean {
  const lim = 1n << BigInt(bits - 1);
  return v >= -lim && v < lim;
}

function writeIntLE(out: Buffer, at: number, v: bigint, bytes: number): void {
  let u = BigInt.asUintN(bytes * 8, v);
  for (let i = 0; i < bytes; i++) {
    out[at + i] = Number(u & 0xffn);
    u >>= 8n;
  }
}

function readIntLE(buf: Buffer, at: number, bytes: number): bigint {
  let u = 0n;
  for (let i = bytes - 1; i >= 0; i--) u = (u << 8n) | BigInt(buf[at + i]);
  return BigInt.asIntN(bytes * 8, u);
}

// ---------------------------------------------------------------------------------------------
// Listpack
// ---------------------------------------------------------------------------------------------

/** A listpack element: strings that look like canonical int64s are stored as integers (lpAppend). */
export type ListpackEntry = string | number | bigint;

const LP_HDR_SIZE = 6;
const LP_EOF = 0xff;

function lpEncodeEntry(e: ListpackEntry): Buffer {
  let iv: bigint | null;
  if (typeof e === 'string') iv = stringToInt64(e);
  else iv = toBig(e);
  if (iv !== null) {
    const v = iv;
    if (v >= 0n && v <= 127n) return Buffer.from([Number(v)]);
    if (v >= -4096n && v <= 4095n) {
      const u = Number(BigInt.asUintN(13, v));
      return Buffer.from([0xc0 | (u >> 8), u & 0xff]);
    }
    const [tag, size] = inRange(v, 16) ? [0xf1, 2] : inRange(v, 24) ? [0xf2, 3] : inRange(v, 32) ? [0xf3, 4] : [0xf4, 8];
    const out = Buffer.alloc(1 + size);
    out[0] = tag;
    writeIntLE(out, 1, v, size);
    return out;
  }
  const s = Buffer.from(e as string, 'latin1');
  const len = s.length;
  let hdr: Buffer;
  if (len < 64) hdr = Buffer.from([0x80 | len]);
  else if (len < 4096) hdr = Buffer.from([0xe0 | (len >> 8), len & 0xff]);
  else {
    hdr = Buffer.alloc(5);
    hdr[0] = 0xf0;
    hdr.writeUInt32LE(len, 1);
  }
  return Buffer.concat([hdr, s]);
}

function lpBacklenSize(l: number): number {
  if (l <= 127) return 1;
  if (l < 16383) return 2;
  if (l < 2097151) return 3;
  if (l < 268435455) return 4;
  return 5;
}

function lpEncodeBacklen(l: number): Buffer {
  const n = lpBacklenSize(l);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const shift = 7 * (n - 1 - i);
    const part = Math.floor(l / 2 ** shift) & 127;
    out[i] = i === 0 ? part : part | 128;
  }
  return out;
}

function lpEntryBytes(e: ListpackEntry): number {
  const l = lpEncodeEntry(e).length;
  return l + lpBacklenSize(l);
}

/** Serialized size of a listpack holding `entries` (header + entries + terminator). */
export function listpackBytes(entries: readonly ListpackEntry[]): number {
  let total = LP_HDR_SIZE + 1;
  for (const e of entries) total += lpEntryBytes(e);
  return total;
}

export function listpackEncode(entries: readonly ListpackEntry[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(LP_HDR_SIZE)];
  let total = LP_HDR_SIZE + 1;
  for (const e of entries) {
    const enc = lpEncodeEntry(e);
    const back = lpEncodeBacklen(enc.length);
    parts.push(enc, back);
    total += enc.length + back.length;
  }
  parts.push(Buffer.from([LP_EOF]));
  const out = Buffer.concat(parts, total);
  out.writeUInt32LE(total, 0);
  out.writeUInt16LE(Math.min(entries.length, 65535), 4);
  return out;
}

/** Decodes a listpack. Integer-encoded elements come back as bigint, strings as binary strings. */
export function listpackDecode(buf: Buffer): Array<string | bigint> {
  if (buf.length < LP_HDR_SIZE + 1 || buf.readUInt32LE(0) !== buf.length) throw bad();
  const declared = buf.readUInt16LE(4);
  const out: Array<string | bigint> = [];
  let p = LP_HDR_SIZE;
  for (;;) {
    if (p >= buf.length) throw bad();
    const b = buf[p];
    if (b === LP_EOF) break;
    let encLen: number;
    if ((b & 0x80) === 0) {
      out.push(BigInt(b & 0x7f));
      encLen = 1;
    } else if ((b & 0xc0) === 0x80) {
      const len = b & 0x3f;
      encLen = 1 + len;
      if (p + encLen > buf.length) throw bad();
      out.push(buf.toString('latin1', p + 1, p + encLen));
    } else if ((b & 0xe0) === 0xc0) {
      if (p + 2 > buf.length) throw bad();
      out.push(BigInt.asIntN(13, BigInt(((b & 0x1f) << 8) | buf[p + 1])));
      encLen = 2;
    } else if ((b & 0xf0) === 0xe0) {
      if (p + 2 > buf.length) throw bad();
      const len = ((b & 0x0f) << 8) | buf[p + 1];
      encLen = 2 + len;
      if (p + encLen > buf.length) throw bad();
      out.push(buf.toString('latin1', p + 2, p + encLen));
    } else if (b === 0xf0) {
      if (p + 5 > buf.length) throw bad();
      const len = buf.readUInt32LE(p + 1);
      encLen = 5 + len;
      if (p + encLen > buf.length) throw bad();
      out.push(buf.toString('latin1', p + 5, p + encLen));
    } else {
      const size = b === 0xf1 ? 2 : b === 0xf2 ? 3 : b === 0xf3 ? 4 : b === 0xf4 ? 8 : 0;
      if (size === 0) throw bad();
      encLen = 1 + size;
      if (p + encLen > buf.length) throw bad();
      out.push(readIntLE(buf, p + 1, size));
    }
    p += encLen + lpBacklenSize(encLen);
  }
  if (p !== buf.length - 1) throw bad();
  if (declared !== 65535 && declared !== out.length) throw bad();
  return out;
}

function entryToString(e: string | bigint): string {
  return typeof e === 'string' ? e : e.toString();
}

function listpackStrings(buf: Buffer): string[] {
  return listpackDecode(buf).map(entryToString);
}

// ---------------------------------------------------------------------------------------------
// Intset, ziplist, zipmap
// ---------------------------------------------------------------------------------------------

/** Encodes canonical-integer members as an intset (sorted, smallest common width). */
export function intsetEncode(values: Iterable<bigint>): Buffer {
  const sorted = [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let width = 2;
  for (const v of sorted) {
    if (!inRange(v, 16)) width = Math.max(width, inRange(v, 32) ? 4 : 8);
  }
  const out = Buffer.alloc(8 + sorted.length * width);
  out.writeUInt32LE(width, 0);
  out.writeUInt32LE(sorted.length, 4);
  sorted.forEach((v, i) => writeIntLE(out, 8 + i * width, v, width));
  return out;
}

export function intsetDecode(buf: Buffer): bigint[] {
  if (buf.length < 8) throw bad();
  const width = buf.readUInt32LE(0);
  const len = buf.readUInt32LE(4);
  if ((width !== 2 && width !== 4 && width !== 8) || buf.length !== 8 + len * width) throw bad();
  const out: bigint[] = [];
  for (let i = 0; i < len; i++) out.push(readIntLE(buf, 8 + i * width, width));
  return out;
}

/** Decodes a legacy ziplist (pre Redis 7 encoding). */
export function ziplistDecode(buf: Buffer): Array<string | bigint> {
  if (buf.length < 11 || buf.readUInt32LE(0) !== buf.length) throw bad();
  const out: Array<string | bigint> = [];
  let p = 10;
  const need = (n: number): void => {
    if (p + n > buf.length) throw bad();
  };
  for (;;) {
    need(1);
    if (buf[p] === 0xff) break;
    p += buf[p] < 254 ? 1 : 5;
    need(1);
    const enc = buf[p];
    switch (enc >> 6) {
      case 0: {
        const len = enc & 0x3f;
        need(1 + len);
        out.push(buf.toString('latin1', p + 1, p + 1 + len));
        p += 1 + len;
        break;
      }
      case 1: {
        need(2);
        const len = ((enc & 0x3f) << 8) | buf[p + 1];
        need(2 + len);
        out.push(buf.toString('latin1', p + 2, p + 2 + len));
        p += 2 + len;
        break;
      }
      case 2: {
        need(5);
        const len = buf.readUInt32BE(p + 1);
        need(5 + len);
        out.push(buf.toString('latin1', p + 5, p + 5 + len));
        p += 5 + len;
        break;
      }
      default: {
        let size: number;
        if (enc === 0xc0) size = 2;
        else if (enc === 0xd0) size = 4;
        else if (enc === 0xe0) size = 8;
        else if (enc === 0xf0) size = 3;
        else if (enc === 0xfe) size = 1;
        else if (enc >= 0xf1 && enc <= 0xfd) {
          out.push(BigInt((enc & 0x0f) - 1));
          p += 1;
          continue;
        } else throw bad();
        need(1 + size);
        out.push(readIntLE(buf, p + 1, size));
        p += 1 + size;
      }
    }
  }
  if (p !== buf.length - 1) throw bad();
  return out;
}

/** Decodes a legacy zipmap (Redis < 2.6 small hashes) into [field, value, field, value, ...]. */
export function zipmapDecode(buf: Buffer): string[] {
  const out: string[] = [];
  let p = 1;
  const readLen = (): number | null => {
    if (p >= buf.length) throw bad();
    const b = buf[p];
    if (b === 0xff) return null;
    if (b < 254) {
      p += 1;
      return b;
    }
    if (b === 254) {
      if (p + 5 > buf.length) throw bad();
      const v = buf.readUInt32LE(p + 1);
      p += 5;
      return v;
    }
    throw bad();
  };
  for (;;) {
    const klen = readLen();
    if (klen === null) break;
    if (p + klen > buf.length) throw bad();
    const key = buf.toString('latin1', p, p + klen);
    p += klen;
    const vlen = readLen();
    if (vlen === null || p + 1 > buf.length) throw bad();
    const free = buf[p++];
    if (p + vlen + free > buf.length) throw bad();
    const value = buf.toString('latin1', p, p + vlen);
    p += vlen + free;
    out.push(key, value);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// RDB primitives: lengths, strings, doubles
// ---------------------------------------------------------------------------------------------

function writeLen(w: Writer, n: number | bigint): void {
  const v = BigInt.asUintN(64, BigInt(n));
  if (v < 64n) w.u8(Number(v));
  else if (v < 16384n) {
    w.u8(0x40 | Number(v >> 8n));
    w.u8(Number(v & 0xffn));
  } else if (v <= 0xffffffffn) {
    w.u8(0x80);
    w.u32be(Number(v));
  } else {
    w.u8(0x81);
    w.u64be(v);
  }
}

/** rdbEncodeInteger: the 0xC0/0xC1/0xC2 special encodings for values fitting 8/16/32 bits. */
function encodeRdbInt(v: number): Buffer | null {
  if (v >= -128 && v <= 127) return Buffer.from([0xc0, v & 0xff]);
  if (v >= -32768 && v <= 32767) {
    const b = Buffer.alloc(3);
    b[0] = 0xc1;
    b.writeInt16LE(v, 1);
    return b;
  }
  if (v >= -2147483648 && v <= 2147483647) {
    const b = Buffer.alloc(5);
    b[0] = 0xc2;
    b.writeInt32LE(v, 1);
    return b;
  }
  return null;
}

/** rdbSaveRawString: integer encoding for short canonical ints, LZF for len > 20, else raw. */
function writeString(w: Writer, s: Buffer, compress: boolean): void {
  const len = s.length;
  if (len <= 11 && len > 0) {
    const str = s.toString('latin1');
    if (CANONICAL_INT.test(str)) {
      const enc = encodeRdbInt(Number(str));
      if (enc) {
        w.bytes(enc);
        return;
      }
    }
  }
  if (compress && len > 20) {
    const c = lzfCompress(s, len - 4);
    if (c) {
      w.u8(0xc3);
      writeLen(w, c.length);
      writeLen(w, len);
      w.bytes(c);
      return;
    }
  }
  writeLen(w, len);
  w.bytes(s);
}

function writeStr(w: Writer, s: string, compress: boolean): void {
  writeString(w, Buffer.from(s, 'latin1'), compress);
}

/** rdbSaveLongLongAsStringObject. */
function writeLongLongString(w: Writer, v: number | bigint): void {
  const big = BigInt(v);
  if (big >= -2147483648n && big <= 2147483647n) {
    w.bytes(encodeRdbInt(Number(big))!);
    return;
  }
  const s = Buffer.from(big.toString(), 'latin1');
  writeLen(w, s.length);
  w.bytes(s);
}

function readLenRaw(r: Reader): { len: bigint; encoded: boolean } {
  const b = r.u8();
  const type = b >> 6;
  if (type === 0) return { len: BigInt(b & 0x3f), encoded: false };
  if (type === 1) return { len: BigInt(((b & 0x3f) << 8) | r.u8()), encoded: false };
  if (type === 3) return { len: BigInt(b & 0x3f), encoded: true };
  if (b === 0x80) {
    const v = r.bytes(4).readUInt32BE(0);
    return { len: BigInt(v), encoded: false };
  }
  if (b === 0x81) return { len: r.bytes(8).readBigUInt64BE(0), encoded: false };
  throw bad();
}

function readLenBig(r: Reader): bigint {
  const { len, encoded } = readLenRaw(r);
  if (encoded) throw bad();
  return len;
}

function readLen(r: Reader): number {
  return bigToSafe(readLenBig(r));
}

function readStringBuf(r: Reader): Buffer {
  const { len, encoded } = readLenRaw(r);
  if (!encoded) return r.bytes(bigToSafe(len));
  switch (Number(len)) {
    case 0:
      return Buffer.from(String(r.bytes(1).readInt8(0)), 'latin1');
    case 1:
      return Buffer.from(String(r.bytes(2).readInt16LE(0)), 'latin1');
    case 2:
      return Buffer.from(String(r.bytes(4).readInt32LE(0)), 'latin1');
    case 3: {
      const clen = readLen(r);
      const ulen = readLen(r);
      return lzfDecompress(r.bytes(clen), ulen);
    }
    default:
      throw bad();
  }
}

function readStr(r: Reader): string {
  return readStringBuf(r).toString('latin1');
}

/** Parses a score the way strtod would for the forms Redis writes. */
function parseScore(s: string): number {
  const t = s.toLowerCase();
  if (t === 'inf' || t === '+inf' || t === 'infinity' || t === '+infinity') return Infinity;
  if (t === '-inf' || t === '-infinity') return -Infinity;
  if (t === 'nan' || t === '-nan') return NaN;
  const v = Number(s);
  if (s.trim() === '' || Number.isNaN(v)) throw bad();
  return v;
}

/** fpconv_dtoa: shortest round-trip digits with Redis's notation rules (used by d2string). */
function fpconvDtoa(value: number): string {
  const neg = value < 0;
  const [mant, expStr] = Math.abs(value).toExponential().split('e');
  let digits = mant.replace('.', '');
  const E = Number(expStr);
  let ndigits = digits.length;
  const K = E - (ndigits - 1);
  let exp = Math.abs(K + ndigits - 1);
  let out = neg ? '-' : '';
  if (K >= 0 && exp < ndigits + 7) return out + digits + '0'.repeat(K);
  if (K < 0 && (K > -7 || exp < 4)) {
    const offset = ndigits - Math.abs(K);
    if (offset <= 0) return `${out}0.${'0'.repeat(-offset)}${digits}`;
    return `${out}${digits.slice(0, offset)}.${digits.slice(offset)}`;
  }
  ndigits = Math.min(ndigits, 18 - (neg ? 1 : 0));
  digits = digits.slice(0, ndigits);
  out += digits[0];
  if (ndigits > 1) out += `.${digits.slice(1)}`;
  out += 'e';
  out += K + ndigits - 1 < 0 ? '-' : '+';
  let cent = 0;
  if (exp > 99) {
    cent = Math.floor(exp / 100);
    out += String(cent);
    exp -= cent * 100;
  }
  if (exp > 9) {
    const dec = Math.floor(exp / 10);
    out += String(dec);
    exp -= dec * 10;
  } else if (cent) out += '0';
  return out + String(exp % 10);
}

const DOUBLE2LL_LIMIT = 4611686018427387904; // (double)(LLONG_MAX / 2)

/** Listpack element for a zset score: integer when double2ll succeeds, else d2string text. */
function scoreEntry(score: number): ListpackEntry {
  if (Number.isFinite(score) && score >= -DOUBLE2LL_LIMIT && score <= DOUBLE2LL_LIMIT && Number.isInteger(score)) {
    return BigInt(score);
  }
  if (Number.isNaN(score)) return 'nan';
  if (score === Infinity) return 'inf';
  if (score === -Infinity) return '-inf';
  return fpconvDtoa(score);
}

// ---------------------------------------------------------------------------------------------
// Object encoding
// ---------------------------------------------------------------------------------------------

/** Field TTLs (absolute ms) for hashes using Redis 7.4+ hash field expiration. */
export type FieldExpires = Map<string, number>;

export interface EncodedObject {
  type: number;
  body: Buffer;
}

/** isLargeElement / quicklistNodeExceedsLimit for list-max-listpack-size `fill`. */
const QL_OPT_LEVEL = [4096, 8192, 16384, 32768, 65536];
const QL_SIZE_SAFETY_LIMIT = 8192;
const QL_SIZE_ESTIMATE_OVERHEAD = 8;

function qlSizeLimit(fill: number): number {
  return QL_OPT_LEVEL[Math.min(-fill - 1, QL_OPT_LEVEL.length - 1)];
}

function qlExceedsLimit(fill: number, newSz: number, newCount: number): boolean {
  if (fill < 0) return newSz > qlSizeLimit(fill);
  if (newSz > QL_SIZE_SAFETY_LIMIT) return true;
  return newCount > (fill === 0 ? 1 : fill);
}

function qlIsLargeElement(fill: number, sz: number): boolean {
  return fill < 0 ? sz > qlSizeLimit(fill) : sz > QL_SIZE_SAFETY_LIMIT;
}

type QuicklistNode = { plain: true; value: string } | { plain: false; items: string[]; bytes: number };

/**
 * Splits a list into quicklist nodes the way Redis does for a list built by RPUSHing one element
 * at a time: listpack encoding until it would exceed the limit, then the listpack becomes the
 * first quicklist node and further elements go to the tail node or a new node.
 */
function splitQuicklist(list: readonly string[], fill: number): QuicklistNode[] {
  const nodes: QuicklistNode[] = [];
  let quick = false;
  let tail: { plain: false; items: string[]; bytes: number } = { plain: false, items: [], bytes: LP_HDR_SIZE + 1 };
  for (const el of list) {
    const sz = el.length;
    if (!quick) {
      if (!qlExceedsLimit(fill, tail.bytes + sz, tail.items.length + 1)) {
        tail.items.push(el);
        tail.bytes += lpEntryBytes(el);
        continue;
      }
      quick = true;
      if (tail.items.length) nodes.push(tail);
    }
    const last = nodes[nodes.length - 1];
    if (qlIsLargeElement(fill, sz)) {
      nodes.push({ plain: true, value: el });
      continue;
    }
    if (
      last &&
      !last.plain &&
      !qlExceedsLimit(fill, last.bytes + sz + QL_SIZE_ESTIMATE_OVERHEAD, last.items.length + 1)
    ) {
      last.items.push(el);
      last.bytes += lpEntryBytes(el);
    } else {
      tail = { plain: false, items: [el], bytes: LP_HDR_SIZE + 1 + lpEntryBytes(el) };
      nodes.push(tail);
    }
  }
  if (!quick && tail.items.length) nodes.push(tail);
  return nodes;
}

function encodeList(w: Writer, list: readonly string[], o: RdbOptions): number {
  const nodes = splitQuicklist(list, o.listMaxListpackSize);
  writeLen(w, nodes.length);
  for (const n of nodes) {
    if (n.plain) {
      writeLen(w, QUICKLIST_NODE_CONTAINER_PLAIN);
      writeStr(w, n.value, o.rdbCompression);
    } else {
      writeLen(w, QUICKLIST_NODE_CONTAINER_PACKED);
      writeString(w, listpackEncode(n.items), o.rdbCompression);
    }
  }
  return RDB_TYPE.LIST_QUICKLIST_2;
}

function encodeSet(w: Writer, set: ReadonlySet<string>, o: RdbOptions): number {
  const members = [...set];
  if (members.length <= o.setMaxIntsetEntries) {
    const ints: bigint[] = [];
    for (const m of members) {
      const v = stringToInt64(m);
      if (v === null) break;
      ints.push(v);
    }
    if (ints.length === members.length) {
      writeString(w, intsetEncode(ints), o.rdbCompression);
      return RDB_TYPE.SET_INTSET;
    }
  }
  if (members.length <= o.setMaxListpackEntries && members.every((m) => m.length <= o.setMaxListpackValue)) {
    writeString(w, listpackEncode(members), o.rdbCompression);
    return RDB_TYPE.SET_LISTPACK;
  }
  writeLen(w, members.length);
  for (const m of members) writeStr(w, m, o.rdbCompression);
  return RDB_TYPE.SET;
}

function encodeZset(w: Writer, z: ZSet, o: RdbOptions): number {
  if (z.size <= o.zsetMaxListpackEntries && z.entries.every((e) => e.member.length <= o.zsetMaxListpackValue)) {
    const items: ListpackEntry[] = [];
    for (const e of z.entries) items.push(e.member, scoreEntry(e.score));
    writeString(w, listpackEncode(items), o.rdbCompression);
    return RDB_TYPE.ZSET_LISTPACK;
  }
  writeLen(w, z.size);
  for (let i = z.entries.length - 1; i >= 0; i--) {
    writeStr(w, z.entries[i].member, o.rdbCompression);
    w.doubleLe(z.entries[i].score);
  }
  return RDB_TYPE.ZSET_2;
}

function encodeHash(w: Writer, h: ReadonlyMap<string, string>, o: RdbOptions, fieldExpires?: FieldExpires): number {
  const ttls = new Map<string, number>();
  if (fieldExpires) for (const [f, at] of fieldExpires) if (h.has(f)) ttls.set(f, at);
  let small = h.size <= o.hashMaxListpackEntries;
  if (small) {
    for (const [f, v] of h) {
      if (f.length > o.hashMaxListpackValue || v.length > o.hashMaxListpackValue) {
        small = false;
        break;
      }
    }
  }
  if (ttls.size === 0) {
    if (small) {
      const items: string[] = [];
      for (const [f, v] of h) items.push(f, v);
      writeString(w, listpackEncode(items), o.rdbCompression);
      return RDB_TYPE.HASH_LISTPACK;
    }
    writeLen(w, h.size);
    for (const [f, v] of h) {
      writeStr(w, f, o.rdbCompression);
      writeStr(w, v, o.rdbCompression);
    }
    return RDB_TYPE.HASH;
  }
  const minExpire = Math.min(...ttls.values());
  w.u64le(BigInt(minExpire));
  if (small) {
    // listpackEx: (field, value, ttl) triplets ordered by TTL; fields without TTL (0) at the tail.
    const withTtl = [...ttls.entries()].sort((a, b) => a[1] - b[1]);
    const items: ListpackEntry[] = [];
    for (const [f, at] of withTtl) items.push(f, h.get(f)!, BigInt(at));
    for (const [f, v] of h) if (!ttls.has(f)) items.push(f, v, 0n);
    writeString(w, listpackEncode(items), o.rdbCompression);
    return RDB_TYPE.HASH_LISTPACK_EX;
  }
  writeLen(w, h.size);
  for (const [f, v] of h) {
    const at = ttls.get(f);
    writeLen(w, at === undefined ? 0n : BigInt(at) - BigInt(minExpire) + 1n);
    writeStr(w, f, o.rdbCompression);
    writeStr(w, v, o.rdbCompression);
  }
  return RDB_TYPE.HASH_METADATA;
}

function encodeStreamId(id: StreamId): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64BE(BigInt(id.ms), 0);
  b.writeBigUInt64BE(BigInt(id.seq), 8);
  return b;
}

function decodeStreamId(b: Buffer): StreamId {
  if (b.length !== 16) throw bad();
  return { ms: b.readBigUInt64BE(0), seq: b.readBigUInt64BE(8) };
}

interface StreamNode {
  master: StreamId;
  masterFields: string[];
  count: number;
  items: ListpackEntry[];
  itemsBytes: number;
}

function streamNodeEntries(n: StreamNode): ListpackEntry[] {
  return [n.count, 0, n.masterFields.length, ...n.masterFields, 0, ...n.items];
}

function streamNodeBytes(n: StreamNode): number {
  let total = LP_HDR_SIZE + 1 + n.itemsBytes;
  for (const e of [n.count, 0, n.masterFields.length, ...n.masterFields, 0]) total += lpEntryBytes(e);
  return total;
}

/** Packs stream entries into listpack nodes the way streamAppendItem does when only appending. */
function splitStream(entries: readonly StreamEntry[], o: RdbOptions): StreamNode[] {
  const nodes: StreamNode[] = [];
  let maxBytes = o.streamNodeMaxBytes;
  if (maxBytes <= 0 || maxBytes > 1 << 30) maxBytes = 1 << 30;
  let cur: StreamNode | null = null;
  for (const e of entries) {
    let totelelen = 0;
    for (const f of e.fields) totelelen += f.length;
    if (cur) {
      if (streamNodeBytes(cur) + totelelen >= maxBytes) cur = null;
      else if (o.streamNodeMaxEntries > 0 && cur.count >= o.streamNodeMaxEntries) cur = null;
    }
    if (!cur) {
      const masterFields: string[] = [];
      for (let i = 0; i < e.fields.length; i += 2) masterFields.push(e.fields[i]);
      cur = { master: e.id, masterFields, count: 0, items: [], itemsBytes: 0 };
      nodes.push(cur);
    }
    const nf = e.fields.length >> 1;
    const same = nf === cur.masterFields.length && cur.masterFields.every((f, i) => e.fields[2 * i] === f);
    const item: ListpackEntry[] = [same ? 2 : 0, BigInt(e.id.ms) - BigInt(cur.master.ms), BigInt(e.id.seq) - BigInt(cur.master.seq)];
    if (same) {
      for (let i = 0; i < nf; i++) item.push(e.fields[2 * i + 1]);
    } else {
      item.push(nf);
      for (let i = 0; i < nf * 2; i++) item.push(e.fields[i]);
    }
    item.push(nf + 3 + (same ? 0 : nf + 1));
    for (const x of item) cur.itemsBytes += lpEntryBytes(x);
    cur.items.push(...item);
    cur.count++;
  }
  return nodes;
}

const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function sortedPending(m: ReadonlyMap<string, PendingEntry>): PendingEntry[] {
  return [...m.values()].sort((a, b) => compareIds(a.id, b.id));
}

function encodeStream(w: Writer, s: Stream, o: RdbOptions): number {
  const nodes = splitStream(s.entries, o);
  writeLen(w, nodes.length);
  for (const n of nodes) {
    writeString(w, encodeStreamId(n.master), o.rdbCompression);
    writeString(w, listpackEncode(streamNodeEntries(n)), o.rdbCompression);
  }
  writeLen(w, s.entries.length);
  writeLen(w, BigInt(s.lastId.ms));
  writeLen(w, BigInt(s.lastId.seq));
  const first = s.entries[0]?.id ?? { ms: 0n, seq: 0n };
  writeLen(w, BigInt(first.ms));
  writeLen(w, BigInt(first.seq));
  writeLen(w, BigInt(s.maxDeletedId.ms));
  writeLen(w, BigInt(s.maxDeletedId.seq));
  writeLen(w, BigInt(s.entriesAdded));
  const groups = [...s.groups.values()].sort(byName);
  writeLen(w, groups.length);
  for (const g of groups) {
    writeStr(w, g.name, o.rdbCompression);
    writeLen(w, BigInt(g.lastId.ms));
    writeLen(w, BigInt(g.lastId.seq));
    writeLen(w, g.entriesRead === null ? -1n : BigInt(g.entriesRead));
    const pel = sortedPending(g.pending);
    writeLen(w, pel.length);
    for (const p of pel) {
      w.bytes(encodeStreamId(p.id));
      w.u64le(BigInt(p.deliveryTime));
      writeLen(w, p.deliveryCount);
    }
    const consumers = [...g.consumers.values()].sort(byName);
    writeLen(w, consumers.length);
    for (const c of consumers) {
      writeStr(w, c.name, o.rdbCompression);
      w.u64le(BigInt(c.seenTime));
      w.u64le(BigInt(c.activeTime));
      const cpel = sortedPending(c.pending);
      writeLen(w, cpel.length);
      for (const p of cpel) w.bytes(encodeStreamId(p.id));
    }
  }
  return RDB_TYPE.STREAM_LISTPACKS_3;
}

function writeObject(w: Writer, value: RedisValue, o: RdbOptions, fieldExpires?: FieldExpires): number {
  switch (value.type) {
    case 'string':
      writeStr(w, value.value, o.rdbCompression);
      return RDB_TYPE.STRING;
    case 'list':
      return encodeList(w, value.value, o);
    case 'set':
      return encodeSet(w, value.value, o);
    case 'zset':
      return encodeZset(w, value.value, o);
    case 'hash':
      return encodeHash(w, value.value, o, fieldExpires);
    case 'stream':
      return encodeStream(w, value.value, o);
  }
}

/** Serializes a value's object body (no type byte) and returns the RDB type Redis would pick. */
export function encodeObject(value: RedisValue, opts?: Partial<RdbOptions>, fieldExpires?: FieldExpires): EncodedObject {
  const w = new Writer();
  const type = writeObject(w, value, resolveOptions(opts), fieldExpires);
  return { type, body: w.toBuffer() };
}

// ---------------------------------------------------------------------------------------------
// Object decoding
// ---------------------------------------------------------------------------------------------

export interface DecodedObject {
  value: RedisValue;
  /** Absolute ms field TTLs for hashes saved with field expiration (types 22-25). */
  fieldExpires?: FieldExpires;
}

function pairsToHash(items: readonly string[]): Map<string, string> {
  if (items.length % 2) throw bad();
  const h = new Map<string, string>();
  for (let i = 0; i < items.length; i += 2) h.set(items[i], items[i + 1]);
  return h;
}

function pairsToZset(items: Array<string | bigint>): ZSet {
  if (items.length % 2) throw bad();
  const z = new ZSet();
  for (let i = 0; i < items.length; i += 2) {
    const sc = items[i + 1];
    z.add(entryToString(items[i]), typeof sc === 'bigint' ? Number(sc) : parseScore(sc));
  }
  return z;
}

function readDoubleV1(r: Reader): number {
  const len = r.u8();
  if (len === 253) return NaN;
  if (len === 254) return Infinity;
  if (len === 255) return -Infinity;
  return parseScore(r.bytes(len).toString('latin1'));
}

function readStream(r: Reader, type: number): Stream {
  const s = new Stream();
  const nodes = readLen(r);
  for (let n = 0; n < nodes; n++) {
    const master = decodeStreamId(readStringBuf(r));
    const items = listpackDecode(readStringBuf(r));
    let i = 0;
    const next = (): string | bigint => {
      if (i >= items.length) throw bad();
      return items[i++];
    };
    const nextInt = (): bigint => {
      const v = next();
      if (typeof v !== 'bigint') throw bad();
      return v;
    };
    const count = nextInt();
    const deleted = nextInt();
    const nf = Number(nextInt());
    const masterFields: string[] = [];
    for (let k = 0; k < nf; k++) masterFields.push(entryToString(next()));
    if (nextInt() !== 0n) throw bad();
    const total = Number(count + deleted);
    for (let k = 0; k < total; k++) {
      const flags = Number(nextInt());
      const ms = master.ms + nextInt();
      const seq = master.seq + nextInt();
      const fields: string[] = [];
      if (flags & 2) {
        for (const f of masterFields) fields.push(f, entryToString(next()));
      } else {
        const n2 = Number(nextInt());
        for (let j = 0; j < n2 * 2; j++) fields.push(entryToString(next()));
      }
      nextInt(); // lp-count
      if (!(flags & 1)) s.entries.push({ id: { ms, seq }, fields });
    }
    if (i !== items.length) throw bad();
  }
  const length = readLen(r);
  if (length !== s.entries.length) throw bad();
  s.lastId = { ms: readLenBig(r), seq: readLenBig(r) };
  if (type >= RDB_TYPE.STREAM_LISTPACKS_2) {
    readLen(r); // first id ms (derived from entries)
    readLen(r); // first id seq
    s.maxDeletedId = { ms: readLenBig(r), seq: readLenBig(r) };
    s.entriesAdded = readLen(r);
  } else {
    s.entriesAdded = s.entries.length;
  }
  const ngroups = readLen(r);
  for (let g = 0; g < ngroups; g++) {
    const name = readStr(r);
    const lastId = { ms: readLenBig(r), seq: readLenBig(r) };
    let entriesRead: number | null = null;
    if (type >= RDB_TYPE.STREAM_LISTPACKS_2) {
      const er = readLenBig(r);
      entriesRead = er >= 1n << 63n ? null : bigToSafe(er);
    }
    const group: ConsumerGroup = { name, lastId, entriesRead, pending: new Map(), consumers: new Map() };
    const npel = readLen(r);
    for (let k = 0; k < npel; k++) {
      const id = decodeStreamId(r.bytes(16));
      const deliveryTime = Number(r.i64le());
      const deliveryCount = readLen(r);
      group.pending.set(idToString(id), { id, consumer: '', deliveryTime, deliveryCount });
    }
    const nconsumers = readLen(r);
    for (let k = 0; k < nconsumers; k++) {
      const cname = readStr(r);
      const seenTime = Number(r.i64le());
      const activeTime = type >= RDB_TYPE.STREAM_LISTPACKS_3 ? Number(r.i64le()) : seenTime;
      const consumer: Consumer = { name: cname, seenTime, activeTime, pending: new Map() };
      const cpel = readLen(r);
      for (let j = 0; j < cpel; j++) {
        const key = idToString(decodeStreamId(r.bytes(16)));
        const p = group.pending.get(key);
        if (!p) throw bad();
        p.consumer = cname;
        consumer.pending.set(key, p);
      }
      group.consumers.set(cname, consumer);
    }
    s.groups.set(name, group);
  }
  return s;
}

function readObject(r: Reader, type: number): DecodedObject {
  switch (type) {
    case RDB_TYPE.STRING:
      return { value: { type: 'string', value: readStr(r) } };
    case RDB_TYPE.LIST: {
      const n = readLen(r);
      const list: string[] = [];
      for (let i = 0; i < n; i++) list.push(readStr(r));
      return { value: { type: 'list', value: list } };
    }
    case RDB_TYPE.LIST_ZIPLIST:
      return { value: { type: 'list', value: ziplistDecode(readStringBuf(r)).map(entryToString) } };
    case RDB_TYPE.LIST_QUICKLIST:
    case RDB_TYPE.LIST_QUICKLIST_2: {
      const n = readLen(r);
      const list: string[] = [];
      for (let i = 0; i < n; i++) {
        if (type === RDB_TYPE.LIST_QUICKLIST) {
          list.push(...ziplistDecode(readStringBuf(r)).map(entryToString));
          continue;
        }
        const container = readLen(r);
        const blob = readStringBuf(r);
        if (container === QUICKLIST_NODE_CONTAINER_PLAIN) list.push(blob.toString('latin1'));
        else if (container === QUICKLIST_NODE_CONTAINER_PACKED) list.push(...listpackStrings(blob));
        else throw bad();
      }
      return { value: { type: 'list', value: list } };
    }
    case RDB_TYPE.SET: {
      const n = readLen(r);
      const set = new Set<string>();
      for (let i = 0; i < n; i++) set.add(readStr(r));
      return { value: { type: 'set', value: set } };
    }
    case RDB_TYPE.SET_INTSET:
      return { value: { type: 'set', value: new Set(intsetDecode(readStringBuf(r)).map((v) => v.toString())) } };
    case RDB_TYPE.SET_LISTPACK:
      return { value: { type: 'set', value: new Set(listpackStrings(readStringBuf(r))) } };
    case RDB_TYPE.ZSET:
    case RDB_TYPE.ZSET_2: {
      const n = readLen(r);
      const z = new ZSet();
      for (let i = 0; i < n; i++) {
        const member = readStr(r);
        z.add(member, type === RDB_TYPE.ZSET_2 ? r.doubleLe() : readDoubleV1(r));
      }
      return { value: { type: 'zset', value: z } };
    }
    case RDB_TYPE.ZSET_ZIPLIST:
      return { value: { type: 'zset', value: pairsToZset(ziplistDecode(readStringBuf(r))) } };
    case RDB_TYPE.ZSET_LISTPACK:
      return { value: { type: 'zset', value: pairsToZset(listpackDecode(readStringBuf(r))) } };
    case RDB_TYPE.HASH: {
      const n = readLen(r);
      const h = new Map<string, string>();
      for (let i = 0; i < n; i++) {
        const f = readStr(r);
        h.set(f, readStr(r));
      }
      return { value: { type: 'hash', value: h } };
    }
    case RDB_TYPE.HASH_ZIPMAP:
      return { value: { type: 'hash', value: pairsToHash(zipmapDecode(readStringBuf(r))) } };
    case RDB_TYPE.HASH_ZIPLIST:
      return { value: { type: 'hash', value: pairsToHash(ziplistDecode(readStringBuf(r)).map(entryToString)) } };
    case RDB_TYPE.HASH_LISTPACK:
      return { value: { type: 'hash', value: pairsToHash(listpackStrings(readStringBuf(r))) } };
    case RDB_TYPE.HASH_METADATA_PRE_GA:
    case RDB_TYPE.HASH_METADATA: {
      const minExpire = type === RDB_TYPE.HASH_METADATA ? r.i64le() : 0n;
      const n = readLen(r);
      const h = new Map<string, string>();
      const fe: FieldExpires = new Map();
      for (let i = 0; i < n; i++) {
        const ttl = readLenBig(r);
        const f = readStr(r);
        h.set(f, readStr(r));
        if (ttl !== 0n) fe.set(f, Number(type === RDB_TYPE.HASH_METADATA ? ttl + minExpire - 1n : ttl));
      }
      return { value: { type: 'hash', value: h }, fieldExpires: fe };
    }
    case RDB_TYPE.HASH_LISTPACK_EX_PRE_GA:
    case RDB_TYPE.HASH_LISTPACK_EX: {
      if (type === RDB_TYPE.HASH_LISTPACK_EX) r.i64le(); // min expire
      const items = listpackDecode(readStringBuf(r));
      if (items.length % 3) throw bad();
      const h = new Map<string, string>();
      const fe: FieldExpires = new Map();
      for (let i = 0; i < items.length; i += 3) {
        const f = entryToString(items[i]);
        h.set(f, entryToString(items[i + 1]));
        const ttl = items[i + 2];
        if (typeof ttl !== 'bigint') throw bad();
        if (ttl !== 0n) fe.set(f, Number(ttl));
      }
      return { value: { type: 'hash', value: h }, fieldExpires: fe };
    }
    case RDB_TYPE.STREAM_LISTPACKS:
    case RDB_TYPE.STREAM_LISTPACKS_2:
    case RDB_TYPE.STREAM_LISTPACKS_3:
      return { value: { type: 'stream', value: readStream(r, type) } };
    case RDB_TYPE.MODULE_PRE_GA:
    case RDB_TYPE.MODULE_2:
      throw new Error('Module data types are not supported');
    default:
      throw bad();
  }
}

function isEmptyAggregate(v: RedisValue): boolean {
  switch (v.type) {
    case 'hash':
    case 'set':
    case 'zset':
      return v.value.size === 0;
    case 'list':
      return v.value.length === 0;
    default:
      return false;
  }
}

/** Decodes an object body of the given RDB type. */
export function decodeObject(type: number, body: Buffer): DecodedObject {
  return readObject(new Reader(body), type);
}

// ---------------------------------------------------------------------------------------------
// DUMP / RESTORE
// ---------------------------------------------------------------------------------------------

/** DUMP payload: type byte + object + RDB version (2 bytes LE) + CRC64 (8 bytes LE). */
export function dumpPayload(value: RedisValue, opts?: Partial<RdbOptions>, fieldExpires?: FieldExpires): Buffer {
  const { type, body } = encodeObject(value, opts, fieldExpires);
  const head = Buffer.alloc(1 + body.length + 2);
  head[0] = type;
  body.copy(head, 1);
  head.writeUInt16LE(RDB_VERSION, 1 + body.length);
  const crc = Buffer.alloc(8);
  crc.writeBigUInt64LE(crc64(head), 0);
  return Buffer.concat([head, crc]);
}

/** Checks a DUMP payload's footer; throws 'DUMP payload version or checksum are wrong'. */
export function verifyDumpPayload(buf: Buffer, skipChecksum = false): void {
  if (buf.length < 10) throw new Error(DUMP_ERROR);
  const footer = buf.length - 10;
  const version = buf.readUInt16LE(footer);
  if (version > RDB_VERSION) throw new Error(DUMP_ERROR);
  if (skipChecksum) return;
  if (crc64(buf.subarray(0, buf.length - 8)) !== buf.readBigUInt64LE(buf.length - 8)) throw new Error(DUMP_ERROR);
}

/** Decodes a DUMP payload, including hash field TTLs. Throws 'Bad data format' on corrupt bodies. */
export function restorePayloadEx(buf: Buffer, skipChecksum = false): DecodedObject {
  verifyDumpPayload(buf, skipChecksum);
  const r = new Reader(buf.subarray(0, buf.length - 10));
  const decoded = readObject(r, r.u8());
  if (isEmptyAggregate(decoded.value)) throw bad();
  return decoded;
}

export function restorePayload(buf: Buffer, skipChecksum = false): RedisValue {
  return restorePayloadEx(buf, skipChecksum).value;
}

/** FUNCTION DUMP payload: a FUNCTION2 record per library, then the 2-byte RDB version and the CRC64, like DUMP. */
export function functionsDumpPayload(codes: readonly string[]): Buffer {
  const w = new Writer();
  for (const code of codes) {
    w.u8(RDB_OPCODE.FUNCTION2);
    writeStr(w, code, true);
  }
  const head = Buffer.concat([w.toBuffer(), Buffer.alloc(2)]);
  head.writeUInt16LE(RDB_VERSION, head.length - 2);
  const crc = Buffer.alloc(8);
  crc.writeBigUInt64LE(crc64(head), 0);
  return Buffer.concat([head, crc]);
}

/** Decodes a FUNCTION DUMP payload into library codes. Throws 'DUMP payload version or checksum are wrong' / 'Bad data format'. */
export function functionsRestorePayload(buf: Buffer): string[] {
  verifyDumpPayload(buf);
  const r = new Reader(buf.subarray(0, buf.length - 10));
  const codes: string[] = [];
  while (r.pos < r.buf.length) {
    if (r.u8() !== RDB_OPCODE.FUNCTION2) throw bad();
    codes.push(readStr(r));
  }
  return codes;
}

// ---------------------------------------------------------------------------------------------
// RDB files
// ---------------------------------------------------------------------------------------------

/** One key in an RDB database. `expireAt` and field TTLs are absolute unix ms. */
export interface RdbKeyEntry {
  value: RedisValue;
  expireAt?: number;
  fieldExpires?: FieldExpires;
  /** LRU idle seconds (RDB_OPCODE_IDLE), only written when set. */
  idle?: number;
  /** LFU counter (RDB_OPCODE_FREQ), only written when set. */
  freq?: number;
}

/** key → entry, in the order keys should be written. */
export type RdbDatabase = Map<string, RdbKeyEntry>;

/** AUX fields in write order; numbers use Redis's integer string encoding. */
export type RdbAux = Array<[string, string | number]>;

export interface RdbFile {
  version: number;
  aux: Map<string, string>;
  /** Library source code of each FUNCTION2 record, in file order. */
  functions: string[];
  /** Index = db number; databases absent from the file are empty maps. */
  dbs: RdbDatabase[];
}

export interface RdbAuxInput {
  redisVer?: string;
  ctime?: number; // unix seconds
  usedMem?: number;
  aofBase?: boolean;
}

/** The AUX fields Redis writes for a standalone instance, in Redis's order. */
export function defaultRdbAux(input: RdbAuxInput = {}): RdbAux {
  return [
    ['redis-ver', input.redisVer ?? '8.8.0'],
    ['redis-bits', 64],
    ['ctime', input.ctime ?? Math.floor(Date.now() / 1000)],
    ['used-mem', input.usedMem ?? 0],
    ['aof-base', input.aofBase ? 1 : 0],
  ];
}

/**
 * Writes a complete RDB file: magic, AUX fields, FUNCTION2 records, then for each non-empty db
 * SELECTDB + RESIZEDB + keys (EXPIRETIME_MS / IDLE / FREQ prefixes), EOF and the CRC64 trailer
 * (zero when `rdbChecksum` is off).
 */
export function writeRdb(
  dbs: ReadonlyArray<RdbDatabase | undefined>,
  aux: RdbAux,
  functions: readonly string[] = [],
  opts?: Partial<RdbOptions>,
): Buffer {
  const o = resolveOptions(opts);
  const w = new Writer();
  w.bytes(Buffer.from(`REDIS${String(RDB_VERSION).padStart(4, '0')}`, 'latin1'));
  for (const [k, v] of aux) {
    w.u8(RDB_OPCODE.AUX);
    writeStr(w, k, o.rdbCompression);
    if (typeof v === 'number') writeLongLongString(w, v);
    else writeStr(w, v, o.rdbCompression);
  }
  for (const code of functions) {
    w.u8(RDB_OPCODE.FUNCTION2);
    writeStr(w, code, o.rdbCompression);
  }
  dbs.forEach((db, dbid) => {
    if (!db || db.size === 0) return;
    w.u8(RDB_OPCODE.SELECTDB);
    writeLen(w, dbid);
    let expires = 0;
    for (const e of db.values()) if (e.expireAt !== undefined) expires++;
    w.u8(RDB_OPCODE.RESIZEDB);
    writeLen(w, db.size);
    writeLen(w, expires);
    for (const [key, e] of db) {
      if (e.expireAt !== undefined) {
        w.u8(RDB_OPCODE.EXPIRETIME_MS);
        w.u64le(BigInt(e.expireAt));
      }
      if (e.idle !== undefined) {
        w.u8(RDB_OPCODE.IDLE);
        writeLen(w, e.idle);
      }
      if (e.freq !== undefined) {
        w.u8(RDB_OPCODE.FREQ);
        w.u8(e.freq);
      }
      const { type, body } = encodeObject(e.value, o, e.fieldExpires);
      w.u8(type);
      writeStr(w, key, o.rdbCompression);
      w.bytes(body);
    }
  });
  w.u8(RDB_OPCODE.EOF);
  const head = w.toBuffer();
  const trailer = Buffer.alloc(8);
  if (o.rdbChecksum) trailer.writeBigUInt64LE(crc64(head), 0);
  return Buffer.concat([head, trailer]);
}

/**
 * Parses an RDB file. Accepts versions 1..RDB_VERSION, skips keys whose value is an empty
 * aggregate (as Redis does), and verifies the trailer CRC unless it is zero.
 * Expired keys are returned as-is; the caller decides whether to drop them.
 */
export function readRdb(buf: Buffer): RdbFile {
  if (buf.length < 9 || buf.toString('latin1', 0, 5) !== 'REDIS') throw new Error('Wrong signature trying to load DB from file');
  const verStr = buf.toString('latin1', 5, 9);
  const version = /^\d{4}$/.test(verStr) ? Number(verStr) : NaN;
  if (!(version >= 1 && version <= RDB_VERSION)) throw new Error(`Can't handle RDB format version ${verStr}`);
  const r = new Reader(buf);
  r.pos = 9;
  const file: RdbFile = { version, aux: new Map(), functions: [], dbs: [] };
  let db: RdbDatabase = new Map();
  const selectDb = (id: number): void => {
    while (file.dbs.length <= id) file.dbs.push(new Map());
    db = file.dbs[id];
  };
  selectDb(0);
  let expireAt: number | undefined;
  let idle: number | undefined;
  let freq: number | undefined;
  for (;;) {
    const op = r.u8();
    switch (op) {
      case RDB_OPCODE.EXPIRETIME_MS:
        expireAt = Number(r.i64le());
        continue;
      case RDB_OPCODE.EXPIRETIME: {
        expireAt = r.bytes(4).readInt32LE(0) * 1000;
        continue;
      }
      case RDB_OPCODE.IDLE:
        idle = readLen(r);
        continue;
      case RDB_OPCODE.FREQ:
        freq = r.u8();
        continue;
      case RDB_OPCODE.SELECTDB:
        selectDb(readLen(r));
        continue;
      case RDB_OPCODE.RESIZEDB:
        readLen(r);
        readLen(r);
        continue;
      case RDB_OPCODE.SLOT_INFO:
        readLen(r);
        readLen(r);
        readLen(r);
        continue;
      case RDB_OPCODE.AUX: {
        const k = readStr(r);
        file.aux.set(k, readStr(r));
        continue;
      }
      case RDB_OPCODE.FUNCTION2:
        file.functions.push(readStr(r));
        continue;
      case RDB_OPCODE.FUNCTION_PRE_GA:
        throw new Error('Pre-release function format not supported');
      case RDB_OPCODE.MODULE_AUX:
        throw new Error('Module auxiliary data is not supported');
      case RDB_OPCODE.EOF: {
        if (version >= 5) {
          const stored = r.bytes(8).readBigUInt64LE(0);
          if (stored !== 0n && stored !== crc64(buf.subarray(0, r.pos - 8))) throw new Error('Wrong RDB checksum');
        }
        return file;
      }
      default: {
        const key = readStr(r);
        const decoded = readObject(r, op);
        if (!isEmptyAggregate(decoded.value)) {
          const entry: RdbKeyEntry = { value: decoded.value };
          if (expireAt !== undefined) entry.expireAt = expireAt;
          if (decoded.fieldExpires && decoded.fieldExpires.size) entry.fieldExpires = decoded.fieldExpires;
          if (idle !== undefined) entry.idle = idle;
          if (freq !== undefined) entry.freq = freq;
          db.set(key, entry);
        }
        expireAt = undefined;
        idle = undefined;
        freq = undefined;
      }
    }
  }
}
