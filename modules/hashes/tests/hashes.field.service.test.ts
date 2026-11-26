import { describe, expect, it } from 'vitest';

import { arity, NOT_INT, useServer, WRONGTYPE } from '@/tests/helpers';

/**
 * HSET, HMSET, HSETNX, HGET, HMGET, HGETALL, HDEL, HEXISTS, HLEN, HKEYS, HVALS, HSTRLEN, HINCRBY* and the hash encodings (hashes.field.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

const enc = (key: string) => t.call('OBJECT', 'ENCODING', key);

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

/** Asserts that every command rejects with WRONGTYPE against a string key. */
async function expectWrongType(key: string, cmds: Array<Array<string | number>>) {
  await t.call('SET', key, 'str');
  for (const c of cmds) {
    await expect(t.call(...c), c.join(' ')).rejects.toThrow(WRONGTYPE);
  }
}

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
    await expect(t.call('HINCRBYFLOAT', 'h:incrf', 'field', 'inf')).rejects.toThrow('ERR value is NaN or Infinity');
    await t.call('HSET', 'h:incrf', 'big', '1e4932');
    await expect(t.call('HINCRBYFLOAT', 'h:incrf', 'big', '1e4932')).rejects.toThrow('ERR increment would produce NaN or Infinity');
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

describe('hashes: encodings', () => {
  it('listpack → hashtable by entries and by value size; listpackex with TTLs', async () => {
    await t.call('HSET', 'h:enc1', 'a', '1');
    expect(await enc('h:enc1')).toBe('listpack');
    await t.call('HSET', 'h:enc1', ...Array.from({ length: 511 }, (_, i) => [`f${i}`, 'v']).flat());
    expect(await t.call('HLEN', 'h:enc1')).toBe(512);
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
