import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

/**
 * MOVE, SORT / SORT_RO and DUMP / RESTORE.
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

/** Resolves to the error message of a rejected call (fails if the call succeeds). */
async function err(p: Promise<unknown>): Promise<string> {
  try {
    const v = await p;
    return `NO ERROR, got ${JSON.stringify(v)}`;
  } catch (e) {
    return (e as Error).message;
  }
}

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const SYNTAX = 'ERR syntax error';

const NOT_INT = 'ERR value is not an integer or out of range';

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

describe('MOVE', () => {
  it('moves a key to another db', async () => {
    await t.call('SET', 'mv:a', 'v', 'EX', 100);
    expect(await t.call('MOVE', 'mv:a', 1)).toBe(1);
    expect(await t.call('EXISTS', 'mv:a')).toBe(0);
    const c = t.client();
    await c.select(1);
    expect(await c.get('mv:a')).toBe('v');
    expect(await c.ttl('mv:a')).toBeGreaterThan(95);
  });

  it('returns 0 when the destination exists or the source is missing', async () => {
    const c = t.client();
    await c.select(1);
    await c.set('mv:b', 'there');
    await t.call('SET', 'mv:b', 'here');
    expect(await t.call('MOVE', 'mv:b', 1)).toBe(0);
    expect(await t.call('GET', 'mv:b')).toBe('here');
    expect(await c.get('mv:b')).toBe('there');
    expect(await t.call('MOVE', 'mv:missing', 1)).toBe(0);
  });

  it('errors', async () => {
    await t.call('SET', 'mv:e', 'v');
    expect(await err(t.call('MOVE', 'mv:e', 0))).toBe('ERR source and destination objects are the same');
    expect(await err(t.call('MOVE', 'mv:e', 99999))).toBe('ERR DB index is out of range');
    expect(await err(t.call('MOVE', 'mv:e', 'abc'))).toBe(NOT_INT);
    expect(await err(t.call('MOVE', 'mv:e'))).toBe(arity('move'));
  });
});

/* ------------------------------------------------------------------ */
/* SORT / SORT_RO                                                      */
/* ------------------------------------------------------------------ */
describe('SORT / SORT_RO', () => {
  it('numeric sort by default, ASC/DESC, LIMIT', async () => {
    await t.call('RPUSH', 'so:l', '3', '1', '10', '-2', '1.5');
    expect(await t.call('SORT', 'so:l')).toEqual(['-2', '1', '1.5', '3', '10']);
    expect(await t.call('SORT', 'so:l', 'ASC')).toEqual(['-2', '1', '1.5', '3', '10']);
    expect(await t.call('SORT', 'so:l', 'DESC')).toEqual(['10', '3', '1.5', '1', '-2']);
    expect(await t.call('SORT', 'so:l', 'LIMIT', 1, 2)).toEqual(['1', '1.5']);
    expect(await t.call('SORT', 'so:l', 'DESC', 'LIMIT', 0, 2)).toEqual(['10', '3']);
    expect(await t.call('SORT', 'so:l', 'LIMIT', 10, 5)).toEqual([]);
  });

  it('ALPHA sorts lexicographically', async () => {
    await t.call('RPUSH', 'so:a', 'banana', 'apple', 'cherry', '10', '9');
    expect(await t.call('SORT', 'so:a', 'ALPHA')).toEqual(['10', '9', 'apple', 'banana', 'cherry']);
    expect(await t.call('SORT', 'so:a', 'ALPHA', 'DESC')).toEqual(['cherry', 'banana', 'apple', '9', '10']);
  });

  it('non-numeric element without ALPHA is an error', async () => {
    await t.call('RPUSH', 'so:bad', '1', 'abc');
    expect(await err(t.call('SORT', 'so:bad'))).toBe("ERR One or more scores can't be converted into double");
  });

  it('sorts sets and sorted sets', async () => {
    await t.call('SADD', 'so:set', '5', '2', '8');
    expect(await t.call('SORT', 'so:set')).toEqual(['2', '5', '8']);
    await t.call('ZADD', 'so:z', 1, 'c', 2, 'a', 3, 'b');
    expect(await t.call('SORT', 'so:z', 'ALPHA')).toEqual(['a', 'b', 'c']);
  });

  it('BY external key pattern and GET patterns', async () => {
    await t.call('RPUSH', 'so:ids', '1', '2', '3');
    await t.call('MSET', 'so:w_1', '30', 'so:w_2', '10', 'so:w_3', '20', 'so:o_1', 'one', 'so:o_2', 'two');
    expect(await t.call('SORT', 'so:ids', 'BY', 'so:w_*')).toEqual(['2', '3', '1']);
    expect(await t.call('SORT', 'so:ids', 'BY', 'so:w_*', 'GET', 'so:o_*', 'GET', '#')).toEqual(['two', '2', null, '3', 'one', '1']);
    expect(await t.call('SORT', 'so:ids', 'BY', 'so:w_*', 'DESC', 'GET', '#')).toEqual(['1', '3', '2']);
  });

  it('BY and GET with hash fields (->)', async () => {
    await t.call('RPUSH', 'so:hids', '1', '2', '3');
    await t.call('HSET', 'so:obj_1', 'w', '3', 'name', 'n1');
    await t.call('HSET', 'so:obj_2', 'w', '1', 'name', 'n2');
    await t.call('HSET', 'so:obj_3', 'w', '2', 'name', 'n3');
    expect(await t.call('SORT', 'so:hids', 'BY', 'so:obj_*->w', 'GET', 'so:obj_*->name')).toEqual(['n2', 'n3', 'n1']);
    expect(await t.call('SORT', 'so:hids', 'BY', 'so:obj_*->w', 'GET', 'so:obj_*->missing')).toEqual([null, null, null]);
  });

  it('BY with missing weights ties sort by element', async () => {
    await t.call('RPUSH', 'so:ties', 'c', 'a', 'b');
    expect(await t.call('SORT', 'so:ties', 'BY', 'so:noweight_*')).toEqual(['a', 'b', 'c']);
  });

  it('BY nosort skips sorting (list keeps order)', async () => {
    await t.call('RPUSH', 'so:ns', '3', '1', '2');
    expect(await t.call('SORT', 'so:ns', 'BY', 'nosort')).toEqual(['3', '1', '2']);
    expect(await t.call('SORT', 'so:ns', 'BY', 'nosort', 'GET', '#', 'LIMIT', 1, 1)).toEqual(['1']);
    // zset with nosort keeps zset (score) order
    await t.call('ZADD', 'so:zns', 1, 'z', 2, 'y', 3, 'x');
    expect(await t.call('SORT', 'so:zns', 'BY', 'nosort')).toEqual(['z', 'y', 'x']);
    expect(await t.call('SORT', 'so:zns', 'BY', 'nosort', 'DESC')).toEqual(['x', 'y', 'z']);
  });

  it('STORE writes a list and returns its length', async () => {
    await t.call('RPUSH', 'so:st', '3', '1', '2');
    expect(await t.call('SORT', 'so:st', 'STORE', 'so:st:out')).toBe(3);
    expect(await t.call('TYPE', 'so:st:out')).toBe('list');
    expect(await t.call('LRANGE', 'so:st:out', 0, -1)).toEqual(['1', '2', '3']);
    await t.call('SET', 'so:st:out2', 'old');
    expect(await t.call('SORT', 'so:missing', 'STORE', 'so:st:out2')).toBe(0);
    expect(await t.call('EXISTS', 'so:st:out2')).toBe(0);
  });

  it('missing key sorts to an empty array', async () => {
    expect(await t.call('SORT', 'so:nokey')).toEqual([]);
    expect(await t.call('SORT_RO', 'so:nokey')).toEqual([]);
  });

  it('SORT_RO supports the read options but not STORE', async () => {
    await t.call('RPUSH', 'so:ro', '2', '1');
    expect(await t.call('SORT_RO', 'so:ro')).toEqual(['1', '2']);
    expect(await t.call('SORT_RO', 'so:ro', 'DESC', 'LIMIT', 0, 1)).toEqual(['2']);
    expect(await err(t.call('SORT_RO', 'so:ro', 'STORE', 'x'))).toBe(SYNTAX);
  });

  it('errors', async () => {
    await t.call('SET', 'so:str', 'v');
    await t.call('HSET', 'so:hash', 'f', 'v');
    await t.call('RPUSH', 'so:e', '1');
    expect(await err(t.call('SORT', 'so:str'))).toBe(WRONGTYPE);
    expect(await err(t.call('SORT', 'so:hash'))).toBe(WRONGTYPE);
    expect(await err(t.call('SORT', 'so:e', 'LIMIT', 0))).toBe(SYNTAX);
    expect(await err(t.call('SORT', 'so:e', 'LIMIT', 'a', 1))).toBe(NOT_INT);
    expect(await err(t.call('SORT', 'so:e', 'FOO'))).toBe(SYNTAX);
    expect(await err(t.call('SORT'))).toBe(arity('sort'));
    expect(await err(t.call('SORT_RO'))).toBe(arity('sort_ro'));
  });
});

/* ------------------------------------------------------------------ */
/* DUMP / RESTORE (round trip only)                                    */
/* ------------------------------------------------------------------ */
describe('DUMP / RESTORE', () => {
  it('round-trips every type', async () => {
    await t.call('SET', 'dr:s', 'hello');
    await t.call('SET', 'dr:i', '12345');
    await t.call('RPUSH', 'dr:l', 'a', 'b', 'c');
    await t.call('SADD', 'dr:set', 'x', 'y');
    await t.call('ZADD', 'dr:z', 1, 'a', 2.5, 'b');
    await t.call('HSET', 'dr:h', 'f1', 'v1', 'f2', 'v2');
    for (const k of ['dr:s', 'dr:i', 'dr:l', 'dr:set', 'dr:z', 'dr:h']) {
      const payload = await t.redis.dumpBuffer(k);
      expect(Buffer.isBuffer(payload)).toBe(true);
      expect(await t.call('RESTORE', `${k}:copy`, 0, payload)).toBe('OK');
      expect(await t.call('TYPE', `${k}:copy`)).toBe(await t.call('TYPE', k));
      expect(await t.call('TTL', `${k}:copy`)).toBe(-1);
    }
    expect(await t.call('GET', 'dr:s:copy')).toBe('hello');
    expect(await t.call('GET', 'dr:i:copy')).toBe('12345');
    expect(await t.call('LRANGE', 'dr:l:copy', 0, -1)).toEqual(['a', 'b', 'c']);
    expect(((await t.call('SMEMBERS', 'dr:set:copy')) as string[]).sort()).toEqual(['x', 'y']);
    expect(await t.call('ZRANGE', 'dr:z:copy', 0, -1, 'WITHSCORES')).toEqual(['a', '1', 'b', '2.5']);
    expect(await t.call('HGETALL', 'dr:h:copy')).toEqual(['f1', 'v1', 'f2', 'v2']);
  });

  it('binary values round-trip', async () => {
    const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await t.call('SET', 'dr:bin', bin);
    await t.call('RESTORE', 'dr:bin2', 0, await t.redis.dumpBuffer('dr:bin'));
    expect(await t.redis.getBuffer('dr:bin2')).toEqual(bin);
  });

  it('TTL, ABSTTL, REPLACE, BUSYKEY', async () => {
    await t.call('SET', 'dr:t', 'v');
    const payload = await t.redis.dumpBuffer('dr:t');
    expect(await t.call('RESTORE', 'dr:t2', 100000, payload)).toBe('OK');
    expect(await t.call('PTTL', 'dr:t2')).toBeGreaterThan(99000);
    expect(await err(t.call('RESTORE', 'dr:t2', 0, payload))).toBe('BUSYKEY Target key name already exists.');
    expect(await t.call('RESTORE', 'dr:t2', 0, payload, 'REPLACE')).toBe('OK');
    expect(await t.call('TTL', 'dr:t2')).toBe(-1);
    const at = Date.now() + 200000;
    expect(await t.call('RESTORE', 'dr:t3', at, payload, 'ABSTTL')).toBe('OK');
    expect(await t.call('PEXPIRETIME', 'dr:t3')).toBe(at);
    expect(await t.call('RESTORE', 'dr:t4', 0, payload, 'IDLETIME', 100)).toBe('OK');
    expect(await t.call('OBJECT', 'IDLETIME', 'dr:t4')).toBeGreaterThanOrEqual(100);
  });

  it('DUMP of a missing key is nil', async () => {
    expect(await t.call('DUMP', 'dr:missing')).toBeNull();
    const r = await resp3();
    expect(await r.send('DUMP', 'dr:missing')).toBe('_\r\n');
  });

  it('errors', async () => {
    await t.call('SET', 'dr:e', 'v');
    const payload = await t.redis.dumpBuffer('dr:e');
    expect(await err(t.call('RESTORE', 'dr:e2', -1, payload))).toBe('ERR Invalid TTL value, must be >= 0');
    expect(await err(t.call('RESTORE', 'dr:e2', 'x', payload))).toBe(NOT_INT);
    expect(await err(t.call('RESTORE', 'dr:e2', 0, 'garbage'))).toBe('ERR DUMP payload version or checksum are wrong');
    expect(await err(t.call('RESTORE', 'dr:e2', 0, payload, 'FOO'))).toBe(SYNTAX);
    expect(await t.call('EXISTS', 'dr:e2')).toBe(0);
    expect(await err(t.call('DUMP'))).toBe(arity('dump'));
    expect(await err(t.call('RESTORE', 'dr:e2', 0))).toBe(arity('restore'));
  });
});
