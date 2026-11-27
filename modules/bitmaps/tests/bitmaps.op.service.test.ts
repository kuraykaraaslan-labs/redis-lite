import { describe, expect, it } from 'vitest';

import { arity, err, SYNTAX, useServer, WRONGTYPE } from '@/tests/helpers';

/**
 * BITOP (bitmaps.op.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

describe('BITOP', () => {
  it('AND docs example', async () => {
    await t.call('SET', 'bo:k1', 'foobar');
    await t.call('SET', 'bo:k2', 'abcdef');
    expect(await t.call('BITOP', 'AND', 'bo:dest', 'bo:k1', 'bo:k2')).toBe(6);
    expect(await t.call('GET', 'bo:dest')).toBe('`bc`ab');
  });

  it('OR / XOR pad shorter strings with zeros', async () => {
    await t.call('SET', 'bo:a', Buffer.from([0x01]));
    await t.call('SET', 'bo:b', Buffer.from([0x10, 0x02]));
    expect(await t.call('BITOP', 'OR', 'bo:or', 'bo:a', 'bo:b')).toBe(2);
    expect(await t.redis.getBuffer('bo:or')).toEqual(Buffer.from([0x11, 0x02]));
    expect(await t.call('BITOP', 'XOR', 'bo:xor', 'bo:a', 'bo:b', 'bo:b')).toBe(2);
    expect(await t.redis.getBuffer('bo:xor')).toEqual(Buffer.from([0x01, 0x00]));
    expect(await t.call('BITOP', 'AND', 'bo:and', 'bo:a', 'bo:b')).toBe(2);
    expect(await t.redis.getBuffer('bo:and')).toEqual(Buffer.from([0x00, 0x00]));
    expect(await t.call('BITOP', 'and', 'bo:and2', 'bo:a', 'bo:missing')).toBe(1);
    expect(await t.redis.getBuffer('bo:and2')).toEqual(Buffer.from([0x00]));
  });

  it('NOT', async () => {
    await t.call('SET', 'bo:n', Buffer.from([0xf0, 0x00]));
    expect(await t.call('BITOP', 'NOT', 'bo:nd', 'bo:n')).toBe(2);
    expect(await t.redis.getBuffer('bo:nd')).toEqual(Buffer.from([0x0f, 0xff]));
  });

  it('DIFF / DIFF1 / ANDOR / ONE are syntax errors (Redis 7.0)', async () => {
    await t.call('SET', 'bo:x', 'a');
    for (const op of ['DIFF', 'DIFF1', 'ANDOR', 'ONE']) expect(await err(t.call('BITOP', op, 'bo:r', 'bo:x', 'bo:x'))).toBe(SYNTAX);
  });

  it('all sources missing deletes the destination and returns 0', async () => {
    await t.call('SET', 'bo:old', 'x');
    expect(await t.call('BITOP', 'OR', 'bo:old', 'bo:m1', 'bo:m2')).toBe(0);
    expect(await t.call('EXISTS', 'bo:old')).toBe(0);
  });

  it('errors', async () => {
    await t.call('SET', 'bo:e1', 'a');
    await t.call('SET', 'bo:e2', 'b');
    await t.call('RPUSH', 'bo:l', 'x');
    expect(await err(t.call('BITOP', 'NOT', 'bo:d', 'bo:e1', 'bo:e2'))).toBe('ERR BITOP NOT must be called with a single source key.');
    expect(await err(t.call('BITOP', 'FOO', 'bo:d', 'bo:e1'))).toBe(SYNTAX);
    expect(await err(t.call('BITOP', 'AND', 'bo:d', 'bo:e1', 'bo:l'))).toBe(WRONGTYPE);
    // NOT's source count is checked before the sources are read
    expect(await err(t.call('BITOP', 'NOT', 'bo:d', 'bo:l', 'bo:l'))).toBe('ERR BITOP NOT must be called with a single source key.');
    expect(await err(t.call('BITOP', 'AND', 'bo:d'))).toBe(arity('bitop'));
  });
});
