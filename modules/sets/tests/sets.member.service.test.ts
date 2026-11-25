import { describe, expect, it } from 'vitest';

import { arity, useServer, WRONGTYPE } from '@/tests/helpers';

/**
 * SADD, SREM, SMEMBERS, SISMEMBER, SMISMEMBER, SCARD, SMOVE and the set encodings (sets.member.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

const enc = (key: string) => t.call('OBJECT', 'ENCODING', key);

const sorted = (v: unknown) => [...(v as string[])].sort();

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
