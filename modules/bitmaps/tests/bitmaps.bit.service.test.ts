import { describe, expect, it } from 'vitest';

import { arity, err, NOT_INT, SYNTAX, useServer, WRONGTYPE } from '@/tests/helpers';

/**
 * SETBIT, GETBIT, BITCOUNT, BITPOS (bitmaps.bit.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

describe('SETBIT / GETBIT', () => {
  it('docs examples', async () => {
    expect(await t.call('SETBIT', 'bit:k', 7, 1)).toBe(0);
    expect(await t.call('SETBIT', 'bit:k', 7, 0)).toBe(1);
    expect(await t.redis.getBuffer('bit:k')).toEqual(Buffer.from([0]));
    await t.call('SETBIT', 'bit:g', 7, 1);
    expect(await t.call('GETBIT', 'bit:g', 0)).toBe(0);
    expect(await t.call('GETBIT', 'bit:g', 7)).toBe(1);
    expect(await t.call('GETBIT', 'bit:g', 100)).toBe(0);
    expect(await t.call('GETBIT', 'bit:missing', 5)).toBe(0);
  });

  it('grows the string with zero bytes', async () => {
    expect(await t.call('SETBIT', 'bit:grow', 23, 1)).toBe(0);
    expect(await t.redis.getBuffer('bit:grow')).toEqual(Buffer.from([0, 0, 1]));
    await t.call('SET', 'bit:a', 'a');
    await t.call('SETBIT', 'bit:a', 6, 1);
    expect(await t.call('GET', 'bit:a')).toBe('c');
  });

  it('errors', async () => {
    expect(await err(t.call('SETBIT', 'bit:e', -1, 1))).toBe('ERR bit offset is not an integer or out of range');
    expect(await err(t.call('SETBIT', 'bit:e', 4294967296, 1))).toBe('ERR bit offset is not an integer or out of range');
    expect(await err(t.call('SETBIT', 'bit:e', 'a', 1))).toBe('ERR bit offset is not an integer or out of range');
    expect(await err(t.call('SETBIT', 'bit:e', 0, 2))).toBe('ERR bit is not an integer or out of range');
    expect(await err(t.call('SETBIT', 'bit:e', 0, 'x'))).toBe('ERR bit is not an integer or out of range');
    expect(await err(t.call('GETBIT', 'bit:e', -1))).toBe('ERR bit offset is not an integer or out of range');
    expect(await t.call('EXISTS', 'bit:e')).toBe(0);
    await t.call('RPUSH', 'bit:l', 'x');
    expect(await err(t.call('SETBIT', 'bit:l', 0, 1))).toBe(WRONGTYPE);
    expect(await err(t.call('GETBIT', 'bit:l', 0))).toBe(WRONGTYPE);
    expect(await err(t.call('SETBIT', 'bit:l', 0))).toBe(arity('setbit'));
    expect(await err(t.call('GETBIT', 'bit:l'))).toBe(arity('getbit'));
  });
});

describe('BITCOUNT', () => {
  it('docs examples', async () => {
    await t.call('SET', 'bc:k', 'foobar');
    expect(await t.call('BITCOUNT', 'bc:k')).toBe(26);
    expect(await t.call('BITCOUNT', 'bc:k', 0, 0)).toBe(4);
    expect(await t.call('BITCOUNT', 'bc:k', 1, 1)).toBe(6);
    expect(await t.call('BITCOUNT', 'bc:k', 1, 1, 'BYTE')).toBe(6);
    expect(await t.call('BITCOUNT', 'bc:k', 5, 30, 'BIT')).toBe(17);
  });

  it('negative ranges and edge cases', async () => {
    await t.call('SET', 'bc:n', 'foobar');
    expect(await t.call('BITCOUNT', 'bc:n', 0, -1)).toBe(26);
    expect(await t.call('BITCOUNT', 'bc:n', -1, -1)).toBe(4); // 'r' = 0x72
    expect(await t.call('BITCOUNT', 'bc:n', -100, 100)).toBe(26);
    expect(await t.call('BITCOUNT', 'bc:n', 3, 1)).toBe(0);
    expect(await t.call('BITCOUNT', 'bc:n', 0, -1, 'BIT')).toBe(26);
    expect(await t.call('BITCOUNT', 'bc:n', -8, -1, 'BIT')).toBe(4);
    expect(await t.call('BITCOUNT', 'bc:missing')).toBe(0);
    expect(await t.call('BITCOUNT', 'bc:missing', 0, 10)).toBe(0);
  });

  it('errors', async () => {
    await t.call('SET', 'bc:e', 'foobar');
    expect(await err(t.call('BITCOUNT', 'bc:e', 0))).toBe(SYNTAX);
    expect(await err(t.call('BITCOUNT', 'bc:e', 0, 1, 'FOO'))).toBe(SYNTAX);
    expect(await err(t.call('BITCOUNT', 'bc:e', 'a', 1))).toBe(NOT_INT);
    await t.call('RPUSH', 'bc:l', 'x');
    expect(await err(t.call('BITCOUNT', 'bc:l'))).toBe(WRONGTYPE);
    expect(await err(t.call('BITCOUNT'))).toBe(arity('bitcount'));
  });
});

describe('BITPOS', () => {
  it('docs examples', async () => {
    await t.call('SET', 'bp:k', Buffer.from([0xff, 0xf0, 0x00]));
    expect(await t.call('BITPOS', 'bp:k', 0)).toBe(12);
    await t.call('SET', 'bp:k', Buffer.from([0x00, 0xff, 0xf0]));
    expect(await t.call('BITPOS', 'bp:k', 1, 0)).toBe(8);
    expect(await t.call('BITPOS', 'bp:k', 1, 2)).toBe(16);
    expect(await t.call('BITPOS', 'bp:k', 1, 2, -1, 'BYTE')).toBe(16);
    expect(await t.call('BITPOS', 'bp:k', 1, 7, 15, 'BIT')).toBe(8);
    await t.call('SET', 'bp:k', Buffer.from([0x00, 0x00, 0x00]));
    expect(await t.call('BITPOS', 'bp:k', 1)).toBe(-1);
    expect(await t.call('BITPOS', 'bp:k', 1, 7, -3, 'BIT')).toBe(-1);
  });

  it('clear bit search past the end', async () => {
    await t.call('SET', 'bp:ones', Buffer.from([0xff, 0xff, 0xff]));
    expect(await t.call('BITPOS', 'bp:ones', 0)).toBe(24);
    expect(await t.call('BITPOS', 'bp:ones', 0, 0)).toBe(24);
    expect(await t.call('BITPOS', 'bp:ones', 0, 0, -1)).toBe(-1);
  });

  it('missing key', async () => {
    expect(await t.call('BITPOS', 'bp:missing', 0)).toBe(0);
    expect(await t.call('BITPOS', 'bp:missing', 1)).toBe(-1);
  });

  it('errors', async () => {
    await t.call('SET', 'bp:e', 'a');
    expect(await err(t.call('BITPOS', 'bp:e', 2))).toBe('ERR The bit argument must be 1 or 0.');
    expect(await err(t.call('BITPOS', 'bp:e', 1, 'a'))).toBe(NOT_INT);
    expect(await err(t.call('BITPOS', 'bp:e', 1, 0, 1, 'FOO'))).toBe(SYNTAX);
    await t.call('RPUSH', 'bp:l', 'x');
    expect(await err(t.call('BITPOS', 'bp:l', 1))).toBe(WRONGTYPE);
    expect(await err(t.call('BITPOS', 'bp:l'))).toBe(arity('bitpos'));
  });
});
