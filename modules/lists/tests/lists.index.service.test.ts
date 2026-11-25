import { describe, expect, it } from 'vitest';

import { arity, NOT_INT, SYNTAX, useServer } from '@/tests/helpers';

/**
 * LLEN, LRANGE, LINDEX, LSET, LREM, LTRIM, LINSERT, LPOS (lists.index.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

describe('lists: index reads and writes', () => {
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
