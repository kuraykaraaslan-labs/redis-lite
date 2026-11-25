import { describe, expect, it } from 'vitest';

import { ListDeque } from '@/modules/lists/lists.deque.structure';
import { Stream } from '@/modules/streams/streams.structure';

import { RDB_TYPE } from '../persistence.enums';
import PersistenceService from '../persistence.service';
import { binaryString, zsetOf, plain, roundTrip, makeStream } from './persistence.rdb_fixtures';

const { decodeObject, dumpPayload, encodeObject, listpackDecode, restorePayloadEx } = PersistenceService;

describe('object round-trips', () => {
  it('lists: single listpack node, multiple nodes, plain nodes', () => {
    roundTrip({ type: 'list', value: ListDeque.from(['a', '1', '-200', binaryString(30, 1)]) }, RDB_TYPE.LIST_QUICKLIST_2);
    const small = encodeObject({ type: 'list', value: ListDeque.from(['a', 'b']) }).body;
    expect(small[0]).toBe(1); // one node
    expect(small[1]).toBe(2); // PACKED
    const big = Array.from({ length: 5000 }, (_, i) => `element-${i}`);
    const enc = encodeObject({ type: 'list', value: ListDeque.from(big) });
    expect(enc.body[0]).toBeGreaterThan(1);
    roundTrip({ type: 'list', value: ListDeque.from(big) }, RDB_TYPE.LIST_QUICKLIST_2);
    roundTrip({ type: 'list', value: ListDeque.from(['x', 'y'.repeat(9000), 'z']) }, RDB_TYPE.LIST_QUICKLIST_2);
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
