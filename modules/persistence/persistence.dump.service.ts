import type { RedisValue } from '@/modules/database/database.core';

import PersistenceBytesCodec, { RdbReader, RdbWriter } from './persistence.bytes.codec';
import { RDB_OPCODE, RDB_VERSION } from './persistence.enums';
import PersistenceMessages from './persistence.messages';
import PersistenceObjectDecoderCodec from './persistence.object_decoder.codec';
import PersistenceObjectEncoderCodec from './persistence.object_encoder.codec';
import PersistenceRdbIoCodec from './persistence.rdb_io.codec';
import type { DecodedObject, FieldExpires, RdbOptions } from './persistence.types';

/** DUMP / RESTORE and FUNCTION DUMP / RESTORE payloads: an object body, the 2-byte RDB version and a CRC-64. */
export default class PersistenceDumpService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Appends the RDB version and the CRC-64 of everything before it. */
  private static seal(body: Buffer): Buffer {
    const head = Buffer.concat([body, Buffer.alloc(2)]);
    head.writeUInt16LE(RDB_VERSION, head.length - 2);
    const crc = Buffer.alloc(8);
    crc.writeBigUInt64LE(PersistenceBytesCodec.crc64(head), 0);
    return Buffer.concat([head, crc]);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** DUMP payload: type byte + object + RDB version (2 bytes LE) + CRC64 (8 bytes LE). */
  static dumpPayload(value: RedisValue, opts?: Partial<RdbOptions>, fieldExpires?: FieldExpires): Buffer {
    const { type, body } = PersistenceObjectEncoderCodec.encodeObject(value, opts, fieldExpires);
    const typed = Buffer.alloc(1 + body.length);
    typed[0] = type;
    body.copy(typed, 1);
    return PersistenceDumpService.seal(typed);
  }

  /** Checks a DUMP payload's footer; throws 'DUMP payload version or checksum are wrong'. */
  static verifyDumpPayload(buf: Buffer, skipChecksum = false): void {
    if (buf.length < 10) throw new Error(PersistenceMessages.DUMP_PAYLOAD_INVALID);
    const footer = buf.length - 10;
    const version = buf.readUInt16LE(footer);
    if (version > RDB_VERSION) throw new Error(PersistenceMessages.DUMP_PAYLOAD_INVALID);
    if (skipChecksum) return;
    if (PersistenceBytesCodec.crc64(buf.subarray(0, buf.length - 8)) !== buf.readBigUInt64LE(buf.length - 8)) {
      throw new Error(PersistenceMessages.DUMP_PAYLOAD_INVALID);
    }
  }

  /** Decodes a DUMP payload, including hash field TTLs. Throws 'Bad data format' on corrupt bodies. */
  static restorePayloadEx(buf: Buffer, skipChecksum = false): DecodedObject {
    PersistenceDumpService.verifyDumpPayload(buf, skipChecksum);
    const r = new RdbReader(buf.subarray(0, buf.length - 10));
    const decoded = PersistenceObjectDecoderCodec.readObject(r, r.u8());
    if (PersistenceObjectDecoderCodec.isEmptyAggregate(decoded.value)) throw PersistenceBytesCodec.badFormat();
    return decoded;
  }

  static restorePayload(buf: Buffer, skipChecksum = false): RedisValue {
    return PersistenceDumpService.restorePayloadEx(buf, skipChecksum).value;
  }

  /** FUNCTION DUMP payload: a FUNCTION2 record per library, then the 2-byte RDB version and the CRC64, like DUMP. */
  static functionsDumpPayload(codes: readonly string[]): Buffer {
    const w = new RdbWriter();
    for (const code of codes) {
      w.u8(RDB_OPCODE.FUNCTION2);
      PersistenceRdbIoCodec.writeStr(w, code, true);
    }
    return PersistenceDumpService.seal(w.toBuffer());
  }

  /** Decodes a FUNCTION DUMP payload into library codes. Throws 'DUMP payload version or checksum are wrong' / 'Bad data format'. */
  static functionsRestorePayload(buf: Buffer): string[] {
    PersistenceDumpService.verifyDumpPayload(buf);
    const r = new RdbReader(buf.subarray(0, buf.length - 10));
    const codes: string[] = [];
    while (r.pos < r.buf.length) {
      if (r.u8() !== RDB_OPCODE.FUNCTION2) throw PersistenceBytesCodec.badFormat();
      codes.push(PersistenceRdbIoCodec.readStr(r));
    }
    return codes;
  }
}
