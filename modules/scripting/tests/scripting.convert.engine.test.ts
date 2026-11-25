import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

/** Conversions between Lua values and Redis replies (RESP2 and RESP3). */

const t = useServer();

/** Error message of a rejected promise (fails the test if it resolves). */
async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected the command to fail');
}

const evalLua = (script: string, ...rest: Array<string | number | Buffer>) => t.call('EVAL', script, ...(rest.length ? rest : [0]));

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------
describe('Lua -> Redis conversion', () => {
  it('numbers: integers and float truncation', async () => {
    expect(await evalLua('return 10')).toBe(10);
    expect(await evalLua('return 3.99')).toBe(3);
    expect(await evalLua('return -3.99')).toBe(-3);
    expect(await evalLua('return 0.5')).toBe(0);
    expect(await evalLua('return {1, 2.7, 3}')).toEqual([1, 2, 3]);
  });

  it('strings, booleans and nil', async () => {
    expect(await evalLua("return 'hello'")).toBe('hello');
    expect(await evalLua('return true')).toBe(1);
    expect(await evalLua('return false')).toBeNull();
    expect(await evalLua('return nil')).toBeNull();
    expect(await evalLua('return')).toBeNull();
  });

  it('RESP2 wire encodings for true/false/nil/status', async () => {
    const r = await t.raw();
    expect(await r.send('EVAL', 'return true', '0')).toBe(':1\r\n');
    expect(await r.send('EVAL', 'return false', '0')).toBe('$-1\r\n');
    expect(await r.send('EVAL', 'return nil', '0')).toBe('$-1\r\n');
    expect(await r.send('EVAL', "return {ok='fine'}", '0')).toBe('+fine\r\n');
    expect(await r.send('EVAL', "return {err='My Error'}", '0')).toBe('-My Error\r\n');
    expect(await r.send('EVAL', 'return 3.99', '0')).toBe(':3\r\n');
    expect(await r.send('EVAL', "return {1,'a',{2}}", '0')).toBe('*3\r\n:1\r\n$1\r\na\r\n*1\r\n:2\r\n');
  });

  it('nested tables', async () => {
    expect(await evalLua("return {1, {2, {3, 'x'}}, 'y'}")).toEqual([1, [2, [3, 'x']], 'y']);
    expect(await evalLua('return {}')).toEqual([]);
  });

  it('table conversion stops at the first nil', async () => {
    expect(await evalLua("return {1,2,3,'foo',nil,'bar'}")).toEqual([1, 2, 3, 'foo']);
    expect(await evalLua('return {nil, 1}')).toEqual([]);
  });

  it('{ok=...} status and redis.status_reply', async () => {
    expect(await evalLua("return {ok='fine'}")).toBe('fine');
    expect(await evalLua("return redis.status_reply('TOCK')")).toBe('TOCK');
  });

  it('{err=...} error and redis.error_reply', async () => {
    expect(await errorOf(evalLua("return {err='My Error'}"))).toBe('My Error');
    expect(await errorOf(evalLua("return redis.error_reply('My Error')"))).toBe('My Error');
    expect(await errorOf(evalLua("return redis.error_reply('MYCODE custom failure')"))).toBe('MYCODE custom failure');
  });

  it('error_reply / status_reply build tables', async () => {
    expect(await evalLua("local t = redis.error_reply('x'); return {type(t), t.err}")).toEqual(['table', 'x']);
    expect(await evalLua("local t = redis.status_reply('y'); return {type(t), t.ok}")).toEqual(['table', 'y']);
  });
});

describe('Redis -> Lua conversion', () => {
  it('integer reply becomes a number', async () => {
    await t.call('DEL', 'rl:int');
    expect(await t.call('EVAL', "local v = redis.call('INCR', KEYS[1]); return {type(v), v}", 1, 'rl:int')).toEqual(['number', 1]);
  });

  it('bulk reply becomes a string', async () => {
    await t.call('SET', 'rl:bulk', '123');
    expect(await t.call('EVAL', "local v = redis.call('GET', KEYS[1]); return type(v)", 1, 'rl:bulk')).toBe('string');
  });

  it('nil bulk becomes false', async () => {
    expect(await t.call('EVAL', "local v = redis.call('GET', KEYS[1]); return {type(v), tostring(v)}", 1, 'rl:missing')).toEqual(['boolean', 'false']);
    expect(await t.call('EVAL', "return redis.call('GET', KEYS[1]) == false", 1, 'rl:missing')).toBe(1);
  });

  it('array reply becomes a table (and round-trips)', async () => {
    await t.call('DEL', 'rl:list');
    await t.call('RPUSH', 'rl:list', 'a', 'b', 'c');
    expect(await t.call('EVAL', "local v = redis.call('LRANGE', KEYS[1], 0, -1); return {type(v), #v, v[2]}", 1, 'rl:list')).toEqual(['table', 3, 'b']);
    expect(await t.call('EVAL', "return redis.call('LRANGE', KEYS[1], 0, -1)", 1, 'rl:list')).toEqual(['a', 'b', 'c']);
  });

  it('HGETALL inside a script (RESP2 default) is a flat table', async () => {
    await t.call('DEL', 'rl:h');
    await t.call('HSET', 'rl:h', 'f', 'v');
    expect(await t.call('EVAL', "return redis.call('HGETALL', KEYS[1])", 1, 'rl:h')).toEqual(['f', 'v']);
  });

  it('status reply becomes {ok=...}', async () => {
    expect(await t.call('EVAL', "local r = redis.call('SET', KEYS[1], 'x'); return {type(r), r.ok}", 1, 'rl:status')).toEqual(['table', 'OK']);
    expect(await t.call('EVAL', "return redis.call('PING')", 0)).toBe('PONG');
  });

  it('error via redis.pcall becomes {err=...}', async () => {
    await t.call('SET', 'rl:str', 'notanumber');
    expect(await t.call('EVAL', "local r = redis.pcall('INCR', KEYS[1]); return {type(r), r.err}", 1, 'rl:str')).toEqual(['table', 'ERR value is not an integer or out of range']);
  });

  it('returning the pcall error table replies with that error', async () => {
    await t.call('SET', 'rl:str2', 'notanumber');
    expect(await errorOf(t.call('EVAL', "return redis.pcall('INCR', KEYS[1])", 1, 'rl:str2'))).toBe('ERR value is not an integer or out of range');
  });

  it('Lua numbers passed to redis.call are converted to strings', async () => {
    await t.call('EVAL', "redis.call('SET', KEYS[1], 10); redis.call('SET', KEYS[2], 1.5); redis.call('SET', KEYS[3], 1700000000000)", 3, 'rl:n1', 'rl:n2', 'rl:n3');
    expect(await t.call('MGET', 'rl:n1', 'rl:n2', 'rl:n3')).toEqual(['10', '1.5', '1700000000000']);
  });
});
describe('scripts and RESP3', () => {
  it('default script resp is 2: HGETALL inside script comes back as a flat array on RESP3', async () => {
    await t.call('DEL', 'r3s:h');
    await t.call('HSET', 'r3s:h', 'a', '1');
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect(await r.send('EVAL', "return redis.call('HGETALL', KEYS[1])", '1', 'r3s:h')).toBe('*2\r\n$1\r\na\r\n$1\r\n1\r\n');
    expect(await r.send('EVAL', 'return false', '0')).toBe('_\r\n');
    expect(await r.send('EVAL', 'return true', '0')).toBe(':1\r\n');
  });

  it('redis.setresp(3) returns maps, booleans and doubles', async () => {
    await t.call('DEL', 'r3s:h2', 'r3s:z');
    await t.call('HSET', 'r3s:h2', 'a', '1');
    await t.call('ZADD', 'r3s:z', '1.5', 'm');
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect(await r.send('EVAL', "redis.setresp(3); return redis.call('HGETALL', KEYS[1])", '1', 'r3s:h2')).toBe('%1\r\n$1\r\na\r\n$1\r\n1\r\n');
    expect(await r.send('EVAL', 'redis.setresp(3); return true', '0')).toBe('#t\r\n');
    expect(await r.send('EVAL', 'redis.setresp(3); return false', '0')).toBe('#f\r\n');
    expect(await r.send('EVAL', "redis.setresp(3); return redis.call('ZSCORE', KEYS[1], 'm')", '1', 'r3s:z')).toBe(',1.5\r\n');
    // RESP2 client: map flattened, booleans as integers, double as bulk
    const r2 = await t.raw();
    expect(await r2.send('EVAL', "redis.setresp(3); return redis.call('HGETALL', KEYS[1])", '1', 'r3s:h2')).toBe('*2\r\n$1\r\na\r\n$1\r\n1\r\n');
    expect(await r2.send('EVAL', 'redis.setresp(3); return false', '0')).toBe(':0\r\n');
    expect(await r2.send('EVAL', "redis.setresp(3); return redis.call('ZSCORE', KEYS[1], 'm')", '1', 'r3s:z')).toBe('$3\r\n1.5\r\n');
  });

  it('redis.setresp with an invalid version', async () => {
    const msg = await errorOf(evalLua('redis.setresp(4)'));
    // unverified: exact text "RESP version must be 2 or 3."
    expect(msg).toMatch(/RESP version must be 2 or 3/);
  });
});
