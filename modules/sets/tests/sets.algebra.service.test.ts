import { describe, expect, it } from 'vitest';

import { arity, SYNTAX, useServer, WRONGTYPE } from '@/tests/helpers';

/**
 * SUNION, SINTER, SDIFF, their STORE forms, SINTERCARD (sets.algebra.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

const sorted = (v: unknown) => [...(v as string[])].sort();

describe('sets: algebra', () => {
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
});
