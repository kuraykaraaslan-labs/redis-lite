import { describe, expect, it } from 'vitest';

import { ListDeque } from '@/modules/lists/lists.deque.structure';

import { RDB_VERSION } from '../persistence.enums';
import PersistenceService from '../persistence.service';
import type { RdbDatabase } from '../persistence.types';
import { bin, zsetOf, plain, makeStream } from './persistence.rdb_fixtures';

const { crc64, defaultRdbAux, readRdb, writeRdb } = PersistenceService;

describe('RDB files', () => {
  it('round-trips databases, expiries, aux fields and functions', () => {
    const db0: RdbDatabase = new Map();
    db0.set('str', { value: { type: 'string', value: 'hello' } });
    db0.set('num', { value: { type: 'string', value: '42' }, expireAt: 1900000000000 });
    db0.set('list', { value: { type: 'list', value: ListDeque.from(['a', 'b', 'c']) } });
    db0.set('hash', { value: { type: 'hash', value: new Map([['a', '1']]) } });
    db0.set('lfu', { value: { type: 'string', value: 'x' }, idle: 5, freq: 7 });
    const db2: RdbDatabase = new Map();
    db2.set('zs', { value: { type: 'zset', value: zsetOf([['m', 1]]) } });
    db2.set('st', { value: { type: 'stream', value: makeStream(4, true) } });
    const code = "#!lua name=mylib\nredis.register_function('f', function() return 1 end)";
    const aux = defaultRdbAux({ ctime: 1700000000, usedMem: 5000000000, redisVer: '7.0.15' });
    const file = writeRdb([db0, undefined, db2], aux, [code]);
    expect(file.toString('latin1', 0, 9)).toBe(`REDIS00${RDB_VERSION}`);
    expect(file[9]).toBe(0xfa);

    const parsed = readRdb(file);
    expect(parsed.version).toBe(RDB_VERSION);
    expect([...parsed.aux]).toEqual([
      ['redis-ver', '7.0.15'],
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
    expect(plain(parsed.dbs[0].get('hash')!.value)).toEqual(plain({ type: 'hash', value: new Map([['a', '1']]) }));
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
