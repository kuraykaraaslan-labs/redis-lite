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

  it('DIFF / DIFF1 / ANDOR / ONE (Redis 8.2+)', async () => {
    await t.call('SET', 'bo:x', Buffer.from([0b11110000]));
    await t.call('SET', 'bo:y', Buffer.from([0b10100000]));
    await t.call('SET', 'bo:z', Buffer.from([0b01000001]));
    expect(await t.call('BITOP', 'DIFF', 'bo:r1', 'bo:x', 'bo:y', 'bo:z')).toBe(1);
    expect(await t.redis.getBuffer('bo:r1')).toEqual(Buffer.from([0b00010000]));
    expect(await t.call('BITOP', 'DIFF1', 'bo:r2', 'bo:x', 'bo:y', 'bo:z')).toBe(1);
    expect(await t.redis.getBuffer('bo:r2')).toEqual(Buffer.from([0b00000001]));
    expect(await t.call('BITOP', 'ANDOR', 'bo:r3', 'bo:x', 'bo:y', 'bo:z')).toBe(1);
    expect(await t.redis.getBuffer('bo:r3')).toEqual(Buffer.from([0b11100000]));
    expect(await t.call('BITOP', 'ONE', 'bo:r4', 'bo:x', 'bo:y', 'bo:z')).toBe(1);
    expect(await t.redis.getBuffer('bo:r4')).toEqual(Buffer.from([0b00010001]));
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
    expect(await err(t.call('BITOP', 'AND', 'bo:d'))).toBe(arity('bitop'));
  });
});
