import { describe, expect, it } from 'vitest';

import { arity, err, NOT_INT, useServer, WRONGTYPE } from '@/tests/helpers';

/**
 * APPEND, STRLEN, GETRANGE, SUBSTR, SETRANGE (strings.range.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

// ============================================================================
// APPEND / STRLEN / GETRANGE / SETRANGE / LCS
// ============================================================================

describe('APPEND / STRLEN', () => {
  it('APPEND docs example', async () => {
    expect(await t.call('EXISTS', 'ap:k')).toBe(0);
    expect(await t.call('APPEND', 'ap:k', 'Hello')).toBe(5);
    expect(await t.call('APPEND', 'ap:k', ' World')).toBe(11);
    expect(await t.call('GET', 'ap:k')).toBe('Hello World');
  });

  it('APPEND to an integer-encoded value', async () => {
    await t.call('SET', 'ap:i', '12');
    expect(await t.call('APPEND', 'ap:i', '34')).toBe(4);
    expect(await t.call('GET', 'ap:i')).toBe('1234');
  });

  it('APPEND keeps the TTL', async () => {
    await t.call('SET', 'ap:t', 'a', 'EX', 100);
    await t.call('APPEND', 'ap:t', 'b');
    expect(await t.call('TTL', 'ap:t')).toBeGreaterThan(95);
  });

  it('STRLEN', async () => {
    await t.call('SET', 'sl:k', 'Hello world');
    expect(await t.call('STRLEN', 'sl:k')).toBe(11);
    expect(await t.call('STRLEN', 'sl:nonexisting')).toBe(0);
    await t.call('SET', 'sl:i', '-12345');
    expect(await t.call('STRLEN', 'sl:i')).toBe(6);
    await t.call('SET', 'sl:u', Buffer.from('héllo', 'utf8'));
    expect(await t.call('STRLEN', 'sl:u')).toBe(6);
  });

  it('wrong type and arity', async () => {
    await t.call('RPUSH', 'ap:l', 'x');
    expect(await err(t.call('APPEND', 'ap:l', 'v'))).toBe(WRONGTYPE);
    expect(await err(t.call('STRLEN', 'ap:l'))).toBe(WRONGTYPE);
    expect(await err(t.call('APPEND', 'ap:l'))).toBe(arity('append'));
    expect(await err(t.call('STRLEN'))).toBe(arity('strlen'));
  });
});

describe('GETRANGE / SUBSTR', () => {
  it('docs examples', async () => {
    await t.call('SET', 'gr:k', 'This is a string');
    expect(await t.call('GETRANGE', 'gr:k', 0, 3)).toBe('This');
    expect(await t.call('GETRANGE', 'gr:k', -3, -1)).toBe('ing');
    expect(await t.call('GETRANGE', 'gr:k', 0, -1)).toBe('This is a string');
    expect(await t.call('GETRANGE', 'gr:k', 10, 100)).toBe('string');
  });

  it('edge cases', async () => {
    await t.call('SET', 'gr:e', 'Hello');
    expect(await t.call('GETRANGE', 'gr:e', 3, 1)).toBe('');
    expect(await t.call('GETRANGE', 'gr:e', 10, 20)).toBe('');
    expect(await t.call('GETRANGE', 'gr:e', -100, 1)).toBe('He');
    expect(await t.call('GETRANGE', 'gr:e', -1, -5)).toBe('');
    expect(await t.call('GETRANGE', 'gr:e', 4, 4)).toBe('o');
    expect(await t.call('GETRANGE', 'gr:missing', 0, -1)).toBe('');
    await t.call('SET', 'gr:int', '12345');
    expect(await t.call('GETRANGE', 'gr:int', 1, 2)).toBe('23');
  });

  it('SUBSTR is an alias', async () => {
    await t.call('SET', 'gr:sub', 'This is a string');
    expect(await t.call('SUBSTR', 'gr:sub', 0, 3)).toBe('This');
    expect(await t.call('SUBSTR', 'gr:sub', -3, -1)).toBe('ing');
  });

  it('errors', async () => {
    await t.call('SET', 'gr:x', 'v');
    expect(await err(t.call('GETRANGE', 'gr:x', 'a', 1))).toBe(NOT_INT);
    expect(await err(t.call('GETRANGE', 'gr:x', 0))).toBe(arity('getrange'));
    expect(await err(t.call('SUBSTR', 'gr:x', 0))).toBe(arity('substr'));
    await t.call('RPUSH', 'gr:l', 'x');
    expect(await err(t.call('GETRANGE', 'gr:l', 0, 1))).toBe(WRONGTYPE);
  });
});

describe('SETRANGE', () => {
  it('docs examples', async () => {
    await t.call('SET', 'sr:k1', 'Hello World');
    expect(await t.call('SETRANGE', 'sr:k1', 6, 'Redis')).toBe(11);
    expect(await t.call('GET', 'sr:k1')).toBe('Hello Redis');
    expect(await t.call('SETRANGE', 'sr:k2', 6, 'Redis')).toBe(11);
    expect(await t.redis.getBuffer('sr:k2')).toEqual(Buffer.concat([Buffer.alloc(6), Buffer.from('Redis')]));
  });

  it('pads an existing value with zero bytes', async () => {
    await t.call('SET', 'sr:p', 'ab');
    expect(await t.call('SETRANGE', 'sr:p', 4, 'z')).toBe(5);
    expect(await t.redis.getBuffer('sr:p')).toEqual(Buffer.from([0x61, 0x62, 0, 0, 0x7a]));
  });

  it('empty value', async () => {
    expect(await t.call('SETRANGE', 'sr:empty', 10, '')).toBe(0);
    expect(await t.call('EXISTS', 'sr:empty')).toBe(0);
    await t.call('SET', 'sr:e2', 'abc');
    expect(await t.call('SETRANGE', 'sr:e2', 10, '')).toBe(3);
    expect(await t.call('GET', 'sr:e2')).toBe('abc');
  });

  it('on an integer-encoded value', async () => {
    await t.call('SET', 'sr:i', '1234');
    expect(await t.call('SETRANGE', 'sr:i', 1, 'x')).toBe(4);
    expect(await t.call('GET', 'sr:i')).toBe('1x34');
  });

  it('errors', async () => {
    expect(await err(t.call('SETRANGE', 'sr:e', -1, 'x'))).toBe('ERR offset is out of range');
    expect(await err(t.call('SETRANGE', 'sr:e', 'a', 'x'))).toBe(NOT_INT);
    expect(await err(t.call('SETRANGE', 'sr:e', 536870912, 'x'))).toBe('ERR string exceeds maximum allowed size (proto-max-bulk-len)');
    expect(await t.call('EXISTS', 'sr:e')).toBe(0);
    await t.call('RPUSH', 'sr:l', 'x');
    expect(await err(t.call('SETRANGE', 'sr:l', 0, 'x'))).toBe(WRONGTYPE);
    expect(await err(t.call('SETRANGE', 'sr:l', 0))).toBe(arity('setrange'));
  });
});
