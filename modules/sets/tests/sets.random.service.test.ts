import { describe, expect, it } from 'vitest';

import { arity, NOT_INT, SYNTAX, useServer } from '@/tests/helpers';

/**
 * SPOP, SRANDMEMBER (sets.random.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

const sorted = (v: unknown) => [...(v as string[])].sort();

describe('sets: random members', () => {
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

  it('SRANDMEMBER count range', async () => {
    await t.call('SADD', 's:rand-range', 'a');
    await expect(t.call('SRANDMEMBER', 's:rand-range', '-9223372036854775808')).rejects.toThrow('ERR value is out of range, value must between -9223372036854775807 and 9223372036854775807');
    expect(await t.call('SRANDMEMBER', 's:rand-range', '9223372036854775807')).toEqual(['a']);
    // the count is parsed before the key is read
    await t.call('SET', 's:rand-str', 'x');
    await expect(t.call('SRANDMEMBER', 's:rand-str', 'x')).rejects.toThrow(NOT_INT);
    await expect(t.call('SPOP', 's:rand-str', 'x')).rejects.toThrow('ERR value is out of range, must be positive');
    expect(await t.call('SPOP', 's:rand-range', '9223372036854775807')).toEqual(['a']);
  });

  it('SPOP / SRANDMEMBER with extra args are a syntax error', async () => {
    await t.call('SADD', 's:pop-syn', 'a', 'b');
    await expect(t.call('SPOP', 's:pop-syn', 1, 2)).rejects.toThrow(SYNTAX);
    await expect(t.call('SRANDMEMBER', 's:pop-syn', 1, 2)).rejects.toThrow(SYNTAX);
    expect(await t.call('SCARD', 's:pop-syn')).toBe(2);
  });
});
