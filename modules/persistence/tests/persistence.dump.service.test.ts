import { describe, expect, it } from 'vitest';

import type { RedisValue } from '@/modules/database/database.types';

import { RDB_VERSION } from '../persistence.enums';
import PersistenceService from '../persistence.service';
import { bin, binaryString } from './persistence.rdb_fixtures';

const { crc64, dumpPayload, encodeObject, restorePayload } = PersistenceService;

describe('strings and DUMP payloads', () => {
  it('DUMP of "bar" is type 0 + "\\x03bar" + version + crc', () => {
    const p = dumpPayload({ type: 'string', value: 'bar' });
    const head = Buffer.from([0x00, 0x03, 0x62, 0x61, 0x72, RDB_VERSION, 0x00]);
    expect(p.subarray(0, 7)).toEqual(head);
    expect(p.length).toBe(15);
    expect(p.readBigUInt64LE(7)).toBe(crc64(head));
    expect(restorePayload(p)).toEqual({ type: 'string', value: 'bar' });
  });

  it('uses integer encodings for canonical int32 strings only', () => {
    expect([...encodeObject({ type: 'string', value: '10' }).body]).toEqual([0xc0, 0x0a]);
    expect([...encodeObject({ type: 'string', value: '-129' }).body]).toEqual([0xc1, 0x7f, 0xff]);
    expect([...encodeObject({ type: 'string', value: '12345678' }).body]).toEqual([0xc2, 0x4e, 0x61, 0xbc, 0x00]);
    expect([...encodeObject({ type: 'string', value: '2147483648' }).body]).toEqual([0x0a, ...bin('2147483648')]);
    expect([...encodeObject({ type: 'string', value: '012' }).body]).toEqual([0x03, ...bin('012')]);
  });

  it('LZF-compresses long compressible strings unless rdbcompression is off', () => {
    const v: RedisValue = { type: 'string', value: 'a'.repeat(100) };
    const body = encodeObject(v).body;
    expect(body[0]).toBe(0xc3);
    expect(restorePayload(dumpPayload(v))).toEqual(v);
    expect([...encodeObject(v, { rdbCompression: false }).body.subarray(0, 2)]).toEqual([0x40, 100]);
  });

  it('round-trips binary strings', () => {
    const v: RedisValue = { type: 'string', value: binaryString(1000, 3) + '\x00\xff' + 'q'.repeat(50) };
    expect(restorePayload(dumpPayload(v))).toEqual(v);
  });

  it('rejects bad checksums and newer versions', () => {
    const p = dumpPayload({ type: 'string', value: 'bar' });
    const corrupt = Buffer.from(p);
    corrupt[2] ^= 1;
    expect(() => restorePayload(corrupt)).toThrow('DUMP payload version or checksum are wrong');
    const newer = Buffer.from(p);
    newer.writeUInt16LE(RDB_VERSION + 1, p.length - 10);
    expect(() => restorePayload(newer)).toThrow('DUMP payload version or checksum are wrong');
    expect(() => restorePayload(Buffer.from([1, 2, 3]))).toThrow('DUMP payload version or checksum are wrong');
  });
});
