import { describe, expect, it } from 'vitest';

import { useServer, waitForBlocked } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * Sorted sets: ZPOPMIN, ZPOPMAX, ZMPOP and the blocking pops (zsets.pop.service).
 * Expected values come from the redis.io command docs (and their examples) and Redis error strings; anything not
 * certain is marked `// unverified:`.
 */
const t = useServer();

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const SYNTAX = 'ERR syntax error';

/** Resolves to the error message, or to a marker describing the non-error reply. */
const err = async (p: Promise<unknown>): Promise<string> => {
  try {
    return `(no error; reply: ${JSON.stringify(await p)})`;
  } catch (e) {
    return (e as Error).message;
  }
};

async function resp3(): Promise<RawClient> {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

const seed123 = (key: string) => t.call('ZADD', key, 1, 'one', 2, 'two', 3, 'three');

// ─────────────────────────── popping ───────────────────────────
describe('ZPOPMIN / ZPOPMAX', () => {
  it('docs examples', async () => {
    await seed123('zp:min');
    expect(await t.call('ZPOPMIN', 'zp:min')).toEqual(['one', '1']);
    await seed123('zp:max');
    expect(await t.call('ZPOPMAX', 'zp:max')).toEqual(['three', '3']);
  });

  it('with count, missing key, key deletion', async () => {
    await seed123('zp:cnt');
    expect(await t.call('ZPOPMIN', 'zp:cnt', 2)).toEqual(['one', '1', 'two', '2']);
    expect(await t.call('ZPOPMAX', 'zp:cnt', 10)).toEqual(['three', '3']);
    expect(await t.call('EXISTS', 'zp:cnt')).toBe(0);
    expect(await t.call('ZPOPMIN', 'zp:cnt')).toEqual([]);
    expect(await t.call('ZPOPMAX', 'zp:cnt', 3)).toEqual([]);
    await seed123('zp:zero');
    expect(await t.call('ZPOPMIN', 'zp:zero', 0)).toEqual([]);
    expect(await t.call('ZCARD', 'zp:zero')).toBe(3);
  });

  it('errors', async () => {
    await seed123('zp:e');
    expect.soft(await err(t.call('ZPOPMIN', 'zp:e', -1))).toBe('ERR value is out of range, must be positive');
    expect.soft(await err(t.call('ZPOPMIN', 'zp:e', 'x'))).toBe('ERR value is out of range, must be positive'); // unverified: non-integer count error text
    expect.soft(await err(t.call('ZPOPMIN', 'zp:e', 1, 2))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZPOPMIN'))).toBe(arity('zpopmin'));
    expect.soft(await err(t.call('ZPOPMAX'))).toBe(arity('zpopmax'));
    await t.call('SET', 'zp:str', 'x');
    expect.soft(await err(t.call('ZPOPMIN', 'zp:str'))).toBe(WRONGTYPE);
  });

  it('RESP3: without count flat, with count nested pairs', async () => {
    await t.call('ZADD', 'zp:r3', 1, 'a', 2, 'b', 3, 'c', 4, 'd');
    const r = await resp3();
    expect.soft(await r.send('ZPOPMIN', 'zp:r3')).toBe('*2\r\n$1\r\na\r\n,1\r\n');
    expect.soft(await r.send('ZPOPMIN', 'zp:r3', 1)).toBe('*1\r\n*2\r\n$1\r\nb\r\n,2\r\n');
    expect.soft(await r.send('ZPOPMAX', 'zp:r3', 2)).toBe('*2\r\n*2\r\n$1\r\nd\r\n,4\r\n*2\r\n$1\r\nc\r\n,3\r\n');
    expect.soft(await r.send('ZPOPMAX', 'zp:r3')).toBe('*0\r\n');
    const r2 = await t.raw();
    await t.call('ZADD', 'zp:r2', 1, 'a');
    expect.soft(await r2.send('ZPOPMIN', 'zp:r2', 1)).toBe('*2\r\n$1\r\na\r\n$1\r\n1\r\n');
  });
});

describe('ZMPOP', () => {
  it('docs example', async () => {
    expect(await t.call('ZMPOP', 1, 'zmp:notsuchkey', 'MIN')).toBeNull();
    await t.call('ZADD', 'zmp:a', 1, 'one', 2, 'two', 3, 'three');
    expect(await t.call('ZMPOP', 1, 'zmp:a', 'MIN')).toEqual(['zmp:a', [['one', '1']]]);
    expect(await t.call('ZRANGE', 'zmp:a', 0, -1, 'WITHSCORES')).toEqual(['two', '2', 'three', '3']);
    expect(await t.call('ZMPOP', 1, 'zmp:a', 'MAX', 'COUNT', 10)).toEqual(['zmp:a', [['three', '3'], ['two', '2']]]);
    await t.call('ZADD', 'zmp:b', 4, 'four', 5, 'five', 6, 'six');
    expect(await t.call('ZMPOP', 2, 'zmp:a', 'zmp:b', 'MIN', 'COUNT', 10)).toEqual(['zmp:b', [['four', '4'], ['five', '5'], ['six', '6']]]);
    expect(await t.call('EXISTS', 'zmp:a', 'zmp:b')).toBe(0);
  });

  it('errors', async () => {
    await t.call('ZADD', 'zmp:e', 1, 'a');
    expect.soft(await err(t.call('ZMPOP', 0, 'zmp:e', 'MIN'))).toBe('ERR numkeys should be greater than 0');
    expect.soft(await err(t.call('ZMPOP', 1, 'zmp:e', 'MIN', 'COUNT', 0))).toBe('ERR count should be greater than 0');
    expect.soft(await err(t.call('ZMPOP', 1, 'zmp:e', 'MIN', 'COUNT', -1))).toBe('ERR count should be greater than 0');
    expect.soft(await err(t.call('ZMPOP', 1, 'zmp:e', 'FOO'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZMPOP', 1, 'zmp:e', 'MIN', 'COUNT'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZMPOP', 1, 'zmp:e', 'MIN', 'COUNT', 1, 'COUNT', 1))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZMPOP', 3, 'zmp:e', 'MIN'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZMPOP', 1, 'zmp:e'))).toBe(arity('zmpop'));
    await t.call('SET', 'zmp:str', 'x');
    expect.soft(await err(t.call('ZMPOP', 1, 'zmp:str', 'MIN'))).toBe(WRONGTYPE);
    expect(await t.call('ZCARD', 'zmp:e')).toBe(1);
  });

  it('wire shapes in RESP2 and RESP3', async () => {
    await t.call('ZADD', 'zmp:w', 1, 'a', 2.5, 'b');
    const r = await t.raw();
    expect.soft(await r.send('ZMPOP', 1, 'zmp:none', 'MIN')).toBe('*-1\r\n');
    expect.soft(await r.send('ZMPOP', 1, 'zmp:w', 'MIN')).toBe('*2\r\n$5\r\nzmp:w\r\n*1\r\n*2\r\n$1\r\na\r\n$1\r\n1\r\n');
    const r3 = await resp3();
    expect.soft(await r3.send('ZMPOP', 1, 'zmp:none', 'MIN')).toBe('_\r\n');
    expect.soft(await r3.send('ZMPOP', 1, 'zmp:w', 'MAX')).toBe('*2\r\n$5\r\nzmp:w\r\n*1\r\n*2\r\n$1\r\nb\r\n,2.5\r\n');
  });
});

describe('BZPOPMIN / BZPOPMAX / BZMPOP', () => {
  it('return immediately when data exists', async () => {
    await t.call('ZADD', 'bz:now', 0, 'a', 1, 'b', 2, 'c');
    expect(await t.call('BZPOPMIN', 'bz:none', 'bz:now', 0)).toEqual(['bz:now', 'a', '0']);
    expect(await t.call('BZPOPMAX', 'bz:now', 0)).toEqual(['bz:now', 'c', '2']);
    expect(await t.call('BZMPOP', 0, 1, 'bz:now', 'MIN')).toEqual(['bz:now', [['b', '1']]]);
  });

  it('blocks until another client adds', async () => {
    const c = t.client();
    const p = c.call('BZPOPMIN', 'bz:w1', 'bz:w2', '0');
    await waitForBlocked(t);
    await t.call('ZADD', 'bz:w2', 5, 'x', 3, 'y');
    expect(await p).toEqual(['bz:w2', 'y', '3']);
    expect(await t.call('ZRANGE', 'bz:w2', 0, -1)).toEqual(['x']);

    const c2 = t.client();
    const p2 = c2.call('BZPOPMAX', 'bz:w3', '5');
    await waitForBlocked(t);
    await t.call('ZADD', 'bz:w3', 1, 'a', 9, 'z');
    expect(await p2).toEqual(['bz:w3', 'z', '9']);

    const c3 = t.client();
    const p3 = c3.call('BZMPOP', '0', '2', 'bz:w4', 'bz:w5', 'MAX', 'COUNT', '2');
    await waitForBlocked(t);
    await t.call('ZADD', 'bz:w5', 1, 'a', 2, 'b', 3, 'c');
    expect(await p3).toEqual(['bz:w5', [['c', '3'], ['b', '2']]]);
  });

  it('time out with a null array', async () => {
    expect(await t.call('BZPOPMIN', 'bz:to', 0.1)).toBeNull();
    expect(await t.call('BZPOPMAX', 'bz:to', '0.1')).toBeNull();
    expect(await t.call('BZMPOP', 0.1, 1, 'bz:to', 'MIN')).toBeNull();
    const r2 = await t.raw();
    expect.soft(await r2.send('BZPOPMIN', 'bz:to', '0.1')).toBe('*-1\r\n');
    const r3 = await resp3();
    expect.soft(await r3.send('BZPOPMIN', 'bz:to', '0.1')).toBe('_\r\n');
    expect.soft(await r3.send('BZMPOP', '0.1', 1, 'bz:to', 'MIN')).toBe('_\r\n');
  });

  it('RESP3 reply carries a double', async () => {
    await t.call('ZADD', 'bz:r3', 1.5, 'a');
    const r = await resp3();
    expect.soft(await r.send('BZPOPMIN', 'bz:r3', 0)).toBe('*3\r\n$5\r\nbz:r3\r\n$1\r\na\r\n,1.5\r\n');
  });

  it('errors', async () => {
    expect.soft(await err(t.call('BZPOPMIN', 'bz:e', -1))).toBe('ERR timeout is negative');
    expect.soft(await err(t.call('BZPOPMIN', 'bz:e', 'abc'))).toBe('ERR timeout is not a float or out of range');
    expect.soft(await err(t.call('BZPOPMIN', 'bz:e'))).toBe(arity('bzpopmin'));
    expect.soft(await err(t.call('BZMPOP', 0, 0, 'bz:e', 'MIN'))).toBe('ERR numkeys should be greater than 0');
    expect.soft(await err(t.call('BZMPOP', 0, 1, 'bz:e', 'BAD'))).toBe(SYNTAX);
    expect.soft(await err(t.call('BZMPOP', -1, 1, 'bz:e', 'MIN'))).toBe('ERR timeout is negative');
    await t.call('SET', 'bz:str', 'x');
    expect.soft(await err(t.call('BZPOPMIN', 'bz:str', 0))).toBe(WRONGTYPE);
  });
});
