import PersistenceBytesCodec from './persistence.bytes.codec';
import type { ListpackEntry } from './persistence.types';

/**
 * Compact encodings Redis embeds in RDB string blobs: listpack (encode + decode), intset (encode + decode) and the
 * legacy ziplist / zipmap (decode only: Redis 7+ never writes them).
 */
export default class PersistenceListpackCodec {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Listpack header: total bytes (u32) + element count (u16). */
  static readonly LP_HDR_SIZE = 6;
  private static readonly LP_EOF = 0xff;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static encodeEntry(e: ListpackEntry): Buffer {
    const B = PersistenceBytesCodec;
    let iv: bigint | null;
    if (typeof e === 'string') iv = B.stringToInt64(e);
    else iv = B.toBig(e);
    if (iv !== null) {
      const v = iv;
      if (v >= 0n && v <= 127n) return Buffer.from([Number(v)]);
      if (v >= -4096n && v <= 4095n) {
        const u = Number(BigInt.asUintN(13, v));
        return Buffer.from([0xc0 | (u >> 8), u & 0xff]);
      }
      const [tag, size] = B.inRange(v, 16) ? [0xf1, 2] : B.inRange(v, 24) ? [0xf2, 3] : B.inRange(v, 32) ? [0xf3, 4] : [0xf4, 8];
      const out = Buffer.alloc(1 + size);
      out[0] = tag;
      B.writeIntLE(out, 1, v, size);
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

  private static backlenSize(l: number): number {
    if (l <= 127) return 1;
    if (l < 16383) return 2;
    if (l < 2097151) return 3;
    if (l < 268435455) return 4;
    return 5;
  }

  private static encodeBacklen(l: number): Buffer {
    const n = PersistenceListpackCodec.backlenSize(l);
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      const shift = 7 * (n - 1 - i);
      const part = Math.floor(l / 2 ** shift) & 127;
      out[i] = i === 0 ? part : part | 128;
    }
    return out;
  }

  // ──────────────────────────────────────────────
  // Public Methods: listpack
  // ──────────────────────────────────────────────

  /** Bytes one element takes in a listpack (encoding + backlen). */
  static entryBytes(e: ListpackEntry): number {
    const l = PersistenceListpackCodec.encodeEntry(e).length;
    return l + PersistenceListpackCodec.backlenSize(l);
  }

  /** Serialized size of a listpack holding `entries` (header + entries + terminator). */
  static listpackBytes(entries: Iterable<ListpackEntry>): number {
    let total = PersistenceListpackCodec.LP_HDR_SIZE + 1;
    for (const e of entries) total += PersistenceListpackCodec.entryBytes(e);
    return total;
  }

  static listpackEncode(entries: readonly ListpackEntry[]): Buffer {
    const L = PersistenceListpackCodec;
    const parts: Buffer[] = [Buffer.alloc(L.LP_HDR_SIZE)];
    let total = L.LP_HDR_SIZE + 1;
    for (const e of entries) {
      const enc = L.encodeEntry(e);
      const back = L.encodeBacklen(enc.length);
      parts.push(enc, back);
      total += enc.length + back.length;
    }
    parts.push(Buffer.from([L.LP_EOF]));
    const out = Buffer.concat(parts, total);
    out.writeUInt32LE(total, 0);
    out.writeUInt16LE(Math.min(entries.length, 65535), 4);
    return out;
  }

  /** Decodes a listpack. Integer-encoded elements come back as bigint, strings as binary strings. */
  static listpackDecode(buf: Buffer): Array<string | bigint> {
    const L = PersistenceListpackCodec;
    const bad = PersistenceBytesCodec.badFormat;
    if (buf.length < L.LP_HDR_SIZE + 1 || buf.readUInt32LE(0) !== buf.length) throw bad();
    const declared = buf.readUInt16LE(4);
    const out: Array<string | bigint> = [];
    let p = L.LP_HDR_SIZE;
    for (;;) {
      if (p >= buf.length) throw bad();
      const b = buf[p];
      if (b === L.LP_EOF) break;
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
        out.push(PersistenceBytesCodec.readIntLE(buf, p + 1, size));
      }
      p += encLen + L.backlenSize(encLen);
    }
    if (p !== buf.length - 1) throw bad();
    if (declared !== 65535 && declared !== out.length) throw bad();
    return out;
  }

  /** A decoded element as a binary string (integers in decimal). */
  static entryToString(e: string | bigint): string {
    return typeof e === 'string' ? e : e.toString();
  }

  /** Decodes a listpack into strings. */
  static listpackStrings(buf: Buffer): string[] {
    return PersistenceListpackCodec.listpackDecode(buf).map(PersistenceListpackCodec.entryToString);
  }

  // ──────────────────────────────────────────────
  // Public Methods: intset, ziplist, zipmap
  // ──────────────────────────────────────────────

  /** Encodes canonical-integer members as an intset (sorted, smallest common width). */
  static intsetEncode(values: Iterable<bigint>): Buffer {
    const B = PersistenceBytesCodec;
    const sorted = [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let width = 2;
    for (const v of sorted) {
      if (!B.inRange(v, 16)) width = Math.max(width, B.inRange(v, 32) ? 4 : 8);
    }
    const out = Buffer.alloc(8 + sorted.length * width);
    out.writeUInt32LE(width, 0);
    out.writeUInt32LE(sorted.length, 4);
    sorted.forEach((v, i) => B.writeIntLE(out, 8 + i * width, v, width));
    return out;
  }

  static intsetDecode(buf: Buffer): bigint[] {
    const bad = PersistenceBytesCodec.badFormat;
    if (buf.length < 8) throw bad();
    const width = buf.readUInt32LE(0);
    const len = buf.readUInt32LE(4);
    if ((width !== 2 && width !== 4 && width !== 8) || buf.length !== 8 + len * width) throw bad();
    const out: bigint[] = [];
    for (let i = 0; i < len; i++) out.push(PersistenceBytesCodec.readIntLE(buf, 8 + i * width, width));
    return out;
  }

  /** Decodes a legacy ziplist (pre Redis 7 encoding). */
  static ziplistDecode(buf: Buffer): Array<string | bigint> {
    const bad = PersistenceBytesCodec.badFormat;
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
          out.push(PersistenceBytesCodec.readIntLE(buf, p + 1, size));
          p += 1 + size;
        }
      }
    }
    if (p !== buf.length - 1) throw bad();
    return out;
  }

  /** Decodes a legacy zipmap (Redis < 2.6 small hashes) into [field, value, field, value, ...]. */
  static zipmapDecode(buf: Buffer): string[] {
    const bad = PersistenceBytesCodec.badFormat;
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
}
