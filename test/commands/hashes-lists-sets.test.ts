import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '../helpers';

/**
 * Hashes, lists and sets. Expected values come from the redis.io command docs / Redis source
 * semantics (Redis Open Source 8.x), not from redis-lite output.
 */
const t = useServer();

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';
const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;
const NOT_INT = 'ERR value is not an integer or out of range';
const SYNTAX = 'ERR syntax error';
const enc = (key: string) => t.call('OBJECT', 'ENCODING', key);
const sorted = (v: unknown) => [...(v as string[])].sort();
const resp3 = async () => {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
};

/** Asserts that every command rejects with WRONGTYPE against a string key. */
async function expectWrongType(key: string, cmds: Array<Array<string | number>>) {
  await t.call('SET', key, 'str');
  for (const c of cmds) {
    await expect(t.call(...c), c.join(' ')).rejects.toThrow(WRONGTYPE);
  }
}

/* ------------------------------------------------------------------ */
/* Hashes                                                              */
/* ------------------------------------------------------------------ */

describe('hashes: basic', () => {
  it('HSET returns number of new fields, overwrites, odd args is an arity error', async () => {
    expect(await t.call('HSET', 'h:set', 'f1', 'v1', 'f2', 'v2')).toBe(2);
    expect(await t.call('HSET', 'h:set', 'f1', 'x', 'f3', 'v3')).toBe(1);
    expect(await t.call('HGET', 'h:set', 'f1')).toBe('x');
    await expect(t.call('HSET', 'h:set', 'f1')).rejects.toThrow(arity('hset'));
    await expect(t.call('HSET', 'h:set', 'f1', 'v', 'f2')).rejects.toThrow(arity('hset'));
    await expect(t.call('HSET', 'h:set')).rejects.toThrow(arity('hset'));
  });

  it('HMSET returns OK, odd args is an arity error', async () => {
    expect(await t.call('HMSET', 'h:hmset', 'a', '1', 'b', '2')).toBe('OK');
    expect(await t.call('HMGET', 'h:hmset', 'a', 'b', 'nope')).toEqual(['1', '2', null]);
    await expect(t.call('HMSET', 'h:hmset', 'a', '1', 'b')).rejects.toThrow(arity('hmset'));
    await expect(t.call('HMSET', 'h:hmset', 'a')).rejects.toThrow(arity('hmset'));
  });

  it('HSETNX', async () => {
    expect(await t.call('HSETNX', 'h:nx', 'field', 'Hello')).toBe(1);
    expect(await t.call('HSETNX', 'h:nx', 'field', 'World')).toBe(0);
    expect(await t.call('HGET', 'h:nx', 'field')).toBe('Hello');
    await expect(t.call('HSETNX', 'h:nx', 'field')).rejects.toThrow(arity('hsetnx'));
    await expect(t.call('HSETNX', 'h:nx', 'f', 'v', 'x')).rejects.toThrow(arity('hsetnx'));
  });

  it('HGET / HMGET on missing key and field', async () => {
    expect(await t.call('HGET', 'h:missing', 'f')).toBeNull();
    expect(await t.call('HMGET', 'h:missing', 'a', 'b')).toEqual([null, null]);
    await t.call('HSET', 'h:get', 'a', '1');
    expect(await t.call('HGET', 'h:get', 'zz')).toBeNull();
    await expect(t.call('HGET', 'h:get')).rejects.toThrow(arity('hget'));
    await expect(t.call('HGET', 'h:get', 'a', 'b')).rejects.toThrow(arity('hget'));
    await expect(t.call('HMGET', 'h:get')).rejects.toThrow(arity('hmget'));
  });

  it('HGETALL / HKEYS / HVALS keep insertion order on small hashes', async () => {
    await t.call('HSET', 'h:all', 'field1', 'Hello', 'field2', 'World');
    expect(await t.call('HGETALL', 'h:all')).toEqual(['field1', 'Hello', 'field2', 'World']);
    expect(await t.call('HKEYS', 'h:all')).toEqual(['field1', 'field2']);
    expect(await t.call('HVALS', 'h:all')).toEqual(['Hello', 'World']);
    expect(await t.call('HGETALL', 'h:all-missing')).toEqual([]);
    expect(await t.call('HKEYS', 'h:all-missing')).toEqual([]);
    expect(await t.call('HVALS', 'h:all-missing')).toEqual([]);
    await expect(t.call('HGETALL')).rejects.toThrow(arity('hgetall'));
    await expect(t.call('HKEYS', 'a', 'b')).rejects.toThrow(arity('hkeys'));
    await expect(t.call('HVALS', 'a', 'b')).rejects.toThrow(arity('hvals'));
  });

  it('HDEL deletes fields, removes the key when empty', async () => {
    await t.call('HSET', 'h:del', 'a', '1', 'b', '2', 'c', '3');
    expect(await t.call('HDEL', 'h:del', 'a', 'zz')).toBe(1);
    expect(await t.call('HDEL', 'h:del', 'b', 'c', 'b')).toBe(2);
    expect(await t.call('EXISTS', 'h:del')).toBe(0);
    expect(await t.call('HDEL', 'h:del', 'a')).toBe(0);
    await expect(t.call('HDEL', 'h:del')).rejects.toThrow(arity('hdel'));
  });

  it('HEXISTS / HLEN / HSTRLEN', async () => {
    await t.call('HSET', 'h:len', 'f1', 'HelloWorld', 'f2', '99', 'f3', '-256');
    expect(await t.call('HSTRLEN', 'h:len', 'f1')).toBe(10);
    expect(await t.call('HSTRLEN', 'h:len', 'f2')).toBe(2);
    expect(await t.call('HSTRLEN', 'h:len', 'f3')).toBe(4);
    expect(await t.call('HSTRLEN', 'h:len', 'nope')).toBe(0);
    expect(await t.call('HSTRLEN', 'h:len-missing', 'f')).toBe(0);
    expect(await t.call('HLEN', 'h:len')).toBe(3);
    expect(await t.call('HLEN', 'h:len-missing')).toBe(0);
    expect(await t.call('HEXISTS', 'h:len', 'f1')).toBe(1);
    expect(await t.call('HEXISTS', 'h:len', 'f9')).toBe(0);
    expect(await t.call('HEXISTS', 'h:len-missing', 'f1')).toBe(0);
    await expect(t.call('HEXISTS', 'h:len')).rejects.toThrow(arity('hexists'));
    await expect(t.call('HLEN')).rejects.toThrow(arity('hlen'));
    await expect(t.call('HSTRLEN', 'h:len')).rejects.toThrow(arity('hstrlen'));
  });

  it('HINCRBY (docs example) and errors', async () => {
    await t.call('HSET', 'h:incr', 'field', '5');
    expect(await t.call('HINCRBY', 'h:incr', 'field', 1)).toBe(6);
    expect(await t.call('HINCRBY', 'h:incr', 'field', -1)).toBe(5);
    expect(await t.call('HINCRBY', 'h:incr', 'field', -10)).toBe(-5);
    expect(await t.call('HINCRBY', 'h:incr', 'new', 7)).toBe(7);
    expect(await t.call('HINCRBY', 'h:incr-new', 'f', 3)).toBe(3);
    await t.call('HSET', 'h:incr', 'str', 'abc', 'big', '9223372036854775807', 'flt', '1.5');
    await expect(t.call('HINCRBY', 'h:incr', 'str', 1)).rejects.toThrow('ERR hash value is not an integer');
    await expect(t.call('HINCRBY', 'h:incr', 'flt', 1)).rejects.toThrow('ERR hash value is not an integer');
    await expect(t.call('HINCRBY', 'h:incr', 'field', 'x')).rejects.toThrow(NOT_INT);
    await expect(t.call('HINCRBY', 'h:incr', 'field', '1.5')).rejects.toThrow(NOT_INT);
    await expect(t.call('HINCRBY', 'h:incr', 'field')).rejects.toThrow(arity('hincrby'));
  });

  it('HINCRBY overflow on a LLONG_MAX value', async () => {
    await t.call('HSET', 'h:incr-ovf', 'big', '9223372036854775807', 'small', '-9223372036854775808');
    await expect(t.call('HINCRBY', 'h:incr-ovf', 'big', 1)).rejects.toThrow('ERR increment or decrement would overflow');
    await expect(t.call('HINCRBY', 'h:incr-ovf', 'small', -1)).rejects.toThrow('ERR increment or decrement would overflow');
    // ioredis parses integers above 2^53 lossily, so check the exact wire reply and the stored value instead.
    const r = await t.raw();
    expect(await r.send('HINCRBY', 'h:incr-ovf', 'big', -1)).toBe(':9223372036854775806\r\n');
    expect(await t.call('HGET', 'h:incr-ovf', 'big')).toBe('9223372036854775806');
  });

  it('HINCRBYFLOAT (docs example) and errors', async () => {
    await t.call('HSET', 'h:incrf', 'field', '10.50');
    expect(await t.call('HINCRBYFLOAT', 'h:incrf', 'field', '0.1')).toBe('10.6');
    expect(await t.call('HINCRBYFLOAT', 'h:incrf', 'field', '-5')).toBe('5.6');
    await t.call('HSET', 'h:incrf', 'field', '5.0e3');
    expect(await t.call('HINCRBYFLOAT', 'h:incrf', 'field', '2.0e2')).toBe('5200');
    expect(await t.call('HINCRBYFLOAT', 'h:incrf', 'new', '3')).toBe('3');
    await t.call('HSET', 'h:incrf', 'str', 'abc');
    await expect(t.call('HINCRBYFLOAT', 'h:incrf', 'str', '1')).rejects.toThrow('ERR hash value is not a float');
    await expect(t.call('HINCRBYFLOAT', 'h:incrf', 'field', 'abc')).rejects.toThrow('ERR value is not a valid float');
    await expect(t.call('HINCRBYFLOAT', 'h:incrf', 'field', 'inf')).rejects.toThrow('ERR increment would produce NaN or Infinity');
    await expect(t.call('HINCRBYFLOAT', 'h:incrf', 'field')).rejects.toThrow(arity('hincrbyfloat'));
  });

  it('HINCRBYFLOAT replies with a bulk string in RESP3 too', async () => {
    await t.call('HSET', 'h:incrf3', 'f', '1');
    const r = await resp3();
    expect(await r.send('HINCRBYFLOAT', 'h:incrf3', 'f', '0.5')).toBe('$3\r\n1.5\r\n');
  });

  it('WRONGTYPE for every hash command', async () => {
    await expectWrongType('h:wt', [
      ['HSET', 'h:wt', 'a', '1'],
      ['HMSET', 'h:wt', 'a', '1'],
      ['HSETNX', 'h:wt', 'a', '1'],
      ['HGET', 'h:wt', 'a'],
      ['HMGET', 'h:wt', 'a'],
      ['HGETALL', 'h:wt'],
      ['HDEL', 'h:wt', 'a'],
      ['HEXISTS', 'h:wt', 'a'],
      ['HLEN', 'h:wt'],
      ['HKEYS', 'h:wt'],
      ['HVALS', 'h:wt'],
      ['HSTRLEN', 'h:wt', 'a'],
      ['HINCRBY', 'h:wt', 'a', 1],
      ['HINCRBYFLOAT', 'h:wt', 'a', 1],
      ['HSCAN', 'h:wt', 0],
      ['HRANDFIELD', 'h:wt'],
      ['HRANDFIELD', 'h:wt', 2],
      ['HEXPIRE', 'h:wt', 10, 'FIELDS', 1, 'a'],
      ['HPEXPIRE', 'h:wt', 10, 'FIELDS', 1, 'a'],
      ['HTTL', 'h:wt', 'FIELDS', 1, 'a'],
      ['HPTTL', 'h:wt', 'FIELDS', 1, 'a'],
      ['HEXPIRETIME', 'h:wt', 'FIELDS', 1, 'a'],
      ['HPERSIST', 'h:wt', 'FIELDS', 1, 'a'],
      ['HGETDEL', 'h:wt', 'FIELDS', 1, 'a'],
      ['HGETEX', 'h:wt', 'FIELDS', 1, 'a'],
      ['HSETEX', 'h:wt', 'FIELDS', 1, 'a', 'b'],
    ]);
  });

  it('RESP3: HGETALL is a map, HMGET nils are _', async () => {
    await t.call('HSET', 'h:r3', 'a', '1', 'b', '2');
    const r = await resp3();
    expect(await r.send('HGETALL', 'h:r3')).toBe('%2\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n$1\r\n2\r\n');
    expect(await r.send('HGETALL', 'h:r3-missing')).toBe('%0\r\n');
    expect(await r.send('HMGET', 'h:r3', 'a', 'zz')).toBe('*2\r\n$1\r\n1\r\n_\r\n');
    expect(await r.send('HGET', 'h:r3', 'zz')).toBe('_\r\n');
    const r2 = await t.raw();
    expect(await r2.send('HGETALL', 'h:r3-missing')).toBe('*0\r\n');
    expect(await r2.send('HGET', 'h:r3', 'zz')).toBe('$-1\r\n');
  });
});

describe('hashes: HSCAN', () => {
  it('compact hash returns everything in one call regardless of COUNT', async () => {
    await t.call('HSET', 'h:scan', 'a', '1', 'b', '2', 'c', '3');
    expect(await t.call('HSCAN', 'h:scan', 0)).toEqual(['0', ['a', '1', 'b', '2', 'c', '3']]);
    expect(await t.call('HSCAN', 'h:scan', 0, 'COUNT', 1)).toEqual(['0', ['a', '1', 'b', '2', 'c', '3']]);
    expect(await t.call('HSCAN', 'h:scan', 0, 'NOVALUES')).toEqual(['0', ['a', 'b', 'c']]);
    expect(await t.call('HSCAN', 'h:scan', 0, 'MATCH', 'b*')).toEqual(['0', ['b', '2']]);
    expect(await t.call('HSCAN', 'h:scan', 0, 'MATCH', '[ac]', 'NOVALUES')).toEqual(['0', ['a', 'c']]);
    expect(await t.call('HSCAN', 'h:scan-missing', 0)).toEqual(['0', []]);
  });

  it('hashtable hash iterates with a cursor and visits every field', async () => {
    const args: string[] = [];
    for (let i = 0; i < 300; i++) args.push(`f${i}`, `v${i}`);
    await t.call('HSET', 'h:scanbig', ...args);
    expect(await enc('h:scanbig')).toBe('hashtable');
    const seen = new Map<string, string>();
    let cursor = '0';
    let calls = 0;
    do {
      const [next, items] = (await t.call('HSCAN', 'h:scanbig', cursor, 'COUNT', 20)) as [string, string[]];
      for (let i = 0; i < items.length; i += 2) seen.set(items[i], items[i + 1]);
      cursor = next;
      calls++;
    } while (cursor !== '0');
    expect(calls).toBeGreaterThan(1);
    expect(seen.size).toBe(300);
    expect(seen.get('f42')).toBe('v42');
    // NOVALUES on hashtable
    const keys = new Set<string>();
    cursor = '0';
    do {
      const [next, items] = (await t.call('HSCAN', 'h:scanbig', cursor, 'NOVALUES', 'MATCH', 'f1*')) as [string, string[]];
      for (const k of items) keys.add(k);
      cursor = next;
    } while (cursor !== '0');
    // f1, f10-f19, f100-f199
    expect(keys.size).toBe(111);
    expect([...keys].every((k) => k.startsWith('f1'))).toBe(true);
  });

  it('errors', async () => {
    await t.call('HSET', 'h:scanerr', 'a', '1');
    await expect(t.call('HSCAN', 'h:scanerr', 'abc')).rejects.toThrow('ERR invalid cursor');
    await expect(t.call('HSCAN', 'h:scanerr', 0, 'COUNT', 0)).rejects.toThrow(SYNTAX);
    await expect(t.call('HSCAN', 'h:scanerr', 0, 'COUNT', 'x')).rejects.toThrow(NOT_INT);
    await expect(t.call('HSCAN', 'h:scanerr', 0, 'FOO')).rejects.toThrow(SYNTAX);
    await expect(t.call('HSCAN', 'h:scanerr', 0, 'MATCH')).rejects.toThrow(SYNTAX);
    await expect(t.call('HSCAN', 'h:scanerr')).rejects.toThrow(arity('hscan'));
  });

  it('RESP3 reply stays a two-element array', async () => {
    await t.call('HSET', 'h:scan3', 'a', '1');
    const r = await resp3();
    expect(await r.send('HSCAN', 'h:scan3', '0')).toBe('*2\r\n$1\r\n0\r\n*2\r\n$1\r\na\r\n$1\r\n1\r\n');
  });
});

describe('hashes: HRANDFIELD', () => {
  it('no count, positive count, negative count, WITHVALUES', async () => {
    await t.call('HSET', 'h:rand', 'heads', 'obverse', 'tails', 'reverse', 'edge', 'null');
    expect(['heads', 'tails', 'edge']).toContain(await t.call('HRANDFIELD', 'h:rand'));
    const two = (await t.call('HRANDFIELD', 'h:rand', 2)) as string[];
    expect(two).toHaveLength(2);
    expect(new Set(two).size).toBe(2);
    expect(sorted(await t.call('HRANDFIELD', 'h:rand', 10))).toEqual(['edge', 'heads', 'tails']);
    const neg = (await t.call('HRANDFIELD', 'h:rand', -5)) as string[];
    expect(neg).toHaveLength(5);
    for (const f of neg) expect(['heads', 'tails', 'edge']).toContain(f);
    const wv = (await t.call('HRANDFIELD', 'h:rand', -5, 'WITHVALUES')) as string[];
    expect(wv).toHaveLength(10);
    const map: Record<string, string> = { heads: 'obverse', tails: 'reverse', edge: 'null' };
    for (let i = 0; i < wv.length; i += 2) expect(map[wv[i]]).toBe(wv[i + 1]);
    const all = (await t.call('HRANDFIELD', 'h:rand', 3, 'WITHVALUES')) as string[];
    expect(all).toHaveLength(6);
    expect(await t.call('HRANDFIELD', 'h:rand', 0)).toEqual([]);
    expect(await t.call('HRANDFIELD', 'h:rand', 0, 'WITHVALUES')).toEqual([]);
  });

  it('missing key: nil without count, empty array with count', async () => {
    expect(await t.call('HRANDFIELD', 'h:rand-missing')).toBeNull();
    expect(await t.call('HRANDFIELD', 'h:rand-missing', 3)).toEqual([]);
    expect(await t.call('HRANDFIELD', 'h:rand-missing', -3, 'WITHVALUES')).toEqual([]);
  });

  it('errors', async () => {
    await t.call('HSET', 'h:rand-err', 'a', '1');
    await expect(t.call('HRANDFIELD', 'h:rand-err', 'x')).rejects.toThrow(NOT_INT);
    await expect(t.call('HRANDFIELD', 'h:rand-err', 'WITHVALUES')).rejects.toThrow(NOT_INT);
    await expect(t.call('HRANDFIELD')).rejects.toThrow(arity('hrandfield'));
  });

  it('extra args after count are a syntax error', async () => {
    await t.call('HSET', 'h:rand-err2', 'a', '1');
    await expect(t.call('HRANDFIELD', 'h:rand-err2', 1, 'FOO')).rejects.toThrow(SYNTAX);
    await expect(t.call('HRANDFIELD', 'h:rand-err2', 1, 'WITHVALUES', 'x')).rejects.toThrow(SYNTAX);
  });

  it('RESP3: WITHVALUES returns pairs', async () => {
    await t.call('HSET', 'h:rand3', 'a', '1');
    const r = await resp3();
    expect(await r.send('HRANDFIELD', 'h:rand3', '1', 'WITHVALUES')).toBe('*1\r\n*2\r\n$1\r\na\r\n$1\r\n1\r\n');
    expect(await r.send('HRANDFIELD', 'h:rand3', '-2', 'WITHVALUES')).toBe(
      '*2\r\n*2\r\n$1\r\na\r\n$1\r\n1\r\n*2\r\n$1\r\na\r\n$1\r\n1\r\n',
    );
    expect(await r.send('HRANDFIELD', 'h:rand3', '-2')).toBe('*2\r\n$1\r\na\r\n$1\r\na\r\n');
    expect(await r.send('HRANDFIELD', 'h:rand3-missing')).toBe('_\r\n');
    const r2 = await t.raw();
    expect(await r2.send('HRANDFIELD', 'h:rand3', '-2', 'WITHVALUES')).toBe('*4\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\na\r\n$1\r\n1\r\n');
  });
});

describe('hashes: field TTL', () => {
  it('HEXPIRE sets TTL, return codes -2 / 1 / 2', async () => {
    await t.call('HSET', 'h:ex', 'a', '1', 'b', '2', 'c', '3');
    expect(await t.call('HEXPIRE', 'h:ex', 100, 'FIELDS', 2, 'a', 'nope')).toEqual([1, -2]);
    const ttl = (await t.call('HTTL', 'h:ex', 'FIELDS', 3, 'a', 'b', 'nope')) as number[];
    expect(ttl[0]).toBeGreaterThan(95);
    expect(ttl[0]).toBeLessThanOrEqual(100);
    expect(ttl.slice(1)).toEqual([-1, -2]);
    expect(await t.call('HEXPIRE', 'h:ex', 0, 'FIELDS', 1, 'b')).toEqual([2]);
    expect(await t.call('HEXISTS', 'h:ex', 'b')).toBe(0);
    expect(await t.call('HEXPIRE', 'h:ex-missing', 100, 'FIELDS', 2, 'a', 'b')).toEqual([-2, -2]);
  });

  it('NX / XX / GT / LT conditions', async () => {
    await t.call('HSET', 'h:cond', 'a', '1', 'b', '2');
    expect(await t.call('HEXPIRE', 'h:cond', 100, 'XX', 'FIELDS', 1, 'a')).toEqual([0]);
    expect(await t.call('HEXPIRE', 'h:cond', 100, 'GT', 'FIELDS', 1, 'a')).toEqual([0]);
    expect(await t.call('HEXPIRE', 'h:cond', 100, 'NX', 'FIELDS', 1, 'a')).toEqual([1]);
    expect(await t.call('HEXPIRE', 'h:cond', 200, 'NX', 'FIELDS', 1, 'a')).toEqual([0]);
    expect(await t.call('HEXPIRE', 'h:cond', 200, 'XX', 'FIELDS', 1, 'a')).toEqual([1]);
    expect(await t.call('HEXPIRE', 'h:cond', 100, 'GT', 'FIELDS', 1, 'a')).toEqual([0]);
    expect(await t.call('HEXPIRE', 'h:cond', 300, 'GT', 'FIELDS', 1, 'a')).toEqual([1]);
    expect(await t.call('HEXPIRE', 'h:cond', 400, 'LT', 'FIELDS', 1, 'a')).toEqual([0]);
    expect(await t.call('HEXPIRE', 'h:cond', 50, 'lt', 'FIELDS', 1, 'a')).toEqual([1]);
    // LT on a field without TTL: no TTL counts as infinite, so it is set
    expect(await t.call('HEXPIRE', 'h:cond', 50, 'LT', 'FIELDS', 2, 'b', 'zz')).toEqual([1, -2]);
    const ttl = (await t.call('HTTL', 'h:cond', 'FIELDS', 2, 'a', 'b')) as number[];
    expect(ttl.every((x) => x > 45 && x <= 50)).toBe(true);
  });

  it('HPEXPIRE / HEXPIREAT / HPEXPIREAT and the time getters', async () => {
    await t.call('HSET', 'h:pex', 'a', '1', 'b', '2', 'c', '3', 'd', '4');
    expect(await t.call('HPEXPIRE', 'h:pex', 100000, 'FIELDS', 1, 'a')).toEqual([1]);
    const pttl = (await t.call('HPTTL', 'h:pex', 'FIELDS', 1, 'a')) as number[];
    expect(pttl[0]).toBeGreaterThan(99000);
    expect(pttl[0]).toBeLessThanOrEqual(100000);
    const nowS = Math.floor(Date.now() / 1000);
    expect(await t.call('HEXPIREAT', 'h:pex', nowS + 1000, 'FIELDS', 1, 'b')).toEqual([1]);
    expect(await t.call('HEXPIRETIME', 'h:pex', 'FIELDS', 3, 'b', 'c', 'zz')).toEqual([nowS + 1000, -1, -2]);
    const atMs = Date.now() + 500000;
    expect(await t.call('HPEXPIREAT', 'h:pex', atMs, 'FIELDS', 1, 'c')).toEqual([1]);
    expect(await t.call('HPEXPIRETIME', 'h:pex', 'FIELDS', 1, 'c')).toEqual([atMs]);
    expect(await t.call('HEXPIRETIME', 'h:pex', 'FIELDS', 1, 'c')).toEqual([Math.floor(atMs / 1000)]);
    // past absolute time deletes the field
    expect(await t.call('HEXPIREAT', 'h:pex', 1, 'FIELDS', 1, 'd')).toEqual([2]);
    expect(await t.call('HPEXPIREAT', 'h:pex', 1, 'FIELDS', 1, 'zz')).toEqual([-2]);
    expect(await t.call('HEXISTS', 'h:pex', 'd')).toBe(0);
    expect(await t.call('HTTL', 'h:pex-missing', 'FIELDS', 1, 'a')).toEqual([-2]);
    expect(await t.call('HPTTL', 'h:pex-missing', 'FIELDS', 1, 'a')).toEqual([-2]);
    expect(await t.call('HEXPIRETIME', 'h:pex-missing', 'FIELDS', 1, 'a')).toEqual([-2]);
    expect(await t.call('HPEXPIRETIME', 'h:pex-missing', 'FIELDS', 1, 'a')).toEqual([-2]);
  });

  it('expired fields disappear; the key goes when the last field expires', async () => {
    await t.call('HSET', 'h:lazy', 'a', '1', 'b', '2');
    expect(await t.call('HPEXPIRE', 'h:lazy', 50, 'FIELDS', 1, 'a')).toEqual([1]);
    await sleep(120);
    expect(await t.call('HGET', 'h:lazy', 'a')).toBeNull();
    expect(await t.call('HGETALL', 'h:lazy')).toEqual(['b', '2']);
    // unverified: HLEN may still count an expired-but-not-yet-reclaimed field in Redis, so it is not asserted here
    expect(await t.call('HPEXPIRE', 'h:lazy', 50, 'FIELDS', 1, 'b')).toEqual([1]);
    await sleep(120);
    expect(await t.call('HGETALL', 'h:lazy')).toEqual([]);
    // Redis's active expire cycle reclaims expired fields (and then the empty key) within a few cycles
    let exists = 1;
    for (let i = 0; i < 20 && exists; i++) {
      exists = (await t.call('EXISTS', 'h:lazy')) as number;
      if (exists) await sleep(100);
    }
    expect(exists).toBe(0);
  });

  it('HPERSIST returns -2 / -1 / 1', async () => {
    await t.call('HSET', 'h:persist', 'a', '1', 'b', '2');
    await t.call('HEXPIRE', 'h:persist', 100, 'FIELDS', 1, 'a');
    expect(await t.call('HPERSIST', 'h:persist', 'FIELDS', 3, 'a', 'b', 'zz')).toEqual([1, -1, -2]);
    expect(await t.call('HTTL', 'h:persist', 'FIELDS', 1, 'a')).toEqual([-1]);
    expect(await t.call('HPERSIST', 'h:persist-missing', 'FIELDS', 1, 'a')).toEqual([-2]);
  });

  it('HSET on a field with a TTL clears the TTL', async () => {
    await t.call('HSET', 'h:hsetttl', 'a', '1');
    await t.call('HEXPIRE', 'h:hsetttl', 100, 'FIELDS', 1, 'a');
    await t.call('HSET', 'h:hsetttl', 'a', '2');
    expect(await t.call('HTTL', 'h:hsetttl', 'FIELDS', 1, 'a')).toEqual([-1]);
  });

  it('FIELDS / numfields errors', async () => {
    await t.call('HSET', 'h:experr', 'a', '1');
    const mismatch = 'ERR The `numfields` parameter must match the number of arguments';
    const missing = 'ERR Mandatory argument FIELDS is missing or not at the right position';
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'FIELDS', 2, 'a')).rejects.toThrow(mismatch);
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'FIELDS', 1, 'a', 'b')).rejects.toThrow(mismatch);
    await expect(t.call('HTTL', 'h:experr', 'FIELDS', 2, 'a')).rejects.toThrow(mismatch);
    await expect(t.call('HPERSIST', 'h:experr', 'FIELDS', 2, 'a')).rejects.toThrow(mismatch);
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'FOO', 'FIELDS', 1, 'a')).rejects.toThrow(missing);
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'NX', 1, 'a', 'b')).rejects.toThrow(missing);
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'FIELDS', 0, 'a')).rejects.toThrow('ERR Number of fields must be a positive integer');
    await expect(t.call('HEXPIRE', 'h:experr', 'x', 'FIELDS', 1, 'a')).rejects.toThrow(NOT_INT);
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'FIELDS', 1)).rejects.toThrow(arity('hexpire'));
    await expect(t.call('HTTL', 'h:experr', 'FIELDS', 1)).rejects.toThrow(arity('httl'));
    await expect(t.call('HPERSIST', 'h:experr', 'a')).rejects.toThrow(arity('hpersist'));
  });

  it('RESP3 HTTL is an array of integers', async () => {
    await t.call('HSET', 'h:ttl3', 'a', '1');
    const r = await resp3();
    expect(await r.send('HTTL', 'h:ttl3', 'FIELDS', '2', 'a', 'b')).toBe('*2\r\n:-1\r\n:-2\r\n');
  });
});

describe('hashes: HGETDEL / HGETEX / HSETEX', () => {
  it('HGETDEL returns values and deletes; the key goes when empty', async () => {
    await t.call('HSET', 'h:gd', 'a', '1', 'b', '2', 'c', '3');
    expect(await t.call('HGETDEL', 'h:gd', 'FIELDS', 2, 'a', 'zz')).toEqual(['1', null]);
    expect(await t.call('HKEYS', 'h:gd')).toEqual(['b', 'c']);
    expect(await t.call('HGETDEL', 'h:gd', 'FIELDS', 2, 'b', 'c')).toEqual(['2', '3']);
    expect(await t.call('EXISTS', 'h:gd')).toBe(0);
    expect(await t.call('HGETDEL', 'h:gd', 'FIELDS', 1, 'a')).toEqual([null]);
    await expect(t.call('HGETDEL', 'h:gd', 'FIELDS', 2, 'a')).rejects.toThrow(
      'ERR The `numfields` parameter must match the number of arguments',
    );
    await expect(t.call('HGETDEL', 'h:gd', 'FIELDS', 0, 'a')).rejects.toThrow('ERR Number of fields must be a positive integer');
    await expect(t.call('HGETDEL', 'h:gd', 'a')).rejects.toThrow(arity('hgetdel'));
  });

  it('HGETEX sets / clears TTLs while reading', async () => {
    await t.call('HSET', 'h:gex', 'a', '1', 'b', '2');
    expect(await t.call('HGETEX', 'h:gex', 'FIELDS', 2, 'a', 'zz')).toEqual(['1', null]);
    expect(await t.call('HTTL', 'h:gex', 'FIELDS', 1, 'a')).toEqual([-1]);
    expect(await t.call('HGETEX', 'h:gex', 'EX', 100, 'FIELDS', 1, 'a')).toEqual(['1']);
    const ttl = (await t.call('HTTL', 'h:gex', 'FIELDS', 1, 'a')) as number[];
    expect(ttl[0]).toBeGreaterThan(95);
    expect(await t.call('HGETEX', 'h:gex', 'PX', 200000, 'FIELDS', 1, 'b')).toEqual(['2']);
    const pttl = (await t.call('HPTTL', 'h:gex', 'FIELDS', 1, 'b')) as number[];
    expect(pttl[0]).toBeGreaterThan(190000);
    const at = Math.floor(Date.now() / 1000) + 1000;
    expect(await t.call('HGETEX', 'h:gex', 'EXAT', at, 'FIELDS', 1, 'a')).toEqual(['1']);
    expect(await t.call('HEXPIRETIME', 'h:gex', 'FIELDS', 1, 'a')).toEqual([at]);
    const atMs = Date.now() + 1000000;
    expect(await t.call('HGETEX', 'h:gex', 'PXAT', atMs, 'FIELDS', 1, 'a')).toEqual(['1']);
    expect(await t.call('HPEXPIRETIME', 'h:gex', 'FIELDS', 1, 'a')).toEqual([atMs]);
    expect(await t.call('HGETEX', 'h:gex', 'PERSIST', 'FIELDS', 2, 'a', 'b')).toEqual(['1', '2']);
    expect(await t.call('HTTL', 'h:gex', 'FIELDS', 2, 'a', 'b')).toEqual([-1, -1]);
    expect(await t.call('HGETEX', 'h:gex-missing', 'EX', 10, 'FIELDS', 1, 'a')).toEqual([null]);
    await expect(t.call('HGETEX', 'h:gex', 'EX', 10, 'FIELDS', 2, 'a')).rejects.toThrow(
      'ERR The `numfields` parameter must match the number of arguments',
    );
    await expect(t.call('HGETEX', 'h:gex', 'EX', 'x', 'FIELDS', 1, 'a')).rejects.toThrow(NOT_INT);
    await expect(t.call('HGETEX', 'h:gex', 'a')).rejects.toThrow(arity('hgetex'));
  });

  it('HSETEX with FNX / FXX / EX / KEEPTTL', async () => {
    expect(await t.call('HSETEX', 'h:sex', 'FIELDS', 2, 'a', '1', 'b', '2')).toBe(1);
    expect(await t.call('HMGET', 'h:sex', 'a', 'b')).toEqual(['1', '2']);
    expect(await t.call('HSETEX', 'h:sex', 'FNX', 'FIELDS', 2, 'a', 'x', 'c', '3')).toBe(0);
    expect(await t.call('HMGET', 'h:sex', 'a', 'c')).toEqual(['1', null]);
    expect(await t.call('HSETEX', 'h:sex', 'FXX', 'FIELDS', 2, 'a', 'x', 'c', '3')).toBe(0);
    expect(await t.call('HMGET', 'h:sex', 'a', 'c')).toEqual(['1', null]);
    expect(await t.call('HSETEX', 'h:sex', 'FNX', 'FIELDS', 1, 'c', '3')).toBe(1);
    expect(await t.call('HSETEX', 'h:sex', 'FXX', 'EX', 100, 'FIELDS', 2, 'a', 'A', 'b', 'B')).toBe(1);
    expect(await t.call('HMGET', 'h:sex', 'a', 'b')).toEqual(['A', 'B']);
    const ttl = (await t.call('HTTL', 'h:sex', 'FIELDS', 2, 'a', 'b')) as number[];
    expect(ttl.every((x) => x > 95 && x <= 100)).toBe(true);
    expect(await t.call('HSETEX', 'h:sex', 'KEEPTTL', 'FIELDS', 1, 'a', 'AA')).toBe(1);
    const kept = (await t.call('HTTL', 'h:sex', 'FIELDS', 1, 'a')) as number[];
    expect(kept[0]).toBeGreaterThan(95);
    expect(await t.call('HSETEX', 'h:sex', 'FIELDS', 1, 'a', 'AAA')).toBe(1);
    expect(await t.call('HTTL', 'h:sex', 'FIELDS', 1, 'a')).toEqual([-1]);
    expect(await t.call('HSETEX', 'h:sex', 'PX', 100000, 'FIELDS', 1, 'b', 'x')).toBe(1);
    const pttl = (await t.call('HPTTL', 'h:sex', 'FIELDS', 1, 'b')) as number[];
    expect(pttl[0]).toBeGreaterThan(99000);
    // FXX on a missing key: nothing to update
    expect(await t.call('HSETEX', 'h:sex-missing', 'FXX', 'FIELDS', 1, 'a', '1')).toBe(0);
    expect(await t.call('EXISTS', 'h:sex-missing')).toBe(0);
  });

  it('HSETEX errors', async () => {
    // unverified: exact text of the numfields mismatch error for HSETEX; only assert that it errors
    await expect(t.call('HSETEX', 'h:sexerr', 'FIELDS', 2, 'a', '1')).rejects.toThrow();
    await expect(t.call('HSETEX', 'h:sexerr', 'FIELDS', 1, 'a')).rejects.toThrow(arity('hsetex'));
    expect(await t.call('EXISTS', 'h:sexerr')).toBe(0);
  });

  it('HSETEX rejects two expiration options', async () => {
    // unverified (high confidence): only one of EX/PX/EXAT/PXAT/KEEPTTL is allowed; exact error text not asserted
    await expect(t.call('HSETEX', 'h:sexerr2', 'EX', 10, 'PX', 10, 'FIELDS', 1, 'a', '1')).rejects.toThrow();
    expect(await t.call('EXISTS', 'h:sexerr2')).toBe(0);
  });

  it('HSETEX rejects FNX together with FXX', async () => {
    // unverified (high confidence): FNX and FXX are mutually exclusive; exact error text not asserted
    await expect(t.call('HSETEX', 'h:sexerr', 'FNX', 'FXX', 'FIELDS', 1, 'a', '1')).rejects.toThrow();
  });
});

describe('hashes: encodings', () => {
  it('listpack → hashtable by entries and by value size; listpackex with TTLs', async () => {
    await t.call('HSET', 'h:enc1', 'a', '1');
    expect(await enc('h:enc1')).toBe('listpack');
    for (let i = 0; i < 127; i++) await t.call('HSET', 'h:enc1', `f${i}`, 'v');
    expect(await t.call('HLEN', 'h:enc1')).toBe(128);
    expect(await enc('h:enc1')).toBe('listpack');
    await t.call('HSET', 'h:enc1', 'one-more', 'v');
    expect(await enc('h:enc1')).toBe('hashtable');
    await t.call('HSET', 'h:enc2', 'a', 'x'.repeat(64));
    expect(await enc('h:enc2')).toBe('listpack');
    await t.call('HSET', 'h:enc2', 'b', 'x'.repeat(65));
    expect(await enc('h:enc2')).toBe('hashtable');
    await t.call('HSET', 'h:enc3', 'f'.repeat(65), '1');
    expect(await enc('h:enc3')).toBe('hashtable');
    await t.call('HSET', 'h:enc4', 'a', '1');
    await t.call('HPEXPIRE', 'h:enc4', 100000, 'FIELDS', 1, 'a');
    expect(await enc('h:enc4')).toBe('listpackex');
    await t.call('HSETEX', 'h:enc5', 'EX', 100, 'FIELDS', 1, 'a', '1');
    expect(await enc('h:enc5')).toBe('listpackex');
  });
});

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

describe('lists: push / pop / basic reads', () => {
  it('LPUSH / RPUSH / LPUSHX / RPUSHX', async () => {
    expect(await t.call('LPUSH', 'l:push', 'a', 'b', 'c')).toBe(3);
    expect(await t.call('RPUSH', 'l:push', 'x', 'y')).toBe(5);
    expect(await t.call('LRANGE', 'l:push', 0, -1)).toEqual(['c', 'b', 'a', 'x', 'y']);
    expect(await t.call('LPUSHX', 'l:push', 'h')).toBe(6);
    expect(await t.call('RPUSHX', 'l:push', 't', 'u')).toBe(8);
    expect(await t.call('LPUSHX', 'l:pushx-missing', 'a')).toBe(0);
    expect(await t.call('RPUSHX', 'l:pushx-missing', 'a')).toBe(0);
    expect(await t.call('EXISTS', 'l:pushx-missing')).toBe(0);
    await expect(t.call('LPUSH', 'l:push')).rejects.toThrow(arity('lpush'));
    await expect(t.call('RPUSH', 'l:push')).rejects.toThrow(arity('rpush'));
    await expect(t.call('LPUSHX', 'l:push')).rejects.toThrow(arity('lpushx'));
    await expect(t.call('RPUSHX', 'l:push')).rejects.toThrow(arity('rpushx'));
  });

  it('LPOP / RPOP with and without count', async () => {
    await t.call('RPUSH', 'l:pop', 'one', 'two', 'three', 'four', 'five');
    expect(await t.call('LPOP', 'l:pop')).toBe('one');
    expect(await t.call('LPOP', 'l:pop', 2)).toEqual(['two', 'three']);
    expect(await t.call('RPOP', 'l:pop')).toBe('five');
    expect(await t.call('LPOP', 'l:pop', 0)).toEqual([]);
    expect(await t.call('RPOP', 'l:pop', 0)).toEqual([]);
    expect(await t.call('RPOP', 'l:pop', 10)).toEqual(['four']);
    expect(await t.call('EXISTS', 'l:pop')).toBe(0);
    expect(await t.call('LPOP', 'l:pop')).toBeNull();
    expect(await t.call('LPOP', 'l:pop', 2)).toBeNull();
    expect(await t.call('RPOP', 'l:pop', 0)).toBeNull();
    await expect(t.call('LPOP', 'l:pop', -1)).rejects.toThrow('ERR value is out of range, must be positive');
    await expect(t.call('RPOP', 'l:pop', 'x')).rejects.toThrow('ERR value is out of range, must be positive');
    await expect(t.call('RPOP')).rejects.toThrow(arity('rpop'));
  });

  it('LPOP / RPOP with more than one count argument is an arity error', async () => {
    await expect(t.call('LPOP', 'l:pop', 1, 2)).rejects.toThrow(arity('lpop'));
    await expect(t.call('RPOP', 'l:pop', 1, 2)).rejects.toThrow(arity('rpop'));
  });

  it('LPOP wire format: nil array with count on missing key, empty array for count 0', async () => {
    await t.call('RPUSH', 'l:popwire', 'a');
    const r2 = await t.raw();
    expect(await r2.send('LPOP', 'l:popwire-missing')).toBe('$-1\r\n');
    expect(await r2.send('LPOP', 'l:popwire', '0')).toBe('*0\r\n');
    const r3 = await resp3();
    expect(await r3.send('LPOP', 'l:popwire-missing', '1')).toBe('_\r\n');
    expect(await r3.send('RPOP', 'l:popwire-missing')).toBe('_\r\n');
    expect(await r3.send('LPOP', 'l:popwire', '5')).toBe('*1\r\n$1\r\na\r\n');
  });

  it('LPOP / RPOP with count on a missing key reply with a null array in RESP2', async () => {
    const r2 = await t.raw();
    expect(await r2.send('LPOP', 'l:popwire-missing', '1')).toBe('*-1\r\n');
    expect(await r2.send('RPOP', 'l:popwire-missing', '0')).toBe('*-1\r\n');
  });

  it('LLEN / LRANGE / LINDEX', async () => {
    await t.call('RPUSH', 'l:range', 'one', 'two', 'three');
    expect(await t.call('LLEN', 'l:range')).toBe(3);
    expect(await t.call('LLEN', 'l:range-missing')).toBe(0);
    expect(await t.call('LRANGE', 'l:range', 0, 0)).toEqual(['one']);
    expect(await t.call('LRANGE', 'l:range', -3, 2)).toEqual(['one', 'two', 'three']);
    expect(await t.call('LRANGE', 'l:range', -100, 100)).toEqual(['one', 'two', 'three']);
    expect(await t.call('LRANGE', 'l:range', 5, 10)).toEqual([]);
    expect(await t.call('LRANGE', 'l:range', 2, 1)).toEqual([]);
    expect(await t.call('LRANGE', 'l:range-missing', 0, -1)).toEqual([]);
    expect(await t.call('LINDEX', 'l:range', 0)).toBe('one');
    expect(await t.call('LINDEX', 'l:range', -1)).toBe('three');
    expect(await t.call('LINDEX', 'l:range', 3)).toBeNull();
    expect(await t.call('LINDEX', 'l:range-missing', 0)).toBeNull();
    await expect(t.call('LRANGE', 'l:range', 'a', 1)).rejects.toThrow(NOT_INT);
    await expect(t.call('LINDEX', 'l:range', 'a')).rejects.toThrow(NOT_INT);
    await expect(t.call('LRANGE', 'l:range', 0)).rejects.toThrow(arity('lrange'));
    await expect(t.call('LINDEX', 'l:range')).rejects.toThrow(arity('lindex'));
    await expect(t.call('LLEN')).rejects.toThrow(arity('llen'));
  });

  it('LSET', async () => {
    await t.call('RPUSH', 'l:set', 'one', 'two', 'three');
    expect(await t.call('LSET', 'l:set', 0, 'four')).toBe('OK');
    expect(await t.call('LSET', 'l:set', -2, 'five')).toBe('OK');
    expect(await t.call('LRANGE', 'l:set', 0, -1)).toEqual(['four', 'five', 'three']);
    await expect(t.call('LSET', 'l:set', 3, 'x')).rejects.toThrow('ERR index out of range');
    await expect(t.call('LSET', 'l:set', -4, 'x')).rejects.toThrow('ERR index out of range');
    await expect(t.call('LSET', 'l:set-missing', 0, 'x')).rejects.toThrow('ERR no such key');
    await expect(t.call('LSET', 'l:set', 'x', 'x')).rejects.toThrow(NOT_INT);
    await expect(t.call('LSET', 'l:set', 0)).rejects.toThrow(arity('lset'));
  });

  it('LREM with positive, negative and zero count', async () => {
    await t.call('RPUSH', 'l:rem', 'hello', 'hello', 'foo', 'hello');
    expect(await t.call('LREM', 'l:rem', -2, 'hello')).toBe(2);
    expect(await t.call('LRANGE', 'l:rem', 0, -1)).toEqual(['hello', 'foo']);
    await t.call('RPUSH', 'l:rem2', 'a', 'b', 'a', 'c', 'a', 'a');
    expect(await t.call('LREM', 'l:rem2', 2, 'a')).toBe(2);
    expect(await t.call('LRANGE', 'l:rem2', 0, -1)).toEqual(['b', 'c', 'a', 'a']);
    expect(await t.call('LREM', 'l:rem2', 0, 'a')).toBe(2);
    expect(await t.call('LREM', 'l:rem2', 0, 'zz')).toBe(0);
    expect(await t.call('LREM', 'l:rem2', 0, 'b')).toBe(1);
    expect(await t.call('LREM', 'l:rem2', 0, 'c')).toBe(1);
    expect(await t.call('EXISTS', 'l:rem2')).toBe(0);
    expect(await t.call('LREM', 'l:rem-missing', 0, 'a')).toBe(0);
    await expect(t.call('LREM', 'l:rem', 'x', 'a')).rejects.toThrow(NOT_INT);
    await expect(t.call('LREM', 'l:rem', 0)).rejects.toThrow(arity('lrem'));
  });

  it('LTRIM', async () => {
    await t.call('RPUSH', 'l:trim', 'one', 'two', 'three');
    expect(await t.call('LTRIM', 'l:trim', 1, -1)).toBe('OK');
    expect(await t.call('LRANGE', 'l:trim', 0, -1)).toEqual(['two', 'three']);
    expect(await t.call('LTRIM', 'l:trim', 5, 10)).toBe('OK');
    expect(await t.call('EXISTS', 'l:trim')).toBe(0);
    expect(await t.call('LTRIM', 'l:trim-missing', 0, 1)).toBe('OK');
    await t.call('RPUSH', 'l:trim2', 'a', 'b', 'c', 'd');
    expect(await t.call('LTRIM', 'l:trim2', -2, 100)).toBe('OK');
    expect(await t.call('LRANGE', 'l:trim2', 0, -1)).toEqual(['c', 'd']);
    await expect(t.call('LTRIM', 'l:trim2', 'a', 1)).rejects.toThrow(NOT_INT);
    await expect(t.call('LTRIM', 'l:trim2', 0)).rejects.toThrow(arity('ltrim'));
  });

  it('LINSERT', async () => {
    await t.call('RPUSH', 'l:ins', 'Hello', 'World');
    expect(await t.call('LINSERT', 'l:ins', 'BEFORE', 'World', 'There')).toBe(3);
    expect(await t.call('LRANGE', 'l:ins', 0, -1)).toEqual(['Hello', 'There', 'World']);
    expect(await t.call('LINSERT', 'l:ins', 'after', 'World', '!')).toBe(4);
    expect(await t.call('LRANGE', 'l:ins', 0, -1)).toEqual(['Hello', 'There', 'World', '!']);
    expect(await t.call('LINSERT', 'l:ins', 'BEFORE', 'nope', 'x')).toBe(-1);
    expect(await t.call('LINSERT', 'l:ins-missing', 'BEFORE', 'a', 'x')).toBe(0);
    expect(await t.call('EXISTS', 'l:ins-missing')).toBe(0);
    await expect(t.call('LINSERT', 'l:ins', 'MIDDLE', 'World', 'x')).rejects.toThrow(SYNTAX);
    await expect(t.call('LINSERT', 'l:ins', 'BEFORE', 'World')).rejects.toThrow(arity('linsert'));
  });

  it('LPOS with RANK / COUNT / MAXLEN (docs examples)', async () => {
    await t.call('RPUSH', 'l:pos', 'a', 'b', 'c', 'd', '1', '2', '3', '4', '3', '3', '3');
    expect(await t.call('LPOS', 'l:pos', '3')).toBe(6);
    expect(await t.call('LPOS', 'l:pos', '3', 'COUNT', 0, 'RANK', 2)).toEqual([8, 9, 10]);
    await t.call('RPUSH', 'l:pos2', 'a', 'b', 'c', '1', '2', '3', 'c', 'c');
    expect(await t.call('LPOS', 'l:pos2', 'c', 'RANK', 2)).toBe(6);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'RANK', -1)).toBe(7);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'COUNT', 2)).toEqual([2, 6]);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'RANK', -1, 'COUNT', 2)).toEqual([7, 6]);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'COUNT', 0)).toEqual([2, 6, 7]);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'COUNT', 0, 'MAXLEN', 7)).toEqual([2, 6]);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'MAXLEN', 2)).toBeNull();
    expect(await t.call('LPOS', 'l:pos2', 'c', 'MAXLEN', 0)).toBe(2);
    expect(await t.call('LPOS', 'l:pos2', 'zz')).toBeNull();
    expect(await t.call('LPOS', 'l:pos2', 'zz', 'COUNT', 1)).toEqual([]);
    expect(await t.call('LPOS', 'l:pos-missing', 'a')).toBeNull();
    expect(await t.call('LPOS', 'l:pos-missing', 'a', 'COUNT', 1)).toEqual([]);
    await expect(t.call('LPOS', 'l:pos2', 'c', 'RANK', 0)).rejects.toThrow(
      "ERR RANK can't be zero: use 1 to start from the first match, 2 from the second ... or use negative to start from the end of the list",
    );
    await expect(t.call('LPOS', 'l:pos2', 'c', 'COUNT', -1)).rejects.toThrow("ERR COUNT can't be negative");
    await expect(t.call('LPOS', 'l:pos2', 'c', 'FOO', 1)).rejects.toThrow(SYNTAX);
    await expect(t.call('LPOS', 'l:pos2', 'c', 'RANK', 'x')).rejects.toThrow(NOT_INT);
    await expect(t.call('LPOS', 'l:pos2')).rejects.toThrow(arity('lpos'));
  });

  it('LPOS option without a value is a syntax error', async () => {
    await t.call('RPUSH', 'l:pos-syn', 'a');
    await expect(t.call('LPOS', 'l:pos-syn', 'c', 'RANK')).rejects.toThrow(SYNTAX);
    await expect(t.call('LPOS', 'l:pos-syn', 'a', 'COUNT')).rejects.toThrow(SYNTAX);
    await expect(t.call('LPOS', 'l:pos-syn', 'a', 'MAXLEN')).rejects.toThrow(SYNTAX);
  });

  it('LPOS negative MAXLEN', async () => {
    await t.call('RPUSH', 'l:pos-ml', 'a');
    await expect(t.call('LPOS', 'l:pos-ml', 'c', 'MAXLEN', -1)).rejects.toThrow("ERR MAXLEN can't be negative");
  });

  it('LPOS RESP3 null', async () => {
    const r = await resp3();
    expect(await r.send('LPOS', 'l:pos3-missing', 'a')).toBe('_\r\n');
    const r2 = await t.raw();
    expect(await r2.send('LPOS', 'l:pos3-missing', 'a')).toBe('$-1\r\n');
  });
});

describe('lists: moves and multi-pop', () => {
  it('LMOVE (docs example) and same-key rotation', async () => {
    await t.call('RPUSH', 'l:mv', 'one', 'two', 'three');
    expect(await t.call('LMOVE', 'l:mv', 'l:mv-dst', 'RIGHT', 'LEFT')).toBe('three');
    expect(await t.call('LMOVE', 'l:mv', 'l:mv-dst', 'LEFT', 'RIGHT')).toBe('one');
    expect(await t.call('LRANGE', 'l:mv', 0, -1)).toEqual(['two']);
    expect(await t.call('LRANGE', 'l:mv-dst', 0, -1)).toEqual(['three', 'one']);
    await t.call('RPUSH', 'l:rot', 'a', 'b', 'c');
    expect(await t.call('LMOVE', 'l:rot', 'l:rot', 'LEFT', 'RIGHT')).toBe('a');
    expect(await t.call('LRANGE', 'l:rot', 0, -1)).toEqual(['b', 'c', 'a']);
    expect(await t.call('LMOVE', 'l:mv-missing', 'l:mv-dst', 'LEFT', 'LEFT')).toBeNull();
    expect(await t.call('LMOVE', 'l:mv', 'l:mv-dst', 'left', 'left')).toBe('two');
    expect(await t.call('EXISTS', 'l:mv')).toBe(0);
    await expect(t.call('LMOVE', 'l:mv-dst', 'x', 'UP', 'LEFT')).rejects.toThrow(SYNTAX);
    await expect(t.call('LMOVE', 'l:mv-dst', 'x', 'LEFT')).rejects.toThrow(arity('lmove'));
    // wrong-type destination leaves the source untouched
    await t.call('SET', 'l:mv-str', 'v');
    await expect(t.call('LMOVE', 'l:mv-dst', 'l:mv-str', 'LEFT', 'LEFT')).rejects.toThrow(WRONGTYPE);
    expect(await t.call('LLEN', 'l:mv-dst')).toBe(3);
  });

  it('RPOPLPUSH', async () => {
    await t.call('RPUSH', 'l:rpl', 'one', 'two', 'three');
    expect(await t.call('RPOPLPUSH', 'l:rpl', 'l:rpl-dst')).toBe('three');
    expect(await t.call('LRANGE', 'l:rpl', 0, -1)).toEqual(['one', 'two']);
    expect(await t.call('LRANGE', 'l:rpl-dst', 0, -1)).toEqual(['three']);
    expect(await t.call('RPOPLPUSH', 'l:rpl', 'l:rpl')).toBe('two');
    expect(await t.call('LRANGE', 'l:rpl', 0, -1)).toEqual(['two', 'one']);
    expect(await t.call('RPOPLPUSH', 'l:rpl-missing', 'l:rpl-dst')).toBeNull();
    await expect(t.call('RPOPLPUSH', 'l:rpl')).rejects.toThrow(arity('rpoplpush'));
  });

  it('LMPOP (docs example) and errors', async () => {
    expect(await t.call('LMPOP', 2, 'l:mp-non1', 'l:mp-non2', 'LEFT', 'COUNT', 10)).toBeNull();
    await t.call('LPUSH', 'l:mp', 'one', 'two', 'three', 'four', 'five');
    expect(await t.call('LMPOP', 1, 'l:mp', 'LEFT')).toEqual(['l:mp', ['five']]);
    expect(await t.call('LRANGE', 'l:mp', 0, -1)).toEqual(['four', 'three', 'two', 'one']);
    expect(await t.call('LMPOP', 1, 'l:mp', 'RIGHT', 'COUNT', 10)).toEqual(['l:mp', ['one', 'two', 'three', 'four']]);
    expect(await t.call('EXISTS', 'l:mp')).toBe(0);
    await t.call('LPUSH', 'l:mp2', 'a', 'b', 'c');
    await t.call('LPUSH', 'l:mp3', 'x');
    expect(await t.call('LMPOP', 3, 'l:mp-non1', 'l:mp2', 'l:mp3', 'RIGHT', 'COUNT', 2)).toEqual(['l:mp2', ['a', 'b']]);
    await expect(t.call('LMPOP', 0, 'l:mp2', 'LEFT')).rejects.toThrow('ERR numkeys should be greater than 0');
    await expect(t.call('LMPOP', 1, 'l:mp2', 'UP')).rejects.toThrow(SYNTAX);
    await expect(t.call('LMPOP', 1, 'l:mp2', 'LEFT', 'COUNT', 0)).rejects.toThrow('ERR count should be greater than 0');
    await expect(t.call('LMPOP', 1, 'l:mp2', 'LEFT', 'COUNT')).rejects.toThrow(SYNTAX);
    await expect(t.call('LMPOP', 1, 'l:mp2', 'LEFT', 'FOO', 1)).rejects.toThrow(SYNTAX);
    await expect(t.call('LMPOP', 1, 'l:mp2')).rejects.toThrow(arity('lmpop'));
  });

  it('LMPOP RESP3 shape and nil', async () => {
    await t.call('RPUSH', 'l:mp3r', 'a');
    const r = await resp3();
    expect(await r.send('LMPOP', '1', 'l:mp3r', 'LEFT')).toBe('*2\r\n$6\r\nl:mp3r\r\n*1\r\n$1\r\na\r\n');
    expect(await r.send('LMPOP', '1', 'l:mp3r', 'LEFT')).toBe('_\r\n');
    const r2 = await t.raw();
    expect(await r2.send('LMPOP', '1', 'l:mp3r', 'LEFT')).toBe('*-1\r\n');
  });

  it('WRONGTYPE for every list command', async () => {
    await expectWrongType('l:wt', [
      ['LPUSH', 'l:wt', 'a'],
      ['RPUSH', 'l:wt', 'a'],
      ['LPUSHX', 'l:wt', 'a'],
      ['RPUSHX', 'l:wt', 'a'],
      ['LPOP', 'l:wt'],
      ['RPOP', 'l:wt', 2],
      ['LLEN', 'l:wt'],
      ['LRANGE', 'l:wt', 0, -1],
      ['LINDEX', 'l:wt', 0],
      ['LSET', 'l:wt', 0, 'a'],
      ['LREM', 'l:wt', 0, 'a'],
      ['LTRIM', 'l:wt', 0, 1],
      ['LINSERT', 'l:wt', 'BEFORE', 'a', 'b'],
      ['LPOS', 'l:wt', 'a'],
      ['LMOVE', 'l:wt', 'l:wt-d', 'LEFT', 'LEFT'],
      ['RPOPLPUSH', 'l:wt', 'l:wt-d'],
      ['LMPOP', 1, 'l:wt', 'LEFT'],
      ['BLPOP', 'l:wt', 0],
      ['BRPOP', 'l:wt', 0],
      ['BLMOVE', 'l:wt', 'l:wt-d', 'LEFT', 'LEFT', 0],
      ['BRPOPLPUSH', 'l:wt', 'l:wt-d', 0],
      ['BLMPOP', 0, 1, 'l:wt', 'LEFT'],
    ]);
  });
});

describe('lists: blocking', () => {
  it('BLPOP / BRPOP return immediately when data exists, first non-empty key wins', async () => {
    await t.call('RPUSH', 'l:b-k2', 'a', 'b', 'c');
    expect(await t.call('BLPOP', 'l:b-k1', 'l:b-k2', 0)).toEqual(['l:b-k2', 'a']);
    expect(await t.call('BRPOP', 'l:b-k1', 'l:b-k2', 0)).toEqual(['l:b-k2', 'c']);
  });

  it('BLPOP blocks until another client pushes', async () => {
    const c = t.client();
    const p = c.call('BLPOP', 'l:b-wait', '0');
    await sleep(50);
    expect(await t.call('RPUSH', 'l:b-wait', 'x', 'y')).toBe(2);
    expect(await p).toEqual(['l:b-wait', 'x']);
    expect(await t.call('LRANGE', 'l:b-wait', 0, -1)).toEqual(['y']);
  });

  it('BRPOP blocks until another client pushes', async () => {
    const c = t.client();
    const p = c.call('BRPOP', 'l:b-wait2', 'l:b-wait3', '0');
    await sleep(50);
    await t.call('RPUSH', 'l:b-wait3', 'x', 'y');
    expect(await p).toEqual(['l:b-wait3', 'y']);
  });

  it('waiters are served FIFO', async () => {
    const c1 = t.client();
    const c2 = t.client();
    const c3 = t.client();
    const p1 = c1.call('BLPOP', 'l:b-fifo', '0');
    await sleep(30);
    const p2 = c2.call('BLPOP', 'l:b-fifo', '0');
    await sleep(30);
    const p3 = c3.call('BLPOP', 'l:b-fifo', '0');
    await sleep(30);
    await t.call('RPUSH', 'l:b-fifo', 'a', 'b');
    expect(await p1).toEqual(['l:b-fifo', 'a']);
    expect(await p2).toEqual(['l:b-fifo', 'b']);
    await t.call('RPUSH', 'l:b-fifo', 'c');
    expect(await p3).toEqual(['l:b-fifo', 'c']);
    expect(await t.call('EXISTS', 'l:b-fifo')).toBe(0);
  });

  it('timeout returns nil; float timeouts are accepted', async () => {
    const start = Date.now();
    expect(await t.call('BLPOP', 'l:b-to', '0.1')).toBeNull();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1000);
    expect(await t.call('BRPOP', 'l:b-to', '0.05')).toBeNull();
    expect(await t.call('BLMOVE', 'l:b-to', 'l:b-to2', 'LEFT', 'LEFT', '0.05')).toBeNull();
    expect(await t.call('BRPOPLPUSH', 'l:b-to', 'l:b-to2', '0.05')).toBeNull();
    expect(await t.call('BLMPOP', '0.05', 1, 'l:b-to', 'LEFT')).toBeNull();
  });

  it('timeout wire format: null array in RESP2, _ in RESP3', async () => {
    const r2 = await t.raw();
    expect(await r2.send('BLPOP', 'l:b-tow', '0.05')).toBe('*-1\r\n');
    expect(await r2.send('BLMPOP', '0.05', '1', 'l:b-tow', 'LEFT')).toBe('*-1\r\n');
    const r3 = await resp3();
    expect(await r3.send('BLPOP', 'l:b-tow', '0.05')).toBe('_\r\n');
    expect(await r3.send('BLMOVE', 'l:b-tow', 'l:b-tow2', 'LEFT', 'LEFT', '0.05')).toBe('_\r\n');
  });

  it('BRPOPLPUSH / BLMOVE timeout is a null array in RESP2 too', async () => {
    // Redis replyToBlockedClientTimedOut sends a null array for every list-blocking command
    const r2 = await t.raw();
    expect(await r2.send('BRPOPLPUSH', 'l:b-tow', 'l:b-tow2', '0.05')).toBe('*-1\r\n');
    expect(await r2.send('BLMOVE', 'l:b-tow', 'l:b-tow2', 'LEFT', 'LEFT', '0.05')).toBe('*-1\r\n');
  });

  it('timeout errors', async () => {
    await expect(t.call('BLPOP', 'l:b-err', -1)).rejects.toThrow('ERR timeout is negative');
    await expect(t.call('BRPOP', 'l:b-err', 'abc')).rejects.toThrow('ERR timeout is not a float or out of range');
    await expect(t.call('BLMOVE', 'l:b-err', 'x', 'LEFT', 'LEFT', -1)).rejects.toThrow('ERR timeout is negative');
    await expect(t.call('BRPOPLPUSH', 'l:b-err', 'x', 'abc')).rejects.toThrow('ERR timeout is not a float or out of range');
    await expect(t.call('BLMPOP', -1, 1, 'l:b-err', 'LEFT')).rejects.toThrow('ERR timeout is negative');
    await expect(t.call('BLPOP', 'l:b-err')).rejects.toThrow(arity('blpop'));
    await expect(t.call('BLMOVE', 'l:b-err', 'x', 'LEFT', 'LEFT')).rejects.toThrow(arity('blmove'));
    await expect(t.call('BRPOPLPUSH', 'l:b-err', 'x')).rejects.toThrow(arity('brpoplpush'));
    await expect(t.call('BLMPOP', 0, 1, 'l:b-err')).rejects.toThrow(arity('blmpop'));
    await expect(t.call('BLMOVE', 'l:b-err', 'x', 'UP', 'LEFT', 0)).rejects.toThrow(SYNTAX);
    await expect(t.call('BLMPOP', 0, 0, 'l:b-err', 'LEFT')).rejects.toThrow('ERR numkeys should be greater than 0');
  });

  it('BLMOVE / BRPOPLPUSH block and wake', async () => {
    const c = t.client();
    const p = c.call('BLMOVE', 'l:b-mv', 'l:b-mv-dst', 'RIGHT', 'LEFT', '0');
    await sleep(50);
    await t.call('RPUSH', 'l:b-mv', 'a', 'b');
    expect(await p).toBe('b');
    expect(await t.call('LRANGE', 'l:b-mv-dst', 0, -1)).toEqual(['b']);
    const p2 = c.call('BRPOPLPUSH', 'l:b-rpl', 'l:b-rpl-dst', '0');
    await sleep(50);
    await t.call('LPUSH', 'l:b-rpl', 'z');
    expect(await p2).toBe('z');
    expect(await t.call('LRANGE', 'l:b-rpl-dst', 0, -1)).toEqual(['z']);
    expect(await t.call('EXISTS', 'l:b-rpl')).toBe(0);
  });

  it('BLMPOP blocks and wakes with count', async () => {
    const c = t.client();
    const p = c.call('BLMPOP', '0', '2', 'l:b-mp1', 'l:b-mp2', 'LEFT', 'COUNT', '2');
    await sleep(50);
    await t.call('RPUSH', 'l:b-mp2', 'a', 'b', 'c');
    expect(await p).toEqual(['l:b-mp2', ['a', 'b']]);
    expect(await t.call('LRANGE', 'l:b-mp2', 0, -1)).toEqual(['c']);
  });

  it('a blocked BLPOP is served by an LMOVE into its key', async () => {
    const c = t.client();
    const p = c.call('BLPOP', 'l:b-chain', '0');
    await sleep(50);
    await t.call('RPUSH', 'l:b-chain-src', 'v');
    expect(await t.call('LMOVE', 'l:b-chain-src', 'l:b-chain', 'LEFT', 'LEFT')).toBe('v');
    expect(await p).toEqual(['l:b-chain', 'v']);
    expect(await t.call('EXISTS', 'l:b-chain')).toBe(0);
  });

  it('inside MULTI blocking commands do not block', async () => {
    const r = await t.raw();
    expect(await r.send('MULTI')).toBe('+OK\r\n');
    expect(await r.send('BLPOP', 'l:b-multi', '0')).toBe('+QUEUED\r\n');
    expect(await r.send('BRPOP', 'l:b-multi', '0')).toBe('+QUEUED\r\n');
    expect(await r.send('BLMPOP', '0', '1', 'l:b-multi', 'LEFT')).toBe('+QUEUED\r\n');
    expect(await r.send('EXEC')).toBe('*3\r\n*-1\r\n*-1\r\n*-1\r\n');
    expect(await r.send('MULTI')).toBe('+OK\r\n');
    await r.send('BLMOVE', 'l:b-multi', 'x', 'LEFT', 'LEFT', '0');
    await r.send('BRPOPLPUSH', 'l:b-multi', 'x', '0');
    // Redis replies with a plain null bulk for BLMOVE / BRPOPLPUSH under CLIENT_DENY_BLOCKING
    expect(await r.send('EXEC')).toBe('*2\r\n$-1\r\n$-1\r\n');
    await t.call('RPUSH', 'l:b-multi2', 'a');
    const res = await t.redis.multi().call('BLPOP', 'l:b-multi2', '0').exec();
    expect(res).toEqual([[null, ['l:b-multi2', 'a']]]);
  });
});

describe('lists: encodings', () => {
  it('listpack → quicklist and back', async () => {
    await t.call('RPUSH', 'l:enc', 'a', 'b');
    expect(await enc('l:enc')).toBe('listpack');
    const big = 'x'.repeat(100);
    for (let i = 0; i < 100; i++) await t.call('RPUSH', 'l:enc', big);
    expect(await enc('l:enc')).toBe('quicklist');
    await t.call('LTRIM', 'l:enc', 0, 1);
    expect(await enc('l:enc')).toBe('listpack');
    await t.call('RPUSH', 'l:enc2', 'y'.repeat(9000));
    expect(await enc('l:enc2')).toBe('quicklist');
    // unverified: whether a single 9000-byte element is converted back after shrinking; not asserted
  });
});

/* ------------------------------------------------------------------ */
/* Sets                                                                */
/* ------------------------------------------------------------------ */

describe('sets: basic', () => {
  it('SADD / SREM / SCARD / SISMEMBER / SMISMEMBER / SMEMBERS', async () => {
    expect(await t.call('SADD', 's:b', 'Hello', 'World', 'Hello')).toBe(2);
    expect(await t.call('SADD', 's:b', 'World')).toBe(0);
    expect(sorted(await t.call('SMEMBERS', 's:b'))).toEqual(['Hello', 'World']);
    expect(await t.call('SCARD', 's:b')).toBe(2);
    expect(await t.call('SISMEMBER', 's:b', 'Hello')).toBe(1);
    expect(await t.call('SISMEMBER', 's:b', 'nope')).toBe(0);
    expect(await t.call('SMISMEMBER', 's:b', 'Hello', 'nope', 'World')).toEqual([1, 0, 1]);
    expect(await t.call('SMISMEMBER', 's:b-missing', 'a', 'b')).toEqual([0, 0]);
    expect(await t.call('SISMEMBER', 's:b-missing', 'a')).toBe(0);
    expect(await t.call('SCARD', 's:b-missing')).toBe(0);
    expect(await t.call('SMEMBERS', 's:b-missing')).toEqual([]);
    expect(await t.call('SREM', 's:b', 'Hello', 'nope')).toBe(1);
    expect(await t.call('SREM', 's:b', 'World')).toBe(1);
    expect(await t.call('EXISTS', 's:b')).toBe(0);
    expect(await t.call('SREM', 's:b', 'x')).toBe(0);
    await expect(t.call('SADD', 's:b')).rejects.toThrow(arity('sadd'));
    await expect(t.call('SREM', 's:b')).rejects.toThrow(arity('srem'));
    await expect(t.call('SCARD')).rejects.toThrow(arity('scard'));
    await expect(t.call('SISMEMBER', 's:b')).rejects.toThrow(arity('sismember'));
    await expect(t.call('SMISMEMBER', 's:b')).rejects.toThrow(arity('smismember'));
    await expect(t.call('SMEMBERS')).rejects.toThrow(arity('smembers'));
  });

  it('SPOP with and without count', async () => {
    await t.call('SADD', 's:pop', 'one', 'two', 'three', 'four', 'five');
    const one = (await t.call('SPOP', 's:pop')) as string;
    expect(['one', 'two', 'three', 'four', 'five']).toContain(one);
    const three = (await t.call('SPOP', 's:pop', 3)) as string[];
    expect(new Set(three).size).toBe(3);
    expect(three).not.toContain(one);
    expect(await t.call('SCARD', 's:pop')).toBe(1);
    expect(await t.call('SPOP', 's:pop', 0)).toEqual([]);
    expect((await t.call('SPOP', 's:pop', 10)) as string[]).toHaveLength(1);
    expect(await t.call('EXISTS', 's:pop')).toBe(0);
    expect(await t.call('SPOP', 's:pop')).toBeNull();
    expect(await t.call('SPOP', 's:pop', 2)).toEqual([]);
    await expect(t.call('SPOP', 's:pop', -1)).rejects.toThrow('ERR value is out of range, must be positive');
    await expect(t.call('SPOP', 's:pop', 'x')).rejects.toThrow('ERR value is out of range, must be positive');
    await expect(t.call('SPOP')).rejects.toThrow(arity('spop'));
  });

  it('SRANDMEMBER with ±count', async () => {
    await t.call('SADD', 's:rand', 'one', 'two', 'three');
    expect(['one', 'two', 'three']).toContain(await t.call('SRANDMEMBER', 's:rand'));
    const two = (await t.call('SRANDMEMBER', 's:rand', 2)) as string[];
    expect(two).toHaveLength(2);
    expect(new Set(two).size).toBe(2);
    expect(sorted(await t.call('SRANDMEMBER', 's:rand', 10))).toEqual(['one', 'three', 'two']);
    const neg = (await t.call('SRANDMEMBER', 's:rand', -7)) as string[];
    expect(neg).toHaveLength(7);
    for (const m of neg) expect(['one', 'two', 'three']).toContain(m);
    expect(await t.call('SRANDMEMBER', 's:rand', 0)).toEqual([]);
    expect(await t.call('SCARD', 's:rand')).toBe(3);
    expect(await t.call('SRANDMEMBER', 's:rand-missing')).toBeNull();
    expect(await t.call('SRANDMEMBER', 's:rand-missing', 5)).toEqual([]);
    expect(await t.call('SRANDMEMBER', 's:rand-missing', -5)).toEqual([]);
    await expect(t.call('SRANDMEMBER', 's:rand', 'x')).rejects.toThrow(NOT_INT);
    await expect(t.call('SRANDMEMBER')).rejects.toThrow(arity('srandmember'));
  });

  it('SPOP / SRANDMEMBER with extra args are a syntax error', async () => {
    await t.call('SADD', 's:pop-syn', 'a', 'b');
    await expect(t.call('SPOP', 's:pop-syn', 1, 2)).rejects.toThrow(SYNTAX);
    await expect(t.call('SRANDMEMBER', 's:pop-syn', 1, 2)).rejects.toThrow(SYNTAX);
    expect(await t.call('SCARD', 's:pop-syn')).toBe(2);
  });

  it('SMOVE', async () => {
    await t.call('SADD', 's:mv-src', 'one', 'two');
    await t.call('SADD', 's:mv-dst', 'three');
    expect(await t.call('SMOVE', 's:mv-src', 's:mv-dst', 'two')).toBe(1);
    expect(sorted(await t.call('SMEMBERS', 's:mv-src'))).toEqual(['one']);
    expect(sorted(await t.call('SMEMBERS', 's:mv-dst'))).toEqual(['three', 'two']);
    expect(await t.call('SMOVE', 's:mv-src', 's:mv-dst', 'nope')).toBe(0);
    expect(await t.call('SMOVE', 's:mv-missing', 's:mv-dst', 'one')).toBe(0);
    expect(await t.call('SMOVE', 's:mv-src', 's:mv-src', 'one')).toBe(1);
    expect(await t.call('SMOVE', 's:mv-src', 's:mv-src', 'nope')).toBe(0);
    // member already in destination: still moved (removed from source), returns 1
    await t.call('SADD', 's:mv-src', 'three');
    expect(await t.call('SMOVE', 's:mv-src', 's:mv-dst', 'three')).toBe(1);
    expect(await t.call('SISMEMBER', 's:mv-src', 'three')).toBe(0);
    expect(await t.call('SMOVE', 's:mv-src', 's:mv-new', 'one')).toBe(1);
    expect(await t.call('EXISTS', 's:mv-src')).toBe(0);
    expect(await t.call('SMEMBERS', 's:mv-new')).toEqual(['one']);
    await t.call('SET', 's:mv-str', 'x');
    await expect(t.call('SMOVE', 's:mv-dst', 's:mv-str', 'two')).rejects.toThrow(WRONGTYPE);
    expect(await t.call('SISMEMBER', 's:mv-dst', 'two')).toBe(1);
    await expect(t.call('SMOVE', 's:mv-dst', 's:mv-new')).rejects.toThrow(arity('smove'));
  });

  it('SINTER / SUNION / SDIFF and their STORE variants', async () => {
    await t.call('SADD', 's:op1', 'a', 'b', 'c', 'd');
    await t.call('SADD', 's:op2', 'c');
    await t.call('SADD', 's:op3', 'a', 'c', 'e');
    expect(sorted(await t.call('SDIFF', 's:op1', 's:op2', 's:op3'))).toEqual(['b', 'd']);
    expect(sorted(await t.call('SINTER', 's:op1', 's:op2', 's:op3'))).toEqual(['c']);
    expect(sorted(await t.call('SUNION', 's:op1', 's:op2', 's:op3'))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(sorted(await t.call('SDIFF', 's:op1'))).toEqual(['a', 'b', 'c', 'd']);
    expect(await t.call('SINTER', 's:op1', 's:op-missing')).toEqual([]);
    expect(sorted(await t.call('SUNION', 's:op2', 's:op-missing'))).toEqual(['c']);
    expect(await t.call('SDIFF', 's:op-missing', 's:op1')).toEqual([]);
    expect(await t.call('SDIFFSTORE', 's:op-d', 's:op1', 's:op2', 's:op3')).toBe(2);
    expect(sorted(await t.call('SMEMBERS', 's:op-d'))).toEqual(['b', 'd']);
    expect(await t.call('SINTERSTORE', 's:op-i', 's:op1', 's:op3')).toBe(2);
    expect(sorted(await t.call('SMEMBERS', 's:op-i'))).toEqual(['a', 'c']);
    expect(await t.call('SUNIONSTORE', 's:op-u', 's:op2', 's:op3')).toBe(3);
    expect(sorted(await t.call('SMEMBERS', 's:op-u'))).toEqual(['a', 'c', 'e']);
    // empty result deletes the destination, even if it held another type
    await t.call('SET', 's:op-str', 'x');
    expect(await t.call('SINTERSTORE', 's:op-str', 's:op1', 's:op-missing')).toBe(0);
    expect(await t.call('EXISTS', 's:op-str')).toBe(0);
    await t.call('SET', 's:op-str2', 'x');
    expect(await t.call('SUNIONSTORE', 's:op-str2', 's:op2')).toBe(1);
    expect(await t.call('TYPE', 's:op-str2')).toBe('set');
    // destination may be one of the sources
    expect(await t.call('SUNIONSTORE', 's:op-u', 's:op-u', 's:op1')).toBe(5);
    await t.call('SET', 's:op-wt', 'x');
    await expect(t.call('SINTER', 's:op1', 's:op-wt')).rejects.toThrow(WRONGTYPE);
    await expect(t.call('SUNION', 's:op1', 's:op-wt')).rejects.toThrow(WRONGTYPE);
    await expect(t.call('SDIFF', 's:op1', 's:op-wt')).rejects.toThrow(WRONGTYPE);
    await expect(t.call('SINTERSTORE', 'x', 's:op1', 's:op-wt')).rejects.toThrow(WRONGTYPE);
    await expect(t.call('SINTER')).rejects.toThrow(arity('sinter'));
    await expect(t.call('SUNION')).rejects.toThrow(arity('sunion'));
    await expect(t.call('SDIFF')).rejects.toThrow(arity('sdiff'));
    await expect(t.call('SINTERSTORE', 'x')).rejects.toThrow(arity('sinterstore'));
    await expect(t.call('SUNIONSTORE', 'x')).rejects.toThrow(arity('sunionstore'));
    await expect(t.call('SDIFFSTORE', 'x')).rejects.toThrow(arity('sdiffstore'));
  });

  it('SINTERCARD with LIMIT (docs example) and errors', async () => {
    await t.call('SADD', 's:ic1', 'a', 'b', 'c', 'd');
    await t.call('SADD', 's:ic2', 'c', 'd', 'e');
    expect(await t.call('SINTERCARD', 2, 's:ic1', 's:ic2')).toBe(2);
    expect(await t.call('SINTERCARD', 2, 's:ic1', 's:ic2', 'LIMIT', 1)).toBe(1);
    expect(await t.call('SINTERCARD', 2, 's:ic1', 's:ic2', 'LIMIT', 0)).toBe(2);
    expect(await t.call('SINTERCARD', 1, 's:ic1')).toBe(4);
    expect(await t.call('SINTERCARD', 2, 's:ic1', 's:ic-missing')).toBe(0);
    await expect(t.call('SINTERCARD', 0, 's:ic1')).rejects.toThrow('ERR numkeys should be greater than 0');
    await expect(t.call('SINTERCARD', 3, 's:ic1', 's:ic2')).rejects.toThrow("ERR Number of keys can't be greater than number of args");
    await expect(t.call('SINTERCARD', 1)).rejects.toThrow(arity('sintercard'));
    await t.call('SET', 's:ic-str', 'x');
    await expect(t.call('SINTERCARD', 2, 's:ic1', 's:ic-str')).rejects.toThrow(WRONGTYPE);
    // non-integer numkeys reuses the custom numkeys message (getRangeLongFromObjectOrReply)
    await expect(t.call('SINTERCARD', 'x', 's:ic1')).rejects.toThrow('ERR numkeys should be greater than 0');
  });

  it('SINTERCARD unknown trailing option is a syntax error', async () => {
    await t.call('SADD', 's:ic-syn', 'a');
    await expect(t.call('SINTERCARD', 1, 's:ic-syn', 'FOO')).rejects.toThrow(SYNTAX);
    await expect(t.call('SINTERCARD', 1, 's:ic-syn', 'LIMIT')).rejects.toThrow(SYNTAX);
  });

  it('SINTERCARD negative LIMIT', async () => {
    await expect(t.call('SINTERCARD', 2, 's:ic1', 's:ic2', 'LIMIT', -1)).rejects.toThrow("ERR LIMIT can't be negative");
    await expect(t.call('SINTERCARD', 1, 's:ic1', 'LIMIT', 'x')).rejects.toThrow("ERR LIMIT can't be negative");
  });

  it('SSCAN', async () => {
    await t.call('SADD', 's:scan', 'a', 'b', 'c');
    const [cur, items] = (await t.call('SSCAN', 's:scan', 0)) as [string, string[]];
    expect(cur).toBe('0');
    expect([...items].sort()).toEqual(['a', 'b', 'c']);
    expect(await t.call('SSCAN', 's:scan', 0, 'MATCH', 'b')).toEqual(['0', ['b']]);
    expect(await t.call('SSCAN', 's:scan-missing', 0)).toEqual(['0', []]);
    const members: string[] = [];
    for (let i = 0; i < 300; i++) members.push(`m${i}`);
    await t.call('SADD', 's:scan-big', ...members);
    const seen = new Set<string>();
    let cursor = '0';
    let calls = 0;
    do {
      const [next, batch] = (await t.call('SSCAN', 's:scan-big', cursor, 'COUNT', 20)) as [string, string[]];
      for (const m of batch) seen.add(m);
      cursor = next;
      calls++;
    } while (cursor !== '0');
    expect(calls).toBeGreaterThan(1);
    expect(seen.size).toBe(300);
    await expect(t.call('SSCAN', 's:scan', 'abc')).rejects.toThrow('ERR invalid cursor');
    await expect(t.call('SSCAN', 's:scan', 0, 'COUNT', 0)).rejects.toThrow(SYNTAX);
    await expect(t.call('SSCAN', 's:scan', 0, 'FOO')).rejects.toThrow(SYNTAX);
    await expect(t.call('SSCAN', 's:scan')).rejects.toThrow(arity('sscan'));
  });

  it('WRONGTYPE for every set command', async () => {
    await expectWrongType('s:wt', [
      ['SADD', 's:wt', 'a'],
      ['SREM', 's:wt', 'a'],
      ['SMEMBERS', 's:wt'],
      ['SISMEMBER', 's:wt', 'a'],
      ['SMISMEMBER', 's:wt', 'a'],
      ['SCARD', 's:wt'],
      ['SPOP', 's:wt'],
      ['SPOP', 's:wt', 2],
      ['SRANDMEMBER', 's:wt'],
      ['SRANDMEMBER', 's:wt', 2],
      ['SMOVE', 's:wt', 's:wt-d', 'a'],
      ['SINTER', 's:wt'],
      ['SUNION', 's:wt'],
      ['SDIFF', 's:wt'],
      ['SINTERCARD', 1, 's:wt'],
      ['SSCAN', 's:wt', 0],
    ]);
  });

  it('RESP3: SMEMBERS / SINTER / SUNION / SDIFF / SPOP count are sets', async () => {
    await t.call('SADD', 's:r3', 3, 1, 2);
    await t.call('SADD', 's:r3one', 'm');
    await t.call('SADD', 's:r3b', 2);
    const r = await resp3();
    expect(await r.send('SMEMBERS', 's:r3one')).toBe('~1\r\n$1\r\nm\r\n');
    expect(await r.send('SMEMBERS', 's:r3-missing')).toBe('~0\r\n');
    expect(await r.send('SINTER', 's:r3', 's:r3b')).toBe('~1\r\n$1\r\n2\r\n');
    expect(await r.send('SINTER', 's:r3', 's:r3-missing')).toBe('~0\r\n');
    expect(await r.send('SUNION', 's:r3b')).toBe('~1\r\n$1\r\n2\r\n');
    expect(await r.send('SDIFF', 's:r3b', 's:r3')).toBe('~0\r\n');
    expect(await r.send('SMISMEMBER', 's:r3', '1', '9')).toBe('*2\r\n:1\r\n:0\r\n');
    expect(await r.send('SPOP', 's:r3-missing', '2')).toBe('~0\r\n');
    expect(await r.send('SPOP', 's:r3b', '5')).toBe('~1\r\n$1\r\n2\r\n');
    expect(await r.send('SPOP', 's:r3-missing')).toBe('_\r\n');
    expect(await r.send('SRANDMEMBER', 's:r3-missing')).toBe('_\r\n');
    expect(await r.send('SRANDMEMBER', 's:r3', '-2')).toMatch(/^\*2\r\n/);
    const r2 = await t.raw();
    expect(await r2.send('SMEMBERS', 's:r3one')).toBe('*1\r\n$1\r\nm\r\n');
    expect(await r2.send('SPOP', 's:r3-missing', '2')).toBe('*0\r\n');
  });
});

describe('sets: encodings', () => {
  it('intset → listpack → hashtable', async () => {
    await t.call('SADD', 's:enc1', 1, 2, 3);
    expect(await enc('s:enc1')).toBe('intset');
    await t.call('SADD', 's:enc1', 'a');
    expect(await enc('s:enc1')).toBe('listpack');
    const many: string[] = [];
    for (let i = 0; i < 124; i++) many.push(`m${i}`);
    await t.call('SADD', 's:enc1', ...many);
    expect(await t.call('SCARD', 's:enc1')).toBe(128);
    expect(await enc('s:enc1')).toBe('listpack');
    await t.call('SADD', 's:enc1', 'one-more');
    expect(await enc('s:enc1')).toBe('hashtable');
    await t.call('SREM', 's:enc1', ...many);
    expect(await enc('s:enc1')).toBe('hashtable');
  });

  it('intset limit 512 and long members', async () => {
    const ints: number[] = [];
    for (let i = 0; i < 512; i++) ints.push(i);
    await t.call('SADD', 's:enc2', ...ints);
    expect(await enc('s:enc2')).toBe('intset');
    await t.call('SADD', 's:enc2', 512);
    expect(await enc('s:enc2')).toBe('hashtable');
    // more than 128 ints + a string goes straight to hashtable
    const ints2: number[] = [];
    for (let i = 0; i < 200; i++) ints2.push(i);
    await t.call('SADD', 's:enc3', ...ints2);
    expect(await enc('s:enc3')).toBe('intset');
    await t.call('SADD', 's:enc3', 'x');
    expect(await enc('s:enc3')).toBe('hashtable');
    await t.call('SADD', 's:enc4', 'x'.repeat(64));
    expect(await enc('s:enc4')).toBe('listpack');
    await t.call('SADD', 's:enc4', 'y'.repeat(65));
    expect(await enc('s:enc4')).toBe('hashtable');
  });

  it('intset members come back sorted (SMEMBERS / SSCAN / RESP3)', async () => {
    await t.call('SADD', 's:scan-int', 3, 1, 2);
    expect(await enc('s:scan-int')).toBe('intset');
    expect(await t.call('SMEMBERS', 's:scan-int')).toEqual(['1', '2', '3']);
    expect(await t.call('SSCAN', 's:scan-int', 0, 'COUNT', 1)).toEqual(['0', ['1', '2', '3']]);
    const r = await resp3();
    expect(await r.send('SMEMBERS', 's:scan-int')).toBe('~3\r\n$1\r\n1\r\n$1\r\n2\r\n$1\r\n3\r\n');
  });
});
