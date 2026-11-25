import { describe, expect, it } from 'vitest';

import { arity, err, NOT_INT, SYNTAX, useServer, WRONGTYPE } from '@/tests/helpers';

/**
 * BITFIELD / BITFIELD_RO (bitmaps.field.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

describe('BITFIELD / BITFIELD_RO', () => {
  it('docs examples', async () => {
    expect(await t.call('BITFIELD', 'bf:k', 'INCRBY', 'i5', 100, 1, 'GET', 'u4', 0)).toEqual([1, 0]);
    expect(await t.call('BITFIELD', 'bf:k2', 'SET', 'i8', '#0', 100, 'SET', 'i8', '#1', 200)).toEqual([0, 0]);
    expect(await t.call('BITFIELD', 'bf:k2', 'GET', 'i8', '#0', 'GET', 'u8', '#1', 'GET', 'i8', '#1')).toEqual([100, 200, -56]);
    expect(await t.call('GETRANGE', 'bf:k2', 0, 0)).toBe('d');
    expect(await t.call('BITFIELD', 'bf:k2', 'GET', 'u8', 8)).toEqual([200]);
  });

  it('OVERFLOW SAT / WRAP docs example', async () => {
    const step = () => t.call('BITFIELD', 'bf:ov', 'INCRBY', 'u2', 100, 1, 'OVERFLOW', 'SAT', 'INCRBY', 'u2', 102, 1);
    expect(await step()).toEqual([1, 1]);
    expect(await step()).toEqual([2, 2]);
    expect(await step()).toEqual([3, 3]);
    expect(await step()).toEqual([0, 3]);
  });

  it('OVERFLOW FAIL returns nil and leaves the value', async () => {
    await t.call('BITFIELD', 'bf:f', 'SET', 'u2', 0, 3);
    expect(await t.call('BITFIELD', 'bf:f', 'OVERFLOW', 'FAIL', 'INCRBY', 'u2', 0, 1)).toEqual([null]);
    expect(await t.call('BITFIELD', 'bf:f', 'GET', 'u2', 0)).toEqual([3]);
    expect(await t.call('BITFIELD', 'bf:f', 'OVERFLOW', 'FAIL', 'INCRBY', 'u2', 0, -1)).toEqual([2]);
    const r3 = await resp3();
    expect(await r3.send('BITFIELD', 'bf:f', 'OVERFLOW', 'FAIL', 'INCRBY', 'u2', '0', '5')).toBe('*1\r\n_\r\n');
    const r2 = await t.raw();
    expect(await r2.send('BITFIELD', 'bf:f', 'OVERFLOW', 'FAIL', 'INCRBY', 'u2', '0', '5')).toBe('*1\r\n$-1\r\n');
  });

  it('signed overflow WRAP and SAT', async () => {
    await t.call('BITFIELD', 'bf:s', 'SET', 'i8', 0, 127);
    expect(await t.call('BITFIELD', 'bf:s', 'INCRBY', 'i8', 0, 1)).toEqual([-128]);
    await t.call('BITFIELD', 'bf:s', 'SET', 'i8', 0, 127);
    expect(await t.call('BITFIELD', 'bf:s', 'OVERFLOW', 'SAT', 'INCRBY', 'i8', 0, 10)).toEqual([127]);
    expect(await t.call('BITFIELD', 'bf:s', 'OVERFLOW', 'SAT', 'INCRBY', 'i8', 0, -300)).toEqual([-128]);
    // SET with an out of range value wraps by default
    expect(await t.call('BITFIELD', 'bf:s2', 'SET', 'u8', 0, 257)).toEqual([0]);
    expect(await t.call('BITFIELD', 'bf:s2', 'GET', 'u8', 0)).toEqual([1]);
    expect(await t.call('BITFIELD', 'bf:s3', 'OVERFLOW', 'SAT', 'SET', 'u8', 0, 300)).toEqual([0]);
    expect(await t.call('BITFIELD', 'bf:s3', 'GET', 'u8', 0)).toEqual([255]);
  });

  it('i64 / u63 limits (exact on the wire)', async () => {
    const r = await t.raw();
    expect(await r.send('BITFIELD', 'bf:big', 'SET', 'i64', '0', '9223372036854775807')).toBe('*1\r\n:0\r\n');
    expect(await r.send('BITFIELD', 'bf:big', 'GET', 'i64', '0')).toBe('*1\r\n:9223372036854775807\r\n');
    expect(await r.send('BITFIELD', 'bf:big', 'INCRBY', 'i64', '0', '1')).toBe('*1\r\n:-9223372036854775808\r\n');
    expect(await r.send('BITFIELD', 'bf:big', 'OVERFLOW', 'SAT', 'INCRBY', 'i64', '0', '-1')).toBe('*1\r\n:-9223372036854775808\r\n');
    expect(await r.send('BITFIELD', 'bf:u63', 'SET', 'u63', '0', '9223372036854775807')).toBe('*1\r\n:0\r\n');
    expect(await r.send('BITFIELD', 'bf:u63', 'GET', 'u63', '0')).toBe('*1\r\n:9223372036854775807\r\n');
    expect(await r.send('BITFIELD', 'bf:u63', 'INCRBY', 'u63', '0', '1')).toBe('*1\r\n:0\r\n');
  });

  it('GET beyond the string is 0, no-op without subcommands', async () => {
    expect(await t.call('BITFIELD', 'bf:none', 'GET', 'u8', 1000)).toEqual([0]);
    expect(await t.call('EXISTS', 'bf:none')).toBe(0);
    expect(await t.call('BITFIELD', 'bf:none')).toEqual([]);
  });

  it('BITFIELD_RO', async () => {
    await t.call('SET', 'bf:ro', Buffer.from([0xff]));
    expect(await t.call('BITFIELD_RO', 'bf:ro', 'GET', 'u4', 0, 'GET', 'i8', 0)).toEqual([15, -1]);
    expect(await err(t.call('BITFIELD_RO', 'bf:ro', 'SET', 'u4', 0, 1))).toBe('ERR BITFIELD_RO only supports the GET subcommand');
    expect(await err(t.call('BITFIELD_RO', 'bf:ro', 'INCRBY', 'u4', 0, 1))).toBe('ERR BITFIELD_RO only supports the GET subcommand');
    expect(await err(t.call('BITFIELD_RO'))).toBe(arity('bitfield_ro'));
  });

  it('errors', async () => {
    const TYPE_ERR = 'ERR Invalid bitfield type. Use something like i16 u8. Note that u64 is not supported but i64 is.';
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'u64', 0))).toBe(TYPE_ERR);
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'i65', 0))).toBe(TYPE_ERR);
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'i0', 0))).toBe(TYPE_ERR);
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'x8', 0))).toBe(TYPE_ERR);
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'u8', -1))).toBe('ERR bit offset is not an integer or out of range');
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'u8', 'abc'))).toBe('ERR bit offset is not an integer or out of range');
    expect(await err(t.call('BITFIELD', 'bf:e', 'OVERFLOW', 'FOO'))).toBe('ERR Invalid OVERFLOW type specified');
    expect(await err(t.call('BITFIELD', 'bf:e', 'SET', 'u8', 0, 'abc'))).toBe(NOT_INT);
    expect(await err(t.call('BITFIELD', 'bf:e', 'FOO'))).toBe(SYNTAX);
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'u8'))).toBe(SYNTAX);
    expect(await t.call('EXISTS', 'bf:e')).toBe(0);
    await t.call('RPUSH', 'bf:l', 'x');
    expect(await err(t.call('BITFIELD', 'bf:l', 'GET', 'u8', 0))).toBe(WRONGTYPE);
    expect(await err(t.call('BITFIELD'))).toBe(arity('bitfield'));
  });
});
