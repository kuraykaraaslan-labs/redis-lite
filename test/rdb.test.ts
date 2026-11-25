import { describe, expect, it } from 'vitest';

import type { RedisValue } from '../src/store/database';
import {
  RDB_TYPE,
  RDB_VERSION,
  crc64,
  decodeObject,
  defaultRdbAux,
  dumpPayload,
  encodeObject,
  intsetDecode,
  intsetEncode,
  listpackBytes,
  listpackDecode,
  listpackEncode,
  lzfCompress,
  lzfDecompress,
  readRdb,
  restorePayload,
  restorePayloadEx,
  writeRdb,
  ziplistDecode,
  zipmapDecode,
} from '../src/store/rdb';
import type { RdbDatabase } from '../src/store/rdb';
import { Stream } from '../src/store/stream';
import type { ConsumerGroup, PendingEntry } from '../src/store/stream';
import { ZSet } from '../src/store/zset';

const bin = (s: string): Buffer => Buffer.from(s, 'latin1');

function binaryString(len: number, seed: number): string {
  let x = seed;
  let out = '';
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += String.fromCharCode((x >>> 16) & 0xff);
  }
  return out;
}

function zsetOf(pairs: Array<[string, number]>): ZSet {
  const z = new ZSet();
  for (const [m, s] of pairs) z.add(m, s);
  return z;
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : 1);

function plain(v: RedisValue): unknown {
  switch (v.type) {
    case 'zset':
      return { type: 'zset', entries: v.value.entries.map((e) => [e.member, e.score]) };
    case 'set':
      return { type: 'set', members: [...v.value].sort() };
    case 'hash':
      return { type: 'hash', entries: [...v.value].sort((a, b) => (a[0] < b[0] ? -1 : 1)) };
    case 'stream': {
      const s = v.value;
      return {
        entries: s.entries,
        lastId: s.lastId,
        entriesAdded: s.entriesAdded,
        maxDeletedId: s.maxDeletedId,
        groups: [...s.groups.values()].sort(byName).map((g) => ({
          name: g.name,
          lastId: g.lastId,
          entriesRead: g.entriesRead,
          pending: [...g.pending.entries()],
          consumers: [...g.consumers.values()].sort(byName).map((c) => ({ ...c, pending: [...c.pending.keys()] })),
        })),
      };
    }
    default:
      return v;
  }
}

function roundTrip(v: RedisValue, expectedType: number): void {
  const enc = encodeObject(v);
  expect(enc.type).toBe(expectedType);
  expect(plain(decodeObject(enc.type, enc.body).value)).toEqual(plain(v));
  expect(plain(restorePayload(dumpPayload(v)))).toEqual(plain(v));
}

function makeStream(n: number, withGroups: boolean): Stream {
  const s = new Stream();
  for (let i = 0; i < n; i++) {
    const id = { ms: BigInt(1700000000000 + Math.floor(i / 3)), seq: BigInt(i % 3) };
    const fields = i % 7 === 0 ? ['other', `v${i}`, 'extra', '42'] : ['name', `user-${i}`, 'n', String(i)];
    s.entries.push({ id, fields });
    s.lastId = id;
  }
  s.entriesAdded = n + 5;
  s.maxDeletedId = { ms: 5n, seq: 1n };
  if (withGroups && n > 2) {
    const g: ConsumerGroup = { name: 'g1', lastId: s.entries[2].id, entriesRead: 3, pending: new Map(), consumers: new Map() };
    const alice = { name: 'alice', seenTime: 1700000000123, activeTime: 1700000000100, pending: new Map<string, PendingEntry>() };
    const bob = { name: 'bob', seenTime: 1700000000200, activeTime: -1, pending: new Map<string, PendingEntry>() };
    for (let i = 0; i < 3; i++) {
      const id = s.entries[i].id;
      const owner = i === 1 ? bob : alice;
      const p: PendingEntry = { id, consumer: owner.name, deliveryTime: 1700000000000 + i, deliveryCount: i + 1 };
      const k = `${id.ms}-${id.seq}`;
      g.pending.set(k, p);
      owner.pending.set(k, p);
    }
    g.consumers.set('bob', bob);
    g.consumers.set('alice', alice);
    s.groups.set('g1', g);
    s.groups.set('a-empty', { name: 'a-empty', lastId: { ms: 0n, seq: 0n }, entriesRead: null, pending: new Map(), consumers: new Map() });
  }
  return s;
}

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
    expect((quick.value.value as string[]).length).toBe(16);
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

describe('object round-trips', () => {
  it('lists: single listpack node, multiple nodes, plain nodes', () => {
    roundTrip({ type: 'list', value: ['a', '1', '-200', binaryString(30, 1)] }, RDB_TYPE.LIST_QUICKLIST_2);
    const small = encodeObject({ type: 'list', value: ['a', 'b'] }).body;
    expect(small[0]).toBe(1); // one node
    expect(small[1]).toBe(2); // PACKED
    const big = Array.from({ length: 5000 }, (_, i) => `element-${i}`);
    const enc = encodeObject({ type: 'list', value: big });
    expect(enc.body[0]).toBeGreaterThan(1);
    roundTrip({ type: 'list', value: big }, RDB_TYPE.LIST_QUICKLIST_2);
    roundTrip({ type: 'list', value: ['x', 'y'.repeat(9000), 'z'] }, RDB_TYPE.LIST_QUICKLIST_2);
  });

  it('sets: intset, listpack, hashtable', () => {
    roundTrip({ type: 'set', value: new Set(['3', '1', '-2', '9223372036854775807']) }, RDB_TYPE.SET_INTSET);
    roundTrip({ type: 'set', value: new Set(['a', '1', binaryString(10, 4)]) }, RDB_TYPE.SET_LISTPACK);
    roundTrip({ type: 'set', value: new Set(Array.from({ length: 600 }, (_, i) => String(i))) }, RDB_TYPE.SET);
    roundTrip({ type: 'set', value: new Set(Array.from({ length: 129 }, (_, i) => `m${i}`)) }, RDB_TYPE.SET);
    roundTrip({ type: 'set', value: new Set(['a', 'b'.repeat(65)]) }, RDB_TYPE.SET);
  });

  it('zsets: listpack and skiplist', () => {
    const small = zsetOf([['a', 1], ['b', 2.5], ['c', -0.125], ['d', 1e300], ['e', Infinity], ['f', -Infinity], ['g', 3e-7]]);
    roundTrip({ type: 'zset', value: small }, RDB_TYPE.ZSET_LISTPACK);
    const items = listpackDecode(encodeObject({ type: 'zset', value: zsetOf([['m', 0.1], ['n', 2]]) }).body.subarray(1));
    expect(items).toEqual(['m', '0.1', 'n', 2n]);
    const big = zsetOf(Array.from({ length: 200 }, (_, i) => [`member:${i}`, i / 3] as [string, number]));
    roundTrip({ type: 'zset', value: big }, RDB_TYPE.ZSET_2);
    roundTrip({ type: 'zset', value: zsetOf([['x'.repeat(65), 1]]) }, RDB_TYPE.ZSET_2);
  });

  it('hashes: listpack and hashtable', () => {
    roundTrip({ type: 'hash', value: new Map([['f', 'v'], ['n', '12'], [binaryString(5, 6), binaryString(7, 8)]]) }, RDB_TYPE.HASH_LISTPACK);
    const big = new Map(Array.from({ length: 300 }, (_, i) => [`field${i}`, `value${i}`] as [string, string]));
    roundTrip({ type: 'hash', value: big }, RDB_TYPE.HASH);
    roundTrip({ type: 'hash', value: new Map([['f', 'v'.repeat(65)]]) }, RDB_TYPE.HASH);
  });

  it('hashes with field TTLs', () => {
    const h = new Map([['a', '1'], ['b', '2'], ['c', '3']]);
    const ttl = new Map([['b', 1800000000000], ['c', 1700000000000]]);
    const enc = encodeObject({ type: 'hash', value: h }, {}, ttl);
    expect(enc.type).toBe(RDB_TYPE.HASH_LISTPACK_EX);
    const dec = restorePayloadEx(dumpPayload({ type: 'hash', value: h }, {}, ttl));
    expect(plain(dec.value)).toEqual(plain({ type: 'hash', value: h }));
    expect(dec.fieldExpires).toEqual(ttl);

    const big = new Map(Array.from({ length: 200 }, (_, i) => [`f${i}`, `v${i}`] as [string, string]));
    const bigTtl = new Map([['f3', 1700000000500], ['f7', 1700000000000]]);
    const encBig = encodeObject({ type: 'hash', value: big }, {}, bigTtl);
    expect(encBig.type).toBe(RDB_TYPE.HASH_METADATA);
    const decBig = decodeObject(encBig.type, encBig.body);
    expect(decBig.fieldExpires).toEqual(bigTtl);
    expect(plain(decBig.value)).toEqual(plain({ type: 'hash', value: big }));
  });

  it('streams: empty, small, multi-node with groups', () => {
    roundTrip({ type: 'stream', value: new Stream() }, RDB_TYPE.STREAM_LISTPACKS_3);
    roundTrip({ type: 'stream', value: makeStream(5, true) }, RDB_TYPE.STREAM_LISTPACKS_3);
    const big = makeStream(450, true);
    const enc = encodeObject({ type: 'stream', value: big });
    expect(enc.body[0]).toBeGreaterThanOrEqual(5); // 100 entries per node
    roundTrip({ type: 'stream', value: big }, RDB_TYPE.STREAM_LISTPACKS_3);
    const fat = new Stream();
    for (let i = 0; i < 20; i++) fat.entries.push({ id: { ms: BigInt(i + 1), seq: 0n }, fields: ['blob', 'x'.repeat(1000)] });
    fat.lastId = { ms: 20n, seq: 0n };
    fat.entriesAdded = 20;
    expect(encodeObject({ type: 'stream', value: fat }).body[0]).toBeGreaterThan(1); // byte limit split
    roundTrip({ type: 'stream', value: fat }, RDB_TYPE.STREAM_LISTPACKS_3);
  });

  it('stream node layout: master entry, SAMEFIELDS flag and lp-count', () => {
    const s = new Stream();
    s.entries.push({ id: { ms: 10n, seq: 0n }, fields: ['a', '1'] });
    s.entries.push({ id: { ms: 12n, seq: 3n }, fields: ['a', 'x'] });
    s.entries.push({ id: { ms: 12n, seq: 4n }, fields: ['b', 'y'] });
    s.lastId = { ms: 12n, seq: 4n };
    s.entriesAdded = 3;
    const body = encodeObject({ type: 'stream', value: s }).body;
    expect(body[0]).toBe(1);
    expect(body[1]).toBe(16);
    const lpLen = body[18];
    const items = listpackDecode(body.subarray(19, 19 + lpLen));
    expect(items).toEqual([
      3n, 0n, 1n, 'a', 0n,
      2n, 0n, 0n, 1n, 4n,
      2n, 2n, 3n, 'x', 4n,
      0n, 2n, 4n, 1n, 'b', 'y', 6n,
    ]);
  });
});

describe('RDB files', () => {
  it('round-trips databases, expiries, aux fields and functions', () => {
    const db0: RdbDatabase = new Map();
    db0.set('str', { value: { type: 'string', value: 'hello' } });
    db0.set('num', { value: { type: 'string', value: '42' }, expireAt: 1900000000000 });
    db0.set('list', { value: { type: 'list', value: ['a', 'b', 'c'] } });
    db0.set('hash', { value: { type: 'hash', value: new Map([['a', '1']]) }, fieldExpires: new Map([['a', 1900000000000]]) });
    db0.set('lfu', { value: { type: 'string', value: 'x' }, idle: 5, freq: 7 });
    const db2: RdbDatabase = new Map();
    db2.set('zs', { value: { type: 'zset', value: zsetOf([['m', 1]]) } });
    db2.set('st', { value: { type: 'stream', value: makeStream(4, true) } });
    const code = "#!lua name=mylib\nredis.register_function('f', function() return 1 end)";
    const aux = defaultRdbAux({ ctime: 1700000000, usedMem: 5000000000, redisVer: '8.8.0' });
    const file = writeRdb([db0, undefined, db2], aux, [code]);
    expect(file.toString('latin1', 0, 9)).toBe(`REDIS00${RDB_VERSION}`);
    expect(file[9]).toBe(0xfa);

    const parsed = readRdb(file);
    expect(parsed.version).toBe(RDB_VERSION);
    expect([...parsed.aux]).toEqual([
      ['redis-ver', '8.8.0'],
      ['redis-bits', '64'],
      ['ctime', '1700000000'],
      ['used-mem', '5000000000'],
      ['aof-base', '0'],
    ]);
    expect(parsed.functions).toEqual([code]);
    expect(parsed.dbs.length).toBe(3);
    expect(parsed.dbs[1].size).toBe(0);
    expect([...parsed.dbs[0].keys()]).toEqual(['str', 'num', 'list', 'hash', 'lfu']);
    expect(parsed.dbs[0].get('num')).toEqual({ value: { type: 'string', value: '42' }, expireAt: 1900000000000 });
    expect(parsed.dbs[0].get('hash')?.fieldExpires).toEqual(new Map([['a', 1900000000000]]));
    expect(parsed.dbs[0].get('lfu')).toMatchObject({ idle: 5, freq: 7 });
    expect(plain(parsed.dbs[2].get('st')!.value)).toEqual(plain({ type: 'stream', value: makeStream(4, true) }));
    expect(plain(parsed.dbs[2].get('zs')!.value)).toEqual(plain({ type: 'zset', value: zsetOf([['m', 1]]) }));
  });

  it('detects corruption via the trailing CRC and accepts a zero checksum', () => {
    const db: RdbDatabase = new Map([['k', { value: { type: 'string', value: 'v' } }]]);
    const file = writeRdb([db], []);
    const bad = Buffer.from(file);
    bad[bad.length - 12] ^= 0xff;
    expect(() => readRdb(bad)).toThrow();
    const noCrc = writeRdb([db], [], [], { rdbChecksum: false });
    expect(noCrc.readBigUInt64LE(noCrc.length - 8)).toBe(0n);
    expect(readRdb(noCrc).dbs[0].get('k')).toEqual({ value: { type: 'string', value: 'v' } });
  });

  it('reads the empty-file layout byte for byte', () => {
    const file = writeRdb([], [['redis-bits', 64]]);
    const head = Buffer.concat([bin(`REDIS00${RDB_VERSION}`), Buffer.from([0xfa, 0x0a]), bin('redis-bits'), Buffer.from([0xc0, 0x40, 0xff])]);
    expect(file.subarray(0, head.length)).toEqual(head);
    expect(file.readBigUInt64LE(head.length)).toBe(crc64(head));
    expect(readRdb(file).aux.get('redis-bits')).toBe('64');
  });
});
