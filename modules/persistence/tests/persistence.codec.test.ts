import { describe, expect, it } from 'vitest';

import { ListDeque } from '@/modules/lists/lists.deque.structure';
import { ZSet } from '@/modules/zsets/zsets.structure';

import { RDB_TYPE } from '../persistence.enums';
import PersistenceService from '../persistence.service';
import { bin, binaryString } from './persistence.rdb_fixtures';

const { crc64, decodeObject, intsetDecode, intsetEncode, listpackBytes, listpackDecode, listpackEncode, lzfCompress, lzfDecompress, restorePayload, ziplistDecode, zipmapDecode } = PersistenceService;

describe('crc64', () => {
  it('matches the Jones check value', () => {
    expect(crc64(bin('123456789'))).toBe(0xe9c6d914c4b8d9can);
  });

  it('continues an existing crc', () => {
    expect(crc64(bin('6789'), crc64(bin('12345')))).toBe(0xe9c6d914c4b8d9can);
  });

  it('validates the DUMP example from the Redis documentation (DUMP of 10, RDB v9)', () => {
    const payload = bin('\x00\xc0\n\t\x00\xbem\x06\x89Z(\x00\n');
    expect(restorePayload(payload)).toEqual({ type: 'string', value: '10' });
  });
});

describe('lzf', () => {
  it('round-trips compressible data', () => {
    const data = bin('abcabcabcabcabcabcabcabcabcabc-hello-hello-hello-hello' + 'x'.repeat(500));
    const c = lzfCompress(data);
    expect(c).not.toBeNull();
    expect(c!.length).toBeLessThan(data.length);
    expect(lzfDecompress(c!, data.length)).toEqual(data);
  });

  it('round-trips long, mixed and binary data', () => {
    for (const seed of [1, 2, 3]) {
      const chunk = binaryString(300, seed);
      const data = bin(chunk + chunk.slice(0, 200) + 'z'.repeat(9000) + chunk);
      const c = lzfCompress(data)!;
      expect(lzfDecompress(c, data.length)).toEqual(data);
    }
  });

  it('returns null for incompressible data', () => {
    expect(lzfCompress(bin(binaryString(200, 7)))).toBeNull();
    expect(lzfCompress(bin('abcd'))).toBeNull();
  });
});

describe('listpack', () => {
  it('uses the expected entry encodings', () => {
    const lp = listpackEncode(['a', '1', -1, 'abc']);
    expect([...lp]).toEqual([
      0x14, 0, 0, 0, 4, 0,
      0x81, 0x61, 0x02,
      0x01, 0x01,
      0xdf, 0xff, 0x02,
      0x83, 0x61, 0x62, 0x63, 0x04,
      0xff,
    ]);
    expect(listpackBytes(['a', '1', -1, 'abc'])).toBe(lp.length);
  });

  it('round-trips every encoding', () => {
    const entries = [
      '', 'a', '127', '128', '-4096', '4095', '-4097', '32767', '-32768', '8388607', '-8388608', '2147483647',
      '-2147483648', '9223372036854775807', '-9223372036854775808', '9223372036854775808', '007', '-0', '+1',
      'x'.repeat(63), 'y'.repeat(64), 'z'.repeat(4095), 'w'.repeat(4096), binaryString(20000, 9),
    ];
    const lp = listpackEncode(entries);
    expect(lp.length).toBe(listpackBytes(entries));
    expect(listpackDecode(lp).map((e) => (typeof e === 'bigint' ? e.toString() : e))).toEqual(entries);
    const ints = listpackDecode(lp);
    expect(typeof ints[2]).toBe('bigint');
    expect(typeof ints[16]).toBe('string');
    expect(typeof ints[17]).toBe('string');
  });

  it('marks >= 65535 elements as unknown count', () => {
    const entries = Array.from({ length: 70000 }, (_, i) => i % 100);
    const lp = listpackEncode(entries);
    expect(lp.readUInt16LE(4)).toBe(65535);
    expect(listpackDecode(lp).length).toBe(70000);
  });
});

describe('intset / ziplist / zipmap', () => {
  it('encodes and decodes intsets', () => {
    expect([...intsetEncode([3n, 1n, 2n])]).toEqual([2, 0, 0, 0, 3, 0, 0, 0, 1, 0, 2, 0, 3, 0]);
    expect(intsetDecode(intsetEncode([5n, -70000n]))).toEqual([-70000n, 5n]);
    expect(intsetEncode([1n << 40n]).readUInt32LE(0)).toBe(8);
  });

  it('decodes a hand-built ziplist', () => {
    const entries = [
      [0x00, 0x01, 0x61], // "a"
      [0x03, 0xfd], // immediate 12
      [0x02, 0xfe, 0xfb], // int8 -5
      [0x03, 0xc0, 0xe8, 0x03], // int16 1000
      [0x04, 0xf0, 0x40, 0x42, 0x0f], // int24 1000000
      [0x05, 0xd0, 0x00, 0xca, 0x9a, 0x3b], // int32 1000000000
      [0x06, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0x80], // int64 min
      [0x0a, 0x40, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f], // 14-bit "hello"
    ];
    const body = Buffer.from(entries.flat());
    const zl = Buffer.alloc(10 + body.length + 1);
    zl.writeUInt32LE(zl.length, 0);
    zl.writeUInt32LE(10 + body.length - 8, 4);
    zl.writeUInt16LE(entries.length, 8);
    body.copy(zl, 10);
    zl[zl.length - 1] = 0xff;
    expect(ziplistDecode(zl).map(String)).toEqual(['a', '12', '-5', '1000', '1000000', '1000000000', '-9223372036854775808', 'hello']);

    const list = decodeObject(RDB_TYPE.LIST_ZIPLIST, Buffer.concat([Buffer.from([zl.length]), zl]));
    expect(list.value).toEqual({ type: 'list', value: ['a', '12', '-5', '1000', '1000000', '1000000000', '-9223372036854775808', 'hello'] });

    const quick = decodeObject(RDB_TYPE.LIST_QUICKLIST, Buffer.concat([Buffer.from([2, zl.length]), zl, Buffer.from([zl.length]), zl]));
    expect((quick.value.value as ListDeque).length).toBe(16);
  });

  it('decodes legacy intset / zipmap / ZSET v1 / ziplist zset and hash objects', () => {
    const is = Buffer.from([2, 0, 0, 0, 3, 0, 0, 0, 1, 0, 2, 0, 3, 0]);
    const set = decodeObject(RDB_TYPE.SET_INTSET, Buffer.concat([Buffer.from([is.length]), is]));
    expect([...(set.value.value as Set<string>)]).toEqual(['1', '2', '3']);

    const zm = Buffer.from([2, 3, 0x66, 0x6f, 0x6f, 3, 0, 0x62, 0x61, 0x72, 1, 0x61, 1, 2, 0x62, 0, 0, 0xff]);
    expect(zipmapDecode(zm)).toEqual(['foo', 'bar', 'a', 'b']);
    const h = decodeObject(RDB_TYPE.HASH_ZIPMAP, Buffer.concat([Buffer.from([zm.length]), zm]));
    expect([...(h.value.value as Map<string, string>)]).toEqual([['foo', 'bar'], ['a', 'b']]);

    const v1 = Buffer.concat([Buffer.from([3, 1, 0x61, 3]), bin('1.5'), Buffer.from([1, 0x62, 254, 1, 0x63, 255])]);
    const z = decodeObject(RDB_TYPE.ZSET, v1).value.value as ZSet;
    expect(z.entries).toEqual([{ member: 'c', score: -Infinity }, { member: 'a', score: 1.5 }, { member: 'b', score: Infinity }]);

    const zlEntries = [[0x00, 0x01, 0x6d], [0x03, 0x03, 0x32, 0x2e, 0x35], [0x05, 0x01, 0x6e], [0x03, 0xf2]];
    const body = Buffer.from(zlEntries.flat());
    const zl = Buffer.alloc(10 + body.length + 1);
    zl.writeUInt32LE(zl.length, 0);
    zl.writeUInt16LE(4, 8);
    body.copy(zl, 10);
    zl[zl.length - 1] = 0xff;
    const blob = Buffer.concat([Buffer.from([zl.length]), zl]);
    expect((decodeObject(RDB_TYPE.ZSET_ZIPLIST, blob).value.value as ZSet).entries).toEqual([
      { member: 'n', score: 1 },
      { member: 'm', score: 2.5 },
    ]);
    expect([...(decodeObject(RDB_TYPE.HASH_ZIPLIST, blob).value.value as Map<string, string>)]).toEqual([
      ['m', '2.5'],
      ['n', '1'],
    ]);
  });
});
