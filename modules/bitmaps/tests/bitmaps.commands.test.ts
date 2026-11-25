import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

/**
 * Bitmap commands.
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

/** Resolves to the error message of a rejected call (fails if the call succeeds). */
async function err(p: Promise<unknown>): Promise<string> {
  try {
    const v = await p;
    return `NO ERROR, got ${JSON.stringify(v)}`;
  } catch (e) {
    return (e as Error).message;
  }
}

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const SYNTAX = 'ERR syntax error';

const NOT_INT = 'ERR value is not an integer or out of range';

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

/* ------------------------------------------------------------------ */
/* Bitmaps                                                             */
/* ------------------------------------------------------------------ */
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
