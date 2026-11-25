import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

/**
 * Sets. Expected values come from the redis.io command docs / Redis source
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
