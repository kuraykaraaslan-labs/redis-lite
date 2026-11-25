import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';

/**
 * Hashes. Expected values come from the redis.io command docs / Redis source
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
