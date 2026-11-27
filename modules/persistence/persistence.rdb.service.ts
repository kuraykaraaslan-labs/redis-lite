import { formatMessage } from '@/libs/message-format';

import { REDIS_VERSION } from '@/modules/server/server.constants';

import PersistenceBytesCodec, { RdbReader, RdbWriter } from './persistence.bytes.codec';
import { RDB_OPCODE, RDB_VERSION } from './persistence.enums';
import PersistenceMessages from './persistence.messages';
import PersistenceObjectDecoderCodec from './persistence.object_decoder.codec';
import PersistenceObjectEncoderCodec from './persistence.object_encoder.codec';
import PersistenceRdbIoCodec from './persistence.rdb_io.codec';
import type { RdbAux, RdbAuxInput, RdbDatabase, RdbFile, RdbKeyEntry, RdbOptions } from './persistence.types';

/** Whole RDB files: AUX fields, FUNCTION2 records, databases with their key prefixes, EOF and the CRC-64 trailer. */
export default class PersistenceRdbService {
  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The AUX fields Redis writes for a standalone instance, in Redis's order. */
  static defaultRdbAux(input: RdbAuxInput = {}): RdbAux {
    return [
      ['redis-ver', input.redisVer ?? REDIS_VERSION],
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
  static writeRdb(dbs: ReadonlyArray<RdbDatabase | undefined>, aux: RdbAux, functions: readonly string[] = [], opts?: Partial<RdbOptions>): Buffer {
    const io = PersistenceRdbIoCodec;
    const o = io.resolveOptions(opts);
    const w = new RdbWriter();
    w.bytes(Buffer.from(`REDIS${String(RDB_VERSION).padStart(4, '0')}`, 'latin1'));
    for (const [k, v] of aux) {
      w.u8(RDB_OPCODE.AUX);
      io.writeStr(w, k, o.rdbCompression);
      if (typeof v === 'number') io.writeLongLongString(w, v);
      else io.writeStr(w, v, o.rdbCompression);
    }
    for (const code of functions) {
      w.u8(RDB_OPCODE.FUNCTION2);
      io.writeStr(w, code, o.rdbCompression);
    }
    dbs.forEach((db, dbid) => {
      if (!db || db.size === 0) return;
      w.u8(RDB_OPCODE.SELECTDB);
      io.writeLen(w, dbid);
      let expires = 0;
      for (const e of db.values()) if (e.expireAt !== undefined) expires++;
      w.u8(RDB_OPCODE.RESIZEDB);
      io.writeLen(w, db.size);
      io.writeLen(w, expires);
      for (const [key, e] of db) {
        if (e.expireAt !== undefined) {
          w.u8(RDB_OPCODE.EXPIRETIME_MS);
          w.u64le(BigInt(e.expireAt));
        }
        if (e.idle !== undefined) {
          w.u8(RDB_OPCODE.IDLE);
          io.writeLen(w, e.idle);
        }
        if (e.freq !== undefined) {
          w.u8(RDB_OPCODE.FREQ);
          w.u8(e.freq);
        }
        const { type, body } = PersistenceObjectEncoderCodec.encodeObject(e.value, o);
        w.u8(type);
        io.writeStr(w, key, o.rdbCompression);
        w.bytes(body);
      }
    });
    w.u8(RDB_OPCODE.EOF);
    const head = w.toBuffer();
    const trailer = Buffer.alloc(8);
    if (o.rdbChecksum) trailer.writeBigUInt64LE(PersistenceBytesCodec.crc64(head), 0);
    return Buffer.concat([head, trailer]);
  }

  /**
   * Parses an RDB file. Accepts versions 1..RDB_VERSION, skips keys whose value is an empty
   * aggregate (as Redis does), and verifies the trailer CRC unless it is zero.
   * Expired keys are returned as-is; the caller decides whether to drop them.
   */
  static readRdb(buf: Buffer): RdbFile {
    const io = PersistenceRdbIoCodec;
    if (buf.length < 9 || buf.toString('latin1', 0, 5) !== 'REDIS') throw new Error(PersistenceMessages.RDB_WRONG_SIGNATURE);
    const verStr = buf.toString('latin1', 5, 9);
    const version = /^\d{4}$/.test(verStr) ? Number(verStr) : NaN;
    if (!(version >= 1 && version <= RDB_VERSION)) throw new Error(formatMessage(PersistenceMessages.RDB_UNSUPPORTED_VERSION, { version: verStr }));
    const r = new RdbReader(buf);
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
          idle = io.readLen(r);
          continue;
        case RDB_OPCODE.FREQ:
          freq = r.u8();
          continue;
        case RDB_OPCODE.SELECTDB:
          selectDb(io.readLen(r));
          continue;
        case RDB_OPCODE.RESIZEDB:
          io.readLen(r);
          io.readLen(r);
          continue;
        case RDB_OPCODE.SLOT_INFO:
          io.readLen(r);
          io.readLen(r);
          io.readLen(r);
          continue;
        case RDB_OPCODE.AUX: {
          const k = io.readStr(r);
          file.aux.set(k, io.readStr(r));
          continue;
        }
        case RDB_OPCODE.FUNCTION2:
          file.functions.push(io.readStr(r));
          continue;
        case RDB_OPCODE.FUNCTION_PRE_GA:
          throw new Error(PersistenceMessages.RDB_FUNCTION_PRE_GA);
        case RDB_OPCODE.MODULE_AUX:
          throw new Error(PersistenceMessages.RDB_MODULE_AUX);
        case RDB_OPCODE.EOF: {
          if (version >= 5) {
            const stored = r.bytes(8).readBigUInt64LE(0);
            if (stored !== 0n && stored !== PersistenceBytesCodec.crc64(buf.subarray(0, r.pos - 8))) throw new Error(PersistenceMessages.RDB_WRONG_CHECKSUM);
          }
          return file;
        }
        default: {
          const key = io.readStr(r);
          const decoded = PersistenceObjectDecoderCodec.readObject(r, op);
          if (!PersistenceObjectDecoderCodec.isEmptyAggregate(decoded.value)) {
            const entry: RdbKeyEntry = { value: decoded.value };
            if (expireAt !== undefined) entry.expireAt = expireAt;
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

  /** Byte length of the RDB at the start of `buf` (the only cut point where the parse reaches EOF). */
  static rdbLength(buf: Buffer): number {
    for (let p = 9; p + 9 <= buf.length; p++) {
      if (buf[p] !== 0xff) continue;
      try {
        PersistenceRdbService.readRdb(buf.subarray(0, p + 9));
        return p + 9;
      } catch {
        // not the EOF opcode
      }
    }
    return buf.length;
  }
}
