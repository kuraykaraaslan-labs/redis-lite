import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import Redis from 'ioredis';

import { RedisLite } from '@/index';

let server: RedisLite;
let redis: Redis;
const call = (...args: Array<string | number>) =>
  redis.call(String(args[0]), ...args.slice(1).map(String));

beforeAll(async () => {
  server = await RedisLite.start({ port: 0 });
  redis = new Redis(server.url);
});

afterAll(async () => {
  redis.disconnect();
  await server.close();
});

describe('geo (values from the Redis docs)', () => {
  it('GEOADD / GEODIST / GEOHASH / GEOPOS / GEORADIUS / GEOSEARCH', async () => {
    expect(
      await call(
        'GEOADD',
        'Sicily',
        13.361389,
        38.115556,
        'Palermo',
        15.087269,
        37.502669,
        'Catania',
      ),
    ).toBe(2);
    expect(await call('GEODIST', 'Sicily', 'Palermo', 'Catania')).toBe(
      '166274.1516',
    );
    expect(await call('GEODIST', 'Sicily', 'Palermo', 'Catania', 'km')).toBe(
      '166.2742',
    );
    expect(await call('GEOHASH', 'Sicily', 'Palermo', 'Catania')).toEqual([
      'sqc8b49rny0',
      'sqdtr74hyu0',
    ]);
    expect(await call('GEOPOS', 'Sicily', 'Palermo', 'NonExisting')).toEqual([
      ['13.36138933897018433', '38.11555639549629859'],
      null,
    ]);
    expect(await call('ZSCORE', 'Sicily', 'Palermo')).toBe('3479099956230698');
    expect(
      await call('GEORADIUS', 'Sicily', 15, 37, 200, 'km', 'WITHDIST'),
    ).toEqual([
      ['Palermo', '190.4424'],
      ['Catania', '56.4413'],
    ]);
    expect(
      await call(
        'GEOSEARCH',
        'Sicily',
        'FROMLONLAT',
        15,
        37,
        'BYBOX',
        400,
        400,
        'km',
        'ASC',
        'WITHDIST',
      ),
    ).toEqual([
      ['Catania', '56.4413'],
      ['Palermo', '190.4424'],
    ]);
    expect(
      await call('GEORADIUSBYMEMBER', 'Sicily', 'Palermo', 200, 'km', 'ASC'),
    ).toEqual(['Palermo', 'Catania']);
    expect(
      await call(
        'GEOSEARCHSTORE',
        'near',
        'Sicily',
        'FROMMEMBER',
        'Palermo',
        'BYRADIUS',
        100,
        'km',
      ),
    ).toBe(1);
  });
});

describe('bitmaps and strings', () => {
  it('BITCOUNT / BITPOS / SETBIT / BITOP', async () => {
    await redis.set('bc', 'foobar');
    expect(await call('BITCOUNT', 'bc')).toBe(26);
    expect(await call('BITCOUNT', 'bc', 0, 0)).toBe(4);
    expect(await call('BITCOUNT', 'bc', 1, 1)).toBe(6);
    expect(await call('BITCOUNT', 'bc', 5, 30, 'BIT')).toBe(17);
    await redis.set('bp', Buffer.from([0xff, 0xf0, 0x00]));
    expect(await call('BITPOS', 'bp', 0)).toBe(12);
    await redis.set('bp', Buffer.from([0x00, 0xff, 0xf0]));
    expect(await call('BITPOS', 'bp', 1, 0)).toBe(8);
    expect(await call('BITPOS', 'bp', 1, 2)).toBe(16);
    expect(await call('BITPOS', 'bp', 1, 2, -1, 'BYTE')).toBe(16);
    expect(await call('BITPOS', 'bp', 1, 7, 15, 'BIT')).toBe(8);
    expect(await call('SETBIT', 'sb', 7, 1)).toBe(0);
    expect(await call('GETBIT', 'sb', 7)).toBe(1);
    expect(await redis.get('sb')).toBe('\u0001');
    await redis.set('k1', 'foobar');
    await redis.set('k2', 'abcdef');
    expect(await call('BITOP', 'AND', 'dest', 'k1', 'k2')).toBe(6);
    expect(await redis.get('dest')).toBe('`bc`ab');
  });

  it('BITFIELD with overflow', async () => {
    expect(
      await call('BITFIELD', 'bf', 'INCRBY', 'i5', 100, 1, 'GET', 'u4', 0),
    ).toEqual([1, 0]);
    const step = () =>
      call(
        'BITFIELD',
        'ov',
        'INCRBY',
        'u2',
        100,
        1,
        'OVERFLOW',
        'SAT',
        'INCRBY',
        'u2',
        102,
        1,
      );
    expect(await step()).toEqual([1, 1]);
    expect(await step()).toEqual([2, 2]);
    expect(await step()).toEqual([3, 3]);
    expect(await step()).toEqual([0, 3]);
  });

  it('LCS', async () => {
    await redis.mset('l1', 'ohmytext', 'l2', 'mynewtext');
    expect(await call('LCS', 'l1', 'l2')).toBe('mytext');
    expect(await call('LCS', 'l1', 'l2', 'LEN')).toBe(6);
    expect(await call('LCS', 'l1', 'l2', 'IDX')).toEqual([
      'matches',
      [
        [
          [4, 7],
          [5, 8],
        ],
        [
          [2, 3],
          [0, 1],
        ],
      ],
      'len',
      6,
    ]);
    expect(
      await call('LCS', 'l1', 'l2', 'IDX', 'MINMATCHLEN', 4, 'WITHMATCHLEN'),
    ).toEqual(['matches', [[[4, 7], [5, 8], 4]], 'len', 6]);
  });
});

describe('lists and sorted sets', () => {
  it('LMPOP / BLMPOP', async () => {
    await redis.lpush('ml', 'one', 'two', 'three', 'four', 'five');
    expect(await call('LMPOP', 1, 'ml', 'LEFT')).toEqual(['ml', ['five']]);
    expect(await call('LMPOP', 1, 'ml', 'RIGHT', 'COUNT', 10)).toEqual([
      'ml',
      ['one', 'two', 'three', 'four'],
    ]);
    expect(await call('LMPOP', 1, 'ml', 'LEFT')).toBeNull();
    const b = redis.duplicate();
    const pending = b.call('BLMPOP', '2', '2', 'x1', 'x2', 'LEFT');
    await new Promise((r) => setTimeout(r, 30));
    await redis.rpush('x2', 'v');
    expect(await pending).toEqual(['x2', ['v']]);
    b.disconnect();
  });

  it('ZMPOP / ZDIFF / ZINTER / ZUNION / ZINTERCARD', async () => {
    await redis.zadd('za', 1, 'one', 2, 'two', 3, 'three');
    await redis.zadd('zb', 1, 'one', 2, 'two');
    expect(await call('ZDIFF', 2, 'za', 'zb', 'WITHSCORES')).toEqual([
      'three',
      '3',
    ]);
    expect(await call('ZINTER', 2, 'za', 'zb', 'WITHSCORES')).toEqual([
      'one',
      '2',
      'two',
      '4',
    ]);
    expect(await call('ZUNION', 2, 'za', 'zb')).toEqual([
      'one',
      'three',
      'two',
    ]);
    expect(await call('ZINTERCARD', 2, 'za', 'zb', 'LIMIT', 1)).toBe(1);
    expect(await call('ZDIFFSTORE', 'zd', 2, 'za', 'zb')).toBe(1);
    expect(await call('ZMPOP', 1, 'za', 'MIN')).toEqual(['za', [['one', '1']]]);
    expect(await call('ZMPOP', 1, 'za', 'MAX', 'COUNT', 10)).toEqual([
      'za',
      [
        ['three', '3'],
        ['two', '2'],
      ],
    ]);
  });
});

describe('keys', () => {
  it('SORT with BY / GET / STORE', async () => {
    await redis.rpush('sl', '3', '1', '2');
    expect(await call('SORT', 'sl')).toEqual(['1', '2', '3']);
    expect(await call('SORT', 'sl', 'DESC', 'LIMIT', 0, 2)).toEqual(['3', '2']);
    await redis.mset(
      'w_1',
      '30',
      'w_2',
      '10',
      'w_3',
      '20',
      'o_1',
      'a',
      'o_2',
      'b',
      'o_3',
      'c',
    );
    expect(
      await call('SORT', 'sl', 'BY', 'w_*', 'GET', 'o_*', 'GET', '#'),
    ).toEqual(['b', '2', 'c', '3', 'a', '1']);
    expect(await call('SORT', 'sl', 'ALPHA', 'STORE', 'sorted')).toBe(3);
    expect(await redis.lrange('sorted', 0, -1)).toEqual(['1', '2', '3']);
  });

  it('DUMP / RESTORE / MOVE / SWAPDB', async () => {
    await redis.zadd('dz', 1, 'a', 2, 'b');
    const payload = await redis.dumpBuffer('dz');
    await redis.restore('dz2', 0, payload);
    expect(await redis.zrange('dz2', 0, -1, 'WITHSCORES')).toEqual([
      'a',
      '1',
      'b',
      '2',
    ]);
    await expect(redis.restore('dz2', 0, payload)).rejects.toThrow(/BUSYKEY/);
    await redis.xadd('ds', '1-1', 'f', 'v');
    await redis.xgroup('CREATE', 'ds', 'g', '0');
    await redis.restore('ds2', 1000, await redis.dumpBuffer('ds'));
    expect(await redis.xlen('ds2')).toBe(1);
    expect(await redis.pttl('ds2')).toBeGreaterThan(0);
    expect(await call('MOVE', 'dz2', 3)).toBe(1);
    expect(await redis.exists('dz2')).toBe(0);
    await call('SWAPDB', 0, 3);
    expect(await redis.exists('dz2')).toBe(1);
    await call('SWAPDB', 0, 3);
  });
});

describe('hash field expiration', () => {
  it('HEXPIRE / HTTL / HPERSIST / HGETDEL / HSETEX / HGETEX', async () => {
    await redis.hset('hf', 'a', '1', 'b', '2');
    expect(await call('HEXPIRE', 'hf', 100, 'FIELDS', 2, 'a', 'zz')).toEqual([
      1, -2,
    ]);
    expect(await call('HTTL', 'hf', 'FIELDS', 2, 'a', 'b')).toEqual([100, -1]);
    expect(await call('HPERSIST', 'hf', 'FIELDS', 1, 'a')).toEqual([1]);
    expect(await call('HPEXPIRE', 'hf', 30, 'FIELDS', 1, 'b')).toEqual([1]);
    await new Promise((r) => setTimeout(r, 60));
    expect(await redis.hgetall('hf')).toEqual({ a: '1' });
    expect(await call('HGETDEL', 'hf', 'FIELDS', 1, 'a')).toEqual(['1']);
    expect(await redis.exists('hf')).toBe(0);
    expect(
      await call('HSETEX', 'hs', 'FNX', 'EX', 100, 'FIELDS', 1, 'f', 'v'),
    ).toBe(1);
    expect(await call('HSETEX', 'hs', 'FNX', 'FIELDS', 1, 'f', 'v2')).toBe(0);
    expect(await call('HGETEX', 'hs', 'PERSIST', 'FIELDS', 1, 'f')).toEqual([
      'v',
    ]);
    expect(await call('HTTL', 'hs', 'FIELDS', 1, 'f')).toEqual([-1]);
  });
});

describe('functions', () => {
  it('FUNCTION LOAD / FCALL / LIST / DELETE', async () => {
    const lib =
      "#!lua name=mylib\nredis.register_function('knock', function() return 'Who is there?' end)\nredis.register_function{function_name='my_hset', callback=function(keys, args) return redis.call('HSET', keys[1], args[1], args[2]) end, flags={'allow-oom'}}";
    expect(await call('FUNCTION', 'LOAD', lib)).toBe('mylib');
    await expect(call('FUNCTION', 'LOAD', lib)).rejects.toThrow(
      /already exists/,
    );
    expect(await call('FUNCTION', 'LOAD', 'REPLACE', lib)).toBe('mylib');
    expect(await call('FCALL', 'knock', 0)).toBe('Who is there?');
    expect(await call('FCALL', 'my_hset', 1, 'fh', 'x', 'y')).toBe(1);
    expect(await redis.hget('fh', 'x')).toBe('y');
    const list = (await call('FUNCTION', 'LIST')) as unknown[][];
    expect(list[0]).toContain('mylib');
    const dump = (await redis.callBuffer('FUNCTION', 'DUMP')) as Buffer;
    expect(await call('FUNCTION', 'DELETE', 'mylib')).toBe('OK');
    await expect(call('FCALL', 'knock', 0)).rejects.toThrow(
      /Function not found/,
    );
    await redis.call('FUNCTION', 'RESTORE', dump);
    // Redis 7+: FCALL_RO only runs functions flagged no-writes.
    await expect(call('FCALL_RO', 'knock', 0)).rejects.toThrow(
      'ERR Can not execute a script with write flag using *_ro command.',
    );
    expect(await call('FCALL', 'knock', 0)).toBe('Who is there?');
  });
});

describe('server and connection', () => {
  it('sharded pub/sub', async () => {
    const sub = redis.duplicate();
    const got = new Promise<string>((resolve) =>
      sub.on('smessage', (_c: string, m: string) => resolve(m)),
    );
    await sub.ssubscribe('sch');
    expect(await redis.spublish('sch', 'hi')).toBe(1);
    expect(await got).toBe('hi');
    sub.disconnect();
  });

  it('MONITOR', async () => {
    const mon = await redis.duplicate().monitor();
    const seen = new Promise<string[]>((resolve) =>
      mon.on(
        'monitor',
        (_t: string, args: string[]) => args[0] === 'set' && resolve(args),
      ),
    );
    await redis.set('watched', 'v');
    expect(await seen).toEqual(['set', 'watched', 'v']);
    mon.disconnect();
  });

  it('CLIENT UNBLOCK', async () => {
    const b = redis.duplicate();
    const id = (await b.client('ID')) as number;
    const pending = b.blpop('never', 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(await redis.client('UNBLOCK', id)).toBe(1);
    expect(await pending).toBeNull();
    b.disconnect();
  });

  it('COMMAND, ACL, SLOWLOG', async () => {
    expect(Number(await call('COMMAND', 'COUNT'))).toBeGreaterThan(200);
    expect(
      await call('COMMAND', 'GETKEYS', 'MSET', 'a', '1', 'b', '2'),
    ).toEqual(['a', 'b']);
    expect(await call('ACL', 'WHOAMI')).toBe('default');
    // Earlier commands (e.g. FUNCTION LOAD under load) may legitimately exceed the 10 ms threshold, as in Redis.
    await call('SLOWLOG', 'RESET');
    expect(await call('SLOWLOG', 'GET')).toEqual([]);
  });
});
