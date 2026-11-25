import PersistenceBytesCodec from './persistence.bytes.codec';
import type { RdbReader, RdbWriter } from './persistence.bytes.codec';
import type { ListpackEntry, RdbOptions } from './persistence.types';

/**
 * RDB primitives shared by the object codecs and the file / DUMP services: encoding options, length prefixes,
 * (integer-encoded / LZF-compressed) strings and the score text Redis stores in listpacks.
 */
export default class PersistenceRdbIoCodec {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  static readonly DEFAULT_OPTIONS: Readonly<RdbOptions> = Object.freeze({
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

  /** (double)(LLONG_MAX / 2): the range in which double2ll accepts a score. */
  private static readonly DOUBLE2LL_LIMIT = 4611686018427387904;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** rdbEncodeInteger: the 0xC0/0xC1/0xC2 special encodings for values fitting 8/16/32 bits. */
  private static encodeRdbInt(v: number): Buffer | null {
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

  private static readLenRaw(r: RdbReader): { len: bigint; encoded: boolean } {
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
    throw PersistenceBytesCodec.badFormat();
  }

  /** fpconv_dtoa: shortest round-trip digits with Redis's notation rules (used by d2string). */
  private static fpconvDtoa(value: number): string {
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

  // ──────────────────────────────────────────────
  // Public Methods: options
  // ──────────────────────────────────────────────

  static resolveOptions(opts?: Partial<RdbOptions>): RdbOptions {
    return { ...PersistenceRdbIoCodec.DEFAULT_OPTIONS, ...opts };
  }

  // ──────────────────────────────────────────────
  // Public Methods: writing
  // ──────────────────────────────────────────────

  static writeLen(w: RdbWriter, n: number | bigint): void {
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

  /** rdbSaveRawString: integer encoding for short canonical ints, LZF for len > 20, else raw. */
  static writeString(w: RdbWriter, s: Buffer, compress: boolean): void {
    const io = PersistenceRdbIoCodec;
    const len = s.length;
    if (len <= 11 && len > 0) {
      const str = s.toString('latin1');
      if (PersistenceBytesCodec.CANONICAL_INT.test(str)) {
        const enc = io.encodeRdbInt(Number(str));
        if (enc) {
          w.bytes(enc);
          return;
        }
      }
    }
    if (compress && len > 20) {
      const c = PersistenceBytesCodec.lzfCompress(s, len - 4);
      if (c) {
        w.u8(0xc3);
        io.writeLen(w, c.length);
        io.writeLen(w, len);
        w.bytes(c);
        return;
      }
    }
    io.writeLen(w, len);
    w.bytes(s);
  }

  static writeStr(w: RdbWriter, s: string, compress: boolean): void {
    PersistenceRdbIoCodec.writeString(w, Buffer.from(s, 'latin1'), compress);
  }

  /** rdbSaveLongLongAsStringObject. */
  static writeLongLongString(w: RdbWriter, v: number | bigint): void {
    const big = BigInt(v);
    if (big >= -2147483648n && big <= 2147483647n) {
      w.bytes(PersistenceRdbIoCodec.encodeRdbInt(Number(big))!);
      return;
    }
    const s = Buffer.from(big.toString(), 'latin1');
    PersistenceRdbIoCodec.writeLen(w, s.length);
    w.bytes(s);
  }

  // ──────────────────────────────────────────────
  // Public Methods: reading
  // ──────────────────────────────────────────────

  static readLenBig(r: RdbReader): bigint {
    const { len, encoded } = PersistenceRdbIoCodec.readLenRaw(r);
    if (encoded) throw PersistenceBytesCodec.badFormat();
    return len;
  }

  static readLen(r: RdbReader): number {
    return PersistenceBytesCodec.bigToSafe(PersistenceRdbIoCodec.readLenBig(r));
  }

  static readStringBuf(r: RdbReader): Buffer {
    const io = PersistenceRdbIoCodec;
    const { len, encoded } = io.readLenRaw(r);
    if (!encoded) return r.bytes(PersistenceBytesCodec.bigToSafe(len));
    switch (Number(len)) {
      case 0:
        return Buffer.from(String(r.bytes(1).readInt8(0)), 'latin1');
      case 1:
        return Buffer.from(String(r.bytes(2).readInt16LE(0)), 'latin1');
      case 2:
        return Buffer.from(String(r.bytes(4).readInt32LE(0)), 'latin1');
      case 3: {
        const clen = io.readLen(r);
        const ulen = io.readLen(r);
        return PersistenceBytesCodec.lzfDecompress(r.bytes(clen), ulen);
      }
      default:
        throw PersistenceBytesCodec.badFormat();
    }
  }

  static readStr(r: RdbReader): string {
    return PersistenceRdbIoCodec.readStringBuf(r).toString('latin1');
  }

  // ──────────────────────────────────────────────
  // Public Methods: scores
  // ──────────────────────────────────────────────

  /** Parses a score the way strtod would for the forms Redis writes. */
  static parseScore(s: string): number {
    const t = s.toLowerCase();
    if (t === 'inf' || t === '+inf' || t === 'infinity' || t === '+infinity') return Infinity;
    if (t === '-inf' || t === '-infinity') return -Infinity;
    if (t === 'nan' || t === '-nan') return NaN;
    const v = Number(s);
    if (s.trim() === '' || Number.isNaN(v)) throw PersistenceBytesCodec.badFormat();
    return v;
  }

  /** Listpack element for a zset score: integer when double2ll succeeds, else d2string text. */
  static scoreEntry(score: number): ListpackEntry {
    const limit = PersistenceRdbIoCodec.DOUBLE2LL_LIMIT;
    if (Number.isFinite(score) && score >= -limit && score <= limit && Number.isInteger(score)) {
      return BigInt(score);
    }
    if (Number.isNaN(score)) return 'nan';
    if (score === Infinity) return 'inf';
    if (score === -Infinity) return '-inf';
    return PersistenceRdbIoCodec.fpconvDtoa(score);
  }
}
