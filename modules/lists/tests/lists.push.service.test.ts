import { describe, expect, it } from 'vitest';

import { arity, SYNTAX, useServer } from '@/tests/helpers';

/**
 * LPUSH, RPUSH, LPUSHX, RPUSHX, LPOP, RPOP, LMPOP and the list encodings (lists.push.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

const enc = (key: string) => t.call('OBJECT', 'ENCODING', key);

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

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
});

describe('lists: multi-pop', () => {
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
