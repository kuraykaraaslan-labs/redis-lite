import { describe, expect, it } from 'vitest';

import { arity, err, NOT_INT, SYNTAX, useServer, WRONGTYPE } from '@/tests/helpers';

/**
 * SORT / SORT_RO (keys.sort.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

const sorted = (v: unknown) => [...(v as string[])].sort();

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
