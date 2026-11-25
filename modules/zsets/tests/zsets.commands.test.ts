import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * Sorted sets. Expected values come from the redis.io command docs (and
 * their examples) and Redis error strings; anything not certain is marked `// unverified:`.
 */
const t = useServer();

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const SYNTAX = 'ERR syntax error';

const NOT_FLOAT = 'ERR value is not a valid float';

const NOT_INT = 'ERR value is not an integer or out of range';

const SCORE_RANGE = 'ERR min or max is not a float';

const LEX_RANGE = 'ERR min or max not valid string range item';

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

// ───────────────────────────── ZADD ─────────────────────────────
describe('ZADD', () => {
  it('docs example', async () => {
    expect(await t.call('ZADD', 'za:doc', 1, 'one')).toBe(1);
    expect(await t.call('ZADD', 'za:doc', 1, 'uno')).toBe(1);
    expect(await t.call('ZADD', 'za:doc', 2, 'two', 3, 'three')).toBe(2);
    expect(await t.call('ZRANGE', 'za:doc', 0, -1, 'WITHSCORES')).toEqual(['one', '1', 'uno', '1', 'two', '2', 'three', '3']);
  });

  it('returns only newly added members; updates do not count', async () => {
    expect(await t.call('ZADD', 'za:upd', 1, 'a', 2, 'b')).toBe(2);
    expect(await t.call('ZADD', 'za:upd', 5, 'a', 3, 'c')).toBe(1);
    expect(await t.call('ZSCORE', 'za:upd', 'a')).toBe('5');
    expect(await t.call('ZADD', 'za:upd', 1, 'x', 2, 'x')).toBe(1);
    expect(await t.call('ZSCORE', 'za:upd', 'x')).toBe('2');
  });

  it('NX only adds, XX only updates', async () => {
    await t.call('ZADD', 'za:nx', 1, 'a');
    expect(await t.call('ZADD', 'za:nx', 'NX', 10, 'a', 2, 'b')).toBe(1);
    expect(await t.call('ZSCORE', 'za:nx', 'a')).toBe('1');
    expect(await t.call('ZADD', 'za:nx', 'XX', 10, 'a', 3, 'c')).toBe(0);
    expect(await t.call('ZSCORE', 'za:nx', 'a')).toBe('10');
    expect(await t.call('ZSCORE', 'za:nx', 'c')).toBeNull();
    expect(await t.call('ZADD', 'za:xx-missing', 'XX', 1, 'a')).toBe(0);
    expect(await t.call('EXISTS', 'za:xx-missing')).toBe(0);
  });

  it('GT / LT only update in one direction but still add new members', async () => {
    await t.call('ZADD', 'za:gt', 5, 'a');
    expect(await t.call('ZADD', 'za:gt', 'GT', 'CH', 3, 'a')).toBe(0);
    expect(await t.call('ZSCORE', 'za:gt', 'a')).toBe('5');
    expect(await t.call('ZADD', 'za:gt', 'GT', 'CH', 7, 'a')).toBe(1);
    expect(await t.call('ZSCORE', 'za:gt', 'a')).toBe('7');
    expect(await t.call('ZADD', 'za:gt', 'GT', 1, 'new')).toBe(1);
    expect(await t.call('ZADD', 'za:gt', 'LT', 'CH', 9, 'a')).toBe(0);
    expect(await t.call('ZADD', 'za:gt', 'LT', 'CH', 2, 'a')).toBe(1);
    expect(await t.call('ZSCORE', 'za:gt', 'a')).toBe('2');
    expect(await t.call('ZADD', 'za:gt', 'XX', 'GT', 'CH', 10, 'a', 10, 'nope')).toBe(1);
    expect(await t.call('ZSCORE', 'za:gt', 'nope')).toBeNull();
  });

  it('CH counts added and changed members, not unchanged ones', async () => {
    await t.call('ZADD', 'za:ch', 1, 'a', 2, 'b');
    expect(await t.call('ZADD', 'za:ch', 'CH', 1, 'a', 3, 'b', 4, 'c')).toBe(2);
    expect(await t.call('ZADD', 'za:ch', 'ch', 1, 'a')).toBe(0);
  });

  it('INCR behaves like ZINCRBY and returns the new score', async () => {
    expect(await t.call('ZADD', 'za:incr', 'INCR', 1.5, 'a')).toBe('1.5');
    expect(await t.call('ZADD', 'za:incr', 'INCR', 2, 'a')).toBe('3.5');
    expect(await t.call('ZADD', 'za:incr', 'NX', 'INCR', 2, 'a')).toBeNull();
    expect(await t.call('ZADD', 'za:incr', 'XX', 'INCR', 2, 'missing')).toBeNull();
    expect(await t.call('ZADD', 'za:incr', 'GT', 'INCR', -1, 'a')).toBeNull();
    expect(await t.call('ZADD', 'za:incr', 'LT', 'INCR', -1, 'a')).toBe('2.5');
    expect(await t.call('ZADD', 'za:incr', 'XX', 'INCR', 1, 'a')).toBe('3.5');
    expect(await t.call('ZSCORE', 'za:incr', 'missing')).toBeNull();
    // Aborted INCR on a missing key must not create it.
    expect(await t.call('ZADD', 'za:incr-none', 'XX', 'INCR', 1, 'a')).toBeNull();
    expect(await t.call('EXISTS', 'za:incr-none')).toBe(0);
  });

  it('RESP2 aborted INCR is a null bulk', async () => {
    const r = await t.raw();
    await r.send('ZADD', 'za:incr-raw', 1, 'a');
    expect.soft(await r.send('ZADD', 'za:incr-raw', 'NX', 'INCR', 1, 'a')).toBe('$-1\r\n');
    expect.soft(await r.send('ZADD', 'za:incr-raw', 'INCR', 1, 'a')).toBe('$1\r\n2\r\n');
  });

  it('incompatible flag errors', async () => {
    expect.soft(await err(t.call('ZADD', 'za:flags', 'NX', 'XX', 1, 'a'))).toBe('ERR XX and NX options at the same time are not compatible');
    expect.soft(await err(t.call('ZADD', 'za:flags', 'GT', 'LT', 1, 'a'))).toBe('ERR GT, LT, and/or NX options at the same time are not compatible');
    expect.soft(await err(t.call('ZADD', 'za:flags', 'NX', 'GT', 1, 'a'))).toBe('ERR GT, LT, and/or NX options at the same time are not compatible');
    expect.soft(await err(t.call('ZADD', 'za:flags', 'NX', 'LT', 1, 'a'))).toBe('ERR GT, LT, and/or NX options at the same time are not compatible');
    expect.soft(await err(t.call('ZADD', 'za:flags', 'INCR', 1, 'a', 2, 'b'))).toBe('ERR INCR option supports a single increment-element pair');
    expect(await t.call('EXISTS', 'za:flags')).toBe(0);
  });

  it('syntax and arity errors', async () => {
    expect.soft(await err(t.call('ZADD', 'za:syn'))).toBe(arity('zadd'));
    expect.soft(await err(t.call('ZADD', 'za:syn', 1))).toBe(arity('zadd'));
    expect.soft(await err(t.call('ZADD', 'za:syn', 1, 'a', 2))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZADD', 'za:syn', 'NX', 1))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZADD', 'za:syn', 'NX', 'XX'))).toBe(SYNTAX); // unverified: flags consumed, 0 elements -> syntax error before NX/XX check
    expect(await t.call('EXISTS', 'za:syn')).toBe(0);
  });

  it('invalid scores: not a float and NaN', async () => {
    expect.soft(await err(t.call('ZADD', 'za:nan', 'abc', 'a'))).toBe(NOT_FLOAT);
    expect.soft(await err(t.call('ZADD', 'za:nan', 'nan', 'a'))).toBe(NOT_FLOAT);
    expect.soft(await err(t.call('ZADD', 'za:nan', '1.5x', 'a'))).toBe(NOT_FLOAT);
    expect.soft(await err(t.call('ZADD', 'za:nan', '', 'a'))).toBe(NOT_FLOAT);
    expect.soft(await err(t.call('ZADD', 'za:nan', 1, 'a', 'bad', 'b'))).toBe(NOT_FLOAT);
    expect(await t.call('EXISTS', 'za:nan')).toBe(0);
  });

  it('inf scores and NaN results', async () => {
    expect(await t.call('ZADD', 'za:inf', 'inf', 'a', '+inf', 'b', '-inf', 'c', '-INF', 'd')).toBe(4);
    expect(await t.call('ZSCORE', 'za:inf', 'a')).toBe('inf');
    expect(await t.call('ZSCORE', 'za:inf', 'b')).toBe('inf');
    expect(await t.call('ZSCORE', 'za:inf', 'c')).toBe('-inf');
    expect.soft(await err(t.call('ZADD', 'za:inf', 'INCR', '-inf', 'a'))).toBe('ERR resulting score is not a number (NaN)');
    expect.soft(await err(t.call('ZINCRBY', 'za:inf', '-inf', 'a'))).toBe('ERR resulting score is not a number (NaN)');
    expect(await t.call('ZSCORE', 'za:inf', 'a')).toBe('inf');
  });

  it('WRONGTYPE', async () => {
    await t.call('SET', 'za:str', 'x');
    expect.soft(await err(t.call('ZADD', 'za:str', 1, 'a'))).toBe(WRONGTYPE);
  });
});

describe('score formatting', () => {
  it('RESP2 uses the shortest representation, integers without .0', async () => {
    await t.call('ZADD', 'sf', 1.5, 'a', 10, 'b', '3.0', 'c', '1e300', 'd', 0.1, 'e', -2.25, 'f', 123456789, 'g', '-0.5', 'h');
    expect(await t.call('ZSCORE', 'sf', 'a')).toBe('1.5');
    expect(await t.call('ZSCORE', 'sf', 'b')).toBe('10');
    expect(await t.call('ZSCORE', 'sf', 'c')).toBe('3');
    expect(await t.call('ZSCORE', 'sf', 'd')).toBe('1e+300');
    expect(await t.call('ZSCORE', 'sf', 'e')).toBe('0.1');
    expect(await t.call('ZSCORE', 'sf', 'f')).toBe('-2.25');
    expect(await t.call('ZSCORE', 'sf', 'g')).toBe('123456789');
    expect(await t.call('ZSCORE', 'sf', 'h')).toBe('-0.5');
    expect(await t.call('ZINCRBY', 'sf', 0.2, 'e')).toBe('0.30000000000000004');
  });

  it('RESP3 sends doubles', async () => {
    const r = await resp3();
    await r.send('ZADD', 'sf3', 1.5, 'a', 10, 'b', 'inf', 'c', '-inf', 'd', '1e300', 'e');
    expect.soft(await r.send('ZSCORE', 'sf3', 'a')).toBe(',1.5\r\n');
    expect.soft(await r.send('ZSCORE', 'sf3', 'b')).toBe(',10\r\n');
    expect.soft(await r.send('ZSCORE', 'sf3', 'c')).toBe(',inf\r\n');
    expect.soft(await r.send('ZSCORE', 'sf3', 'd')).toBe(',-inf\r\n');
    expect.soft(await r.send('ZSCORE', 'sf3', 'e')).toBe(',1e+300\r\n');
    expect.soft(await r.send('ZSCORE', 'sf3', 'nope')).toBe('_\r\n');
    expect.soft(await r.send('ZINCRBY', 'sf3', 1, 'a')).toBe(',2.5\r\n');
    expect.soft(await r.send('ZADD', 'sf3', 'INCR', 1, 'b')).toBe(',11\r\n');
    expect.soft(await r.send('ZADD', 'sf3', 'NX', 'INCR', 1, 'b')).toBe('_\r\n');
    expect.soft(await r.send('ZADD', 'sf3', 1, 'z')).toBe(':1\r\n');
  });
});

describe('encodings', () => {
  it('listpack until 128 entries, then skiplist', async () => {
    await t.call('ZADD', 'enc:z', 1, 'a');
    expect(await t.call('OBJECT', 'ENCODING', 'enc:z')).toBe('listpack');
    const args: Array<string | number> = [];
    for (let i = 0; i < 127; i++) args.push(i, `m${i}`);
    await t.call('ZADD', 'enc:z', ...args);
    expect(await t.call('ZCARD', 'enc:z')).toBe(128);
    expect(await t.call('OBJECT', 'ENCODING', 'enc:z')).toBe('listpack');
    await t.call('ZADD', 'enc:z', 999, 'extra');
    expect(await t.call('OBJECT', 'ENCODING', 'enc:z')).toBe('skiplist');
  });

  it('a member longer than 64 bytes converts to skiplist', async () => {
    await t.call('ZADD', 'enc:long', 1, 'x'.repeat(64));
    expect(await t.call('OBJECT', 'ENCODING', 'enc:long')).toBe('listpack');
    await t.call('ZADD', 'enc:long', 1, 'y'.repeat(65));
    expect(await t.call('OBJECT', 'ENCODING', 'enc:long')).toBe('skiplist');
  });

  it('TYPE is zset, geo keys are zsets', async () => {
    await t.call('ZADD', 'enc:type', 1, 'a');
    expect(await t.call('TYPE', 'enc:type')).toBe('zset');
    await t.call('GEOADD', 'enc:geo', 13.361389, 38.115556, 'Palermo');
    expect(await t.call('TYPE', 'enc:geo')).toBe('zset');
    expect(await t.call('OBJECT', 'ENCODING', 'enc:geo')).toBe('listpack');
  });
});

// ─────────────────────── simple read/write ───────────────────────
describe('ZINCRBY', () => {
  it('docs example', async () => {
    await t.call('ZADD', 'zi:doc', 1, 'one', 2, 'two');
    expect(await t.call('ZINCRBY', 'zi:doc', 2, 'one')).toBe('3');
    expect(await t.call('ZRANGE', 'zi:doc', 0, -1, 'WITHSCORES')).toEqual(['two', '2', 'one', '3']);
  });

  it('creates key and member, accepts negative and float increments', async () => {
    expect(await t.call('ZINCRBY', 'zi:new', 2.5, 'm')).toBe('2.5');
    expect(await t.call('ZINCRBY', 'zi:new', -5, 'm')).toBe('-2.5');
    expect(await t.call('ZCARD', 'zi:new')).toBe(1);
  });

  it('errors', async () => {
    expect.soft(await err(t.call('ZINCRBY', 'zi:e', 'x', 'm'))).toBe(NOT_FLOAT);
    expect.soft(await err(t.call('ZINCRBY', 'zi:e', 1))).toBe(arity('zincrby'));
    expect.soft(await err(t.call('ZINCRBY', 'zi:e', 1, 'm', 'extra'))).toBe(arity('zincrby'));
    await t.call('SET', 'zi:str', 'x');
    expect.soft(await err(t.call('ZINCRBY', 'zi:str', 1, 'm'))).toBe(WRONGTYPE);
  });
});

describe('ZREM / ZCARD / ZSCORE / ZMSCORE', () => {
  it('ZREM docs example and key deletion when empty', async () => {
    await seed123('zr:doc');
    expect(await t.call('ZREM', 'zr:doc', 'two')).toBe(1);
    expect(await t.call('ZRANGE', 'zr:doc', 0, -1, 'WITHSCORES')).toEqual(['one', '1', 'three', '3']);
    expect(await t.call('ZREM', 'zr:doc', 'one', 'one', 'nope', 'three')).toBe(2);
    expect(await t.call('EXISTS', 'zr:doc')).toBe(0);
    expect(await t.call('ZREM', 'zr:missing', 'a')).toBe(0);
    expect.soft(await err(t.call('ZREM', 'zr:doc'))).toBe(arity('zrem'));
    await t.call('SET', 'zr:str', 'x');
    expect.soft(await err(t.call('ZREM', 'zr:str', 'a'))).toBe(WRONGTYPE);
  });

  it('ZCARD', async () => {
    await t.call('ZADD', 'zc:doc', 1, 'one', 2, 'two');
    expect(await t.call('ZCARD', 'zc:doc')).toBe(2);
    expect(await t.call('ZCARD', 'zc:missing')).toBe(0);
    expect.soft(await err(t.call('ZCARD'))).toBe(arity('zcard'));
    expect.soft(await err(t.call('ZCARD', 'a', 'b'))).toBe(arity('zcard'));
    await t.call('SET', 'zc:str', 'x');
    expect.soft(await err(t.call('ZCARD', 'zc:str'))).toBe(WRONGTYPE);
  });

  it('ZSCORE', async () => {
    await t.call('ZADD', 'zs:doc', 1, 'one');
    expect(await t.call('ZSCORE', 'zs:doc', 'one')).toBe('1');
    expect(await t.call('ZSCORE', 'zs:doc', 'nope')).toBeNull();
    expect(await t.call('ZSCORE', 'zs:missing', 'one')).toBeNull();
    expect.soft(await err(t.call('ZSCORE', 'zs:doc'))).toBe(arity('zscore'));
    await t.call('SET', 'zs:str', 'x');
    expect.soft(await err(t.call('ZSCORE', 'zs:str', 'a'))).toBe(WRONGTYPE);
  });

  it('ZMSCORE docs example, missing key, RESP3', async () => {
    await t.call('ZADD', 'zms:doc', 1, 'one', 2, 'two');
    expect(await t.call('ZMSCORE', 'zms:doc', 'one', 'two', 'nofield')).toEqual(['1', '2', null]);
    expect(await t.call('ZMSCORE', 'zms:missing', 'a', 'b')).toEqual([null, null]);
    expect.soft(await err(t.call('ZMSCORE', 'zms:doc'))).toBe(arity('zmscore'));
    await t.call('SET', 'zms:str', 'x');
    expect.soft(await err(t.call('ZMSCORE', 'zms:str', 'a'))).toBe(WRONGTYPE);
    const r = await t.raw();
    expect.soft(await r.send('ZMSCORE', 'zms:doc', 'one', 'nofield')).toBe('*2\r\n$1\r\n1\r\n$-1\r\n');
    const r3 = await resp3();
    expect.soft(await r3.send('ZMSCORE', 'zms:doc', 'one', 'two', 'nofield')).toBe('*3\r\n,1\r\n,2\r\n_\r\n');
  });
});

// ─────────────────────────── counting ───────────────────────────
describe('ZCOUNT / ZLEXCOUNT', () => {
  it('ZCOUNT docs example and bounds', async () => {
    await seed123('zcnt:doc');
    expect(await t.call('ZCOUNT', 'zcnt:doc', '-inf', '+inf')).toBe(3);
    expect(await t.call('ZCOUNT', 'zcnt:doc', '(1', 3)).toBe(2);
    expect(await t.call('ZCOUNT', 'zcnt:doc', '(1', '(3')).toBe(1);
    expect(await t.call('ZCOUNT', 'zcnt:doc', 3, 1)).toBe(0);
    expect(await t.call('ZCOUNT', 'zcnt:doc', '-inf', '(2')).toBe(1);
    expect(await t.call('ZCOUNT', 'zcnt:doc', 'inf', 'inf')).toBe(0);
    expect(await t.call('ZCOUNT', 'zcnt:missing', '-inf', '+inf')).toBe(0);
  });

  it('ZCOUNT errors', async () => {
    await seed123('zcnt:e');
    expect.soft(await err(t.call('ZCOUNT', 'zcnt:e', 'a', 3))).toBe(SCORE_RANGE);
    expect.soft(await err(t.call('ZCOUNT', 'zcnt:e', 1, '((3'))).toBe(SCORE_RANGE);
    expect.soft(await err(t.call('ZCOUNT', 'zcnt:e', 'nan', 3))).toBe(SCORE_RANGE);
    expect.soft(await err(t.call('ZCOUNT', 'zcnt:e', 1))).toBe(arity('zcount'));
    await t.call('SET', 'zcnt:str', 'x');
    expect.soft(await err(t.call('ZCOUNT', 'zcnt:str', 0, 1))).toBe(WRONGTYPE);
  });

  it('ZLEXCOUNT docs example and bounds', async () => {
    await t.call('ZADD', 'zlc:doc', 0, 'a', 0, 'b', 0, 'c', 0, 'd', 0, 'e');
    await t.call('ZADD', 'zlc:doc', 0, 'f', 0, 'g');
    expect(await t.call('ZLEXCOUNT', 'zlc:doc', '-', '+')).toBe(7);
    expect(await t.call('ZLEXCOUNT', 'zlc:doc', '[b', '[f')).toBe(5);
    expect(await t.call('ZLEXCOUNT', 'zlc:doc', '(b', '(f')).toBe(3);
    expect(await t.call('ZLEXCOUNT', 'zlc:doc', '+', '-')).toBe(0);
    expect(await t.call('ZLEXCOUNT', 'zlc:missing', '-', '+')).toBe(0);
  });

  it('ZLEXCOUNT errors', async () => {
    await t.call('ZADD', 'zlc:e', 0, 'a');
    expect.soft(await err(t.call('ZLEXCOUNT', 'zlc:e', 'a', '+'))).toBe(LEX_RANGE);
    expect.soft(await err(t.call('ZLEXCOUNT', 'zlc:e', '-', 'b'))).toBe(LEX_RANGE);
    expect.soft(await err(t.call('ZLEXCOUNT', 'zlc:e', '-'))).toBe(arity('zlexcount'));
    await t.call('SET', 'zlc:str', 'x');
    expect.soft(await err(t.call('ZLEXCOUNT', 'zlc:str', '-', '+'))).toBe(WRONGTYPE);
  });
});

// ─────────────────────────── ranges ───────────────────────────
describe('ZRANGE', () => {
  it('docs examples (rank)', async () => {
    await seed123('zrg:doc');
    expect(await t.call('ZRANGE', 'zrg:doc', 0, -1)).toEqual(['one', 'two', 'three']);
    expect(await t.call('ZRANGE', 'zrg:doc', 2, 3)).toEqual(['three']);
    expect(await t.call('ZRANGE', 'zrg:doc', -2, -1)).toEqual(['two', 'three']);
    expect(await t.call('ZRANGE', 'zrg:doc', 0, 1, 'WITHSCORES')).toEqual(['one', '1', 'two', '2']);
    expect(await t.call('ZRANGE', 'zrg:doc', '(1', '+inf', 'BYSCORE', 'LIMIT', 1, 1)).toEqual(['three']);
  });

  it('rank edge cases', async () => {
    await seed123('zrg:rank');
    expect(await t.call('ZRANGE', 'zrg:rank', 5, 10)).toEqual([]);
    expect(await t.call('ZRANGE', 'zrg:rank', 2, 1)).toEqual([]);
    expect(await t.call('ZRANGE', 'zrg:rank', -100, 100)).toEqual(['one', 'two', 'three']);
    expect(await t.call('ZRANGE', 'zrg:rank', 0, 0, 'REV')).toEqual(['three']);
    expect(await t.call('ZRANGE', 'zrg:rank', 0, -1, 'REV', 'WITHSCORES')).toEqual(['three', '3', 'two', '2', 'one', '1']);
    expect(await t.call('ZRANGE', 'zrg:missing', 0, -1)).toEqual([]);
  });

  it('BYSCORE with REV, LIMIT, WITHSCORES and infinities', async () => {
    await t.call('ZADD', 'zrg:sc', '-inf', 'ninf', 1, 'a', 2, 'b', 3, 'c', 'inf', 'pinf');
    expect(await t.call('ZRANGE', 'zrg:sc', '-inf', '+inf', 'BYSCORE', 'WITHSCORES')).toEqual(['ninf', '-inf', 'a', '1', 'b', '2', 'c', '3', 'pinf', 'inf']);
    expect(await t.call('ZRANGE', 'zrg:sc', '(-inf', '(+inf', 'BYSCORE')).toEqual(['a', 'b', 'c']);
    expect(await t.call('ZRANGE', 'zrg:sc', '+inf', '-inf', 'BYSCORE', 'REV')).toEqual(['pinf', 'c', 'b', 'a', 'ninf']);
    expect(await t.call('ZRANGE', 'zrg:sc', '-inf', '+inf', 'BYSCORE', 'REV')).toEqual([]);
    expect(await t.call('ZRANGE', 'zrg:sc', 3, '(1', 'BYSCORE', 'REV', 'LIMIT', 0, 1, 'WITHSCORES')).toEqual(['c', '3']);
    expect(await t.call('ZRANGE', 'zrg:sc', 1, 3, 'BYSCORE', 'LIMIT', 1, -1)).toEqual(['b', 'c']);
    expect(await t.call('ZRANGE', 'zrg:sc', 1, 3, 'BYSCORE', 'LIMIT', 5, 2)).toEqual([]);
    expect(await t.call('ZRANGE', 'zrg:sc', 1, 3, 'byscore', 'limit', 0, 0)).toEqual([]);
  });

  it('BYLEX with REV and LIMIT', async () => {
    await t.call('ZADD', 'zrg:lex', 0, 'a', 0, 'b', 0, 'c', 0, 'd', 0, 'e');
    expect(await t.call('ZRANGE', 'zrg:lex', '-', '+', 'BYLEX')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(await t.call('ZRANGE', 'zrg:lex', '[b', '(d', 'BYLEX')).toEqual(['b', 'c']);
    expect(await t.call('ZRANGE', 'zrg:lex', '+', '-', 'BYLEX', 'REV')).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(await t.call('ZRANGE', 'zrg:lex', '(d', '[b', 'BYLEX', 'REV', 'LIMIT', 1, 5)).toEqual(['b']);
    expect(await t.call('ZRANGE', 'zrg:lex', '-', '+', 'BYLEX', 'LIMIT', 2, 2)).toEqual(['c', 'd']);
  });

  it('option conflicts and errors', async () => {
    await seed123('zrg:e');
    expect.soft(await err(t.call('ZRANGE', 'zrg:e', 0, -1, 'LIMIT', 0, 1))).toBe('ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX');
    expect.soft(await err(t.call('ZRANGE', 'zrg:e', '-', '+', 'BYLEX', 'WITHSCORES'))).toBe('ERR syntax error, WITHSCORES not supported in combination with BYLEX');
    expect.soft(await err(t.call('ZRANGE', 'zrg:e', 0, 1, 'BYSCORE', 'BYLEX'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANGE', 'zrg:e', 0, 1, 'REV', 'REV'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANGE', 'zrg:e', 0, 1, 'FOO'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANGE', 'zrg:e', 0, 1, 'BYSCORE', 'LIMIT', 0))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANGE', 'zrg:e', 0, 1, 'BYSCORE', 'LIMIT', 'x', 1))).toBe(NOT_INT);
    expect.soft(await err(t.call('ZRANGE', 'zrg:e', 'a', 1))).toBe(NOT_INT);
    expect.soft(await err(t.call('ZRANGE', 'zrg:e', 'a', 1, 'BYSCORE'))).toBe(SCORE_RANGE);
    expect.soft(await err(t.call('ZRANGE', 'zrg:e', 'a', '+', 'BYLEX'))).toBe(LEX_RANGE);
    expect.soft(await err(t.call('ZRANGE', 'zrg:e', 0))).toBe(arity('zrange'));
    await t.call('SET', 'zrg:str', 'x');
    expect.soft(await err(t.call('ZRANGE', 'zrg:str', 0, -1))).toBe(WRONGTYPE);
  });

  it('RESP3 WITHSCORES returns [member, score] pairs', async () => {
    await t.call('ZADD', 'zrg:r3', 1, 'a', 2.5, 'b');
    const r = await resp3();
    expect.soft(await r.send('ZRANGE', 'zrg:r3', 0, -1, 'WITHSCORES')).toBe('*2\r\n*2\r\n$1\r\na\r\n,1\r\n*2\r\n$1\r\nb\r\n,2.5\r\n');
    expect.soft(await r.send('ZRANGE', 'zrg:r3', 0, -1)).toBe('*2\r\n$1\r\na\r\n$1\r\nb\r\n');
    expect.soft(await r.send('ZRANGE', 'zrg:r3', 5, 6, 'WITHSCORES')).toBe('*0\r\n');
    expect.soft(await r.send('ZREVRANGE', 'zrg:r3', 0, 0, 'WITHSCORES')).toBe('*1\r\n*2\r\n$1\r\nb\r\n,2.5\r\n');
    expect.soft(await r.send('ZRANGEBYSCORE', 'zrg:r3', '-inf', '+inf', 'WITHSCORES')).toBe('*2\r\n*2\r\n$1\r\na\r\n,1\r\n*2\r\n$1\r\nb\r\n,2.5\r\n');
    expect.soft(await r.send('ZREVRANGEBYSCORE', 'zrg:r3', '+inf', '-inf', 'WITHSCORES', 'LIMIT', 0, 1)).toBe('*1\r\n*2\r\n$1\r\nb\r\n,2.5\r\n');
  });

  it('RESP2 WITHSCORES is flat', async () => {
    await t.call('ZADD', 'zrg:r2', 1, 'a', 2.5, 'b');
    const r = await t.raw();
    expect.soft(await r.send('ZRANGE', 'zrg:r2', 0, -1, 'WITHSCORES')).toBe('*4\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n$3\r\n2.5\r\n');
  });

  it('members with equal scores order lexicographically (binary)', async () => {
    await t.call('ZADD', 'zrg:tie', 1, 'b', 1, 'B', 1, 'a', 0, 'z', 1, 'aa');
    expect(await t.call('ZRANGE', 'zrg:tie', 0, -1)).toEqual(['z', 'B', 'a', 'aa', 'b']);
  });
});

describe('ZREVRANGE', () => {
  it('docs examples', async () => {
    await seed123('zrr:doc');
    expect(await t.call('ZREVRANGE', 'zrr:doc', 0, -1)).toEqual(['three', 'two', 'one']);
    expect(await t.call('ZREVRANGE', 'zrr:doc', 2, 3)).toEqual(['one']);
    expect(await t.call('ZREVRANGE', 'zrr:doc', -2, -1)).toEqual(['two', 'one']);
    expect(await t.call('ZREVRANGE', 'zrr:doc', 0, 0, 'WITHSCORES')).toEqual(['three', '3']);
  });

  it('errors', async () => {
    await seed123('zrr:e');
    expect.soft(await err(t.call('ZREVRANGE', 'zrr:e', 0, -1, 'BYSCORE'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZREVRANGE', 'zrr:e', 0, -1, 'REV'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZREVRANGE', 'zrr:e', 0))).toBe(arity('zrevrange'));
    expect.soft(await err(t.call('ZREVRANGE', 'zrr:e', 'x', 1))).toBe(NOT_INT);
  });
});

describe('ZRANGEBYSCORE / ZREVRANGEBYSCORE', () => {
  it('ZRANGEBYSCORE docs examples', async () => {
    await seed123('zrbs:doc');
    expect(await t.call('ZRANGEBYSCORE', 'zrbs:doc', '-inf', '+inf')).toEqual(['one', 'two', 'three']);
    expect(await t.call('ZRANGEBYSCORE', 'zrbs:doc', 1, 2)).toEqual(['one', 'two']);
    expect(await t.call('ZRANGEBYSCORE', 'zrbs:doc', '(1', 2)).toEqual(['two']);
    expect(await t.call('ZRANGEBYSCORE', 'zrbs:doc', '(1', '(2')).toEqual([]);
  });

  it('ZRANGEBYSCORE options', async () => {
    await seed123('zrbs:opt');
    expect(await t.call('ZRANGEBYSCORE', 'zrbs:opt', '-inf', '+inf', 'WITHSCORES', 'LIMIT', 1, 5)).toEqual(['two', '2', 'three', '3']);
    expect(await t.call('ZRANGEBYSCORE', 'zrbs:opt', '-inf', '+inf', 'LIMIT', 0, -1)).toEqual(['one', 'two', 'three']);
    expect(await t.call('ZRANGEBYSCORE', 'zrbs:opt', 3, 1)).toEqual([]);
    expect.soft(await err(t.call('ZRANGEBYSCORE', 'zrbs:opt', 0, 1, 'LIMIT', 0))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANGEBYSCORE', 'zrbs:opt', 0, 1, 'REV'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANGEBYSCORE', 'zrbs:opt', 0, 1, 'BYLEX'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANGEBYSCORE', 'zrbs:opt', 'x', 1))).toBe(SCORE_RANGE);
    expect.soft(await err(t.call('ZRANGEBYSCORE', 'zrbs:opt', 0))).toBe(arity('zrangebyscore'));
    await t.call('SET', 'zrbs:str', 'x');
    expect.soft(await err(t.call('ZRANGEBYSCORE', 'zrbs:str', 0, 1))).toBe(WRONGTYPE);
  });

  it('ZREVRANGEBYSCORE docs examples and options', async () => {
    await seed123('zrrbs:doc');
    expect(await t.call('ZREVRANGEBYSCORE', 'zrrbs:doc', '+inf', '-inf')).toEqual(['three', 'two', 'one']);
    expect(await t.call('ZREVRANGEBYSCORE', 'zrrbs:doc', 2, 1)).toEqual(['two', 'one']);
    expect(await t.call('ZREVRANGEBYSCORE', 'zrrbs:doc', 2, '(1')).toEqual(['two']);
    expect(await t.call('ZREVRANGEBYSCORE', 'zrrbs:doc', '(2', '(1')).toEqual([]);
    expect(await t.call('ZREVRANGEBYSCORE', 'zrrbs:doc', 1, 2)).toEqual([]);
    expect(await t.call('ZREVRANGEBYSCORE', 'zrrbs:doc', '+inf', '-inf', 'WITHSCORES', 'LIMIT', 1, 1)).toEqual(['two', '2']);
    expect.soft(await err(t.call('ZREVRANGEBYSCORE', 'zrrbs:doc', '+inf', 'y'))).toBe(SCORE_RANGE);
  });
});

describe('ZRANGEBYLEX / ZREVRANGEBYLEX', () => {
  it('ZRANGEBYLEX docs examples', async () => {
    await t.call('ZADD', 'zrbl:doc', 0, 'a', 0, 'b', 0, 'c', 0, 'd', 0, 'e', 0, 'f', 0, 'g');
    expect(await t.call('ZRANGEBYLEX', 'zrbl:doc', '-', '[c')).toEqual(['a', 'b', 'c']);
    expect(await t.call('ZRANGEBYLEX', 'zrbl:doc', '-', '(c')).toEqual(['a', 'b']);
    expect(await t.call('ZRANGEBYLEX', 'zrbl:doc', '[aaa', '(g')).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(await t.call('ZRANGEBYLEX', 'zrbl:doc', '-', '+', 'LIMIT', 1, 2)).toEqual(['b', 'c']);
    expect(await t.call('ZRANGEBYLEX', 'zrbl:missing', '-', '+')).toEqual([]);
  });

  it('ZREVRANGEBYLEX docs examples', async () => {
    await t.call('ZADD', 'zrrbl:doc', 0, 'a', 0, 'b', 0, 'c', 0, 'd', 0, 'e', 0, 'f', 0, 'g');
    expect(await t.call('ZREVRANGEBYLEX', 'zrrbl:doc', '[c', '-')).toEqual(['c', 'b', 'a']);
    expect(await t.call('ZREVRANGEBYLEX', 'zrrbl:doc', '(c', '-')).toEqual(['b', 'a']);
    expect(await t.call('ZREVRANGEBYLEX', 'zrrbl:doc', '(g', '[aaa')).toEqual(['f', 'e', 'd', 'c', 'b']);
    expect(await t.call('ZREVRANGEBYLEX', 'zrrbl:doc', '+', '-', 'LIMIT', 0, 2)).toEqual(['g', 'f']);
  });

  it('errors', async () => {
    await t.call('ZADD', 'zrbl:e', 0, 'a');
    expect.soft(await err(t.call('ZRANGEBYLEX', 'zrbl:e', 'a', '+'))).toBe(LEX_RANGE);
    expect.soft(await err(t.call('ZREVRANGEBYLEX', 'zrbl:e', '+', 'a'))).toBe(LEX_RANGE);
    expect.soft(await err(t.call('ZRANGEBYLEX', 'zrbl:e', '-', '+', 'WITHSCORES'))).toBe('ERR syntax error, WITHSCORES not supported in combination with BYLEX');
    expect.soft(await err(t.call('ZRANGEBYLEX', 'zrbl:e', '-', '+', 'LIMIT', 1))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANGEBYLEX', 'zrbl:e', '-'))).toBe(arity('zrangebylex'));
    await t.call('SET', 'zrbl:str', 'x');
    expect.soft(await err(t.call('ZRANGEBYLEX', 'zrbl:str', '-', '+'))).toBe(WRONGTYPE);
  });
});

describe('ZRANGESTORE', () => {
  it('docs example', async () => {
    await t.call('ZADD', 'zrs:src', 1, 'one', 2, 'two', 3, 'three', 4, 'four');
    expect(await t.call('ZRANGESTORE', 'zrs:dst', 'zrs:src', 2, -1)).toBe(2);
    expect(await t.call('ZRANGE', 'zrs:dst', 0, -1)).toEqual(['three', 'four']);
  });

  it('BYSCORE / BYLEX / REV / LIMIT, empty result deletes destination', async () => {
    await t.call('ZADD', 'zrs:src2', 1, 'a', 2, 'b', 3, 'c', 4, 'd');
    expect(await t.call('ZRANGESTORE', 'zrs:d1', 'zrs:src2', '(1', '+inf', 'BYSCORE', 'LIMIT', 0, 2)).toBe(2);
    expect(await t.call('ZRANGE', 'zrs:d1', 0, -1, 'WITHSCORES')).toEqual(['b', '2', 'c', '3']);
    expect(await t.call('ZRANGESTORE', 'zrs:d2', 'zrs:src2', 3, 1, 'BYSCORE', 'REV')).toBe(3);
    expect(await t.call('ZRANGE', 'zrs:d2', 0, -1, 'WITHSCORES')).toEqual(['a', '1', 'b', '2', 'c', '3']);
    await t.call('ZADD', 'zrs:lex', 0, 'a', 0, 'b', 0, 'c');
    expect(await t.call('ZRANGESTORE', 'zrs:d3', 'zrs:lex', '[c', '-', 'BYLEX', 'REV', 'LIMIT', 0, 2)).toBe(2);
    expect(await t.call('ZRANGE', 'zrs:d3', 0, -1)).toEqual(['b', 'c']);
    expect(await t.call('ZRANGESTORE', 'zrs:d3', 'zrs:src2', 10, 20)).toBe(0);
    expect(await t.call('EXISTS', 'zrs:d3')).toBe(0);
    await t.call('SET', 'zrs:d4', 'string');
    expect(await t.call('ZRANGESTORE', 'zrs:d4', 'zrs:missing', 0, -1)).toBe(0);
    expect(await t.call('EXISTS', 'zrs:d4')).toBe(0);
  });

  it('overwrites a destination of another type', async () => {
    await t.call('ZADD', 'zrs:src3', 1, 'a');
    await t.call('SET', 'zrs:dst-str', 'x');
    expect(await t.call('ZRANGESTORE', 'zrs:dst-str', 'zrs:src3', 0, -1)).toBe(1);
    expect(await t.call('TYPE', 'zrs:dst-str')).toBe('zset');
  });

  it('errors', async () => {
    await t.call('ZADD', 'zrs:e', 1, 'a');
    expect.soft(await err(t.call('ZRANGESTORE', 'zrs:ed', 'zrs:e', 0, -1, 'WITHSCORES'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANGESTORE', 'zrs:ed', 'zrs:e', 0, -1, 'LIMIT', 0, 1))).toBe('ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX');
    expect.soft(await err(t.call('ZRANGESTORE', 'zrs:ed', 'zrs:e', 0))).toBe(arity('zrangestore'));
    await t.call('SET', 'zrs:str', 'x');
    expect.soft(await err(t.call('ZRANGESTORE', 'zrs:ed', 'zrs:str', 0, -1))).toBe(WRONGTYPE);
  });
});

// ─────────────────────────── ranks ───────────────────────────
describe('ZRANK / ZREVRANK', () => {
  it('ZRANK docs examples', async () => {
    await seed123('zrk:doc');
    expect(await t.call('ZRANK', 'zrk:doc', 'three')).toBe(2);
    expect(await t.call('ZRANK', 'zrk:doc', 'four')).toBeNull();
    expect(await t.call('ZRANK', 'zrk:doc', 'three', 'WITHSCORE')).toEqual([2, '3']);
    expect(await t.call('ZRANK', 'zrk:doc', 'four', 'WITHSCORE')).toBeNull();
    expect(await t.call('ZRANK', 'zrk:missing', 'a')).toBeNull();
  });

  it('ZREVRANK docs examples', async () => {
    await seed123('zrrk:doc');
    expect(await t.call('ZREVRANK', 'zrrk:doc', 'one')).toBe(2);
    expect(await t.call('ZREVRANK', 'zrrk:doc', 'four')).toBeNull();
    expect(await t.call('ZREVRANK', 'zrrk:doc', 'three', 'withscore')).toEqual([0, '3']);
    expect(await t.call('ZREVRANK', 'zrrk:doc', 'four', 'WITHSCORE')).toBeNull();
  });

  it('wire shapes: null bulk vs null array, RESP3', async () => {
    await t.call('ZADD', 'zrk:wire', 1.5, 'a');
    const r = await t.raw();
    expect.soft(await r.send('ZRANK', 'zrk:wire', 'x')).toBe('$-1\r\n');
    expect.soft(await r.send('ZRANK', 'zrk:wire', 'x', 'WITHSCORE')).toBe('*-1\r\n');
    expect.soft(await r.send('ZRANK', 'zrk:nokey', 'x', 'WITHSCORE')).toBe('*-1\r\n');
    expect.soft(await r.send('ZRANK', 'zrk:wire', 'a', 'WITHSCORE')).toBe('*2\r\n:0\r\n$3\r\n1.5\r\n');
    const r3 = await resp3();
    expect.soft(await r3.send('ZRANK', 'zrk:wire', 'a', 'WITHSCORE')).toBe('*2\r\n:0\r\n,1.5\r\n');
    expect.soft(await r3.send('ZRANK', 'zrk:wire', 'x', 'WITHSCORE')).toBe('_\r\n');
    expect.soft(await r3.send('ZREVRANK', 'zrk:wire', 'x')).toBe('_\r\n');
  });

  it('errors', async () => {
    await seed123('zrk:e');
    expect.soft(await err(t.call('ZRANK', 'zrk:e', 'one', 'FOO'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANK', 'zrk:e', 'one', 'WITHSCORE', 'x'))).toBe(arity('zrank'));
    expect.soft(await err(t.call('ZRANK', 'zrk:e'))).toBe(arity('zrank'));
    expect.soft(await err(t.call('ZREVRANK', 'zrk:e'))).toBe(arity('zrevrank'));
    await t.call('SET', 'zrk:str', 'x');
    expect.soft(await err(t.call('ZRANK', 'zrk:str', 'a'))).toBe(WRONGTYPE);
  });
});

// ─────────────────────────── removal ranges ───────────────────────────
describe('ZREMRANGEBYSCORE / ZREMRANGEBYRANK / ZREMRANGEBYLEX', () => {
  it('ZREMRANGEBYSCORE docs example', async () => {
    await seed123('zrrs:doc');
    expect(await t.call('ZREMRANGEBYSCORE', 'zrrs:doc', '-inf', '(2')).toBe(1);
    expect(await t.call('ZRANGE', 'zrrs:doc', 0, -1, 'WITHSCORES')).toEqual(['two', '2', 'three', '3']);
    expect(await t.call('ZREMRANGEBYSCORE', 'zrrs:doc', 5, 10)).toBe(0);
    expect(await t.call('ZREMRANGEBYSCORE', 'zrrs:doc', '-inf', '+inf')).toBe(2);
    expect(await t.call('EXISTS', 'zrrs:doc')).toBe(0);
    expect(await t.call('ZREMRANGEBYSCORE', 'zrrs:missing', '-inf', '+inf')).toBe(0);
    expect.soft(await err(t.call('ZREMRANGEBYSCORE', 'zrrs:doc', 'a', 1))).toBe(SCORE_RANGE);
    expect.soft(await err(t.call('ZREMRANGEBYSCORE', 'zrrs:doc', 1))).toBe(arity('zremrangebyscore'));
  });

  it('ZREMRANGEBYRANK docs example', async () => {
    await seed123('zrrr:doc');
    expect(await t.call('ZREMRANGEBYRANK', 'zrrr:doc', 0, 1)).toBe(2);
    expect(await t.call('ZRANGE', 'zrrr:doc', 0, -1, 'WITHSCORES')).toEqual(['three', '3']);
    expect(await t.call('ZREMRANGEBYRANK', 'zrrr:doc', 5, 10)).toBe(0);
    expect(await t.call('ZREMRANGEBYRANK', 'zrrr:doc', -1, -1)).toBe(1);
    expect(await t.call('EXISTS', 'zrrr:doc')).toBe(0);
    expect.soft(await err(t.call('ZREMRANGEBYRANK', 'zrrr:doc', 'a', 1))).toBe(NOT_INT);
    expect.soft(await err(t.call('ZREMRANGEBYRANK', 'zrrr:doc', 1))).toBe(arity('zremrangebyrank'));
  });

  it('ZREMRANGEBYLEX docs example', async () => {
    await t.call('ZADD', 'zrrl:doc', 0, 'aaaa', 0, 'b', 0, 'c', 0, 'd', 0, 'e');
    await t.call('ZADD', 'zrrl:doc', 0, 'foo', 0, 'zap', 0, 'zip', 0, 'ALPHA', 0, 'alpha');
    expect(await t.call('ZRANGE', 'zrrl:doc', 0, -1)).toEqual(['ALPHA', 'aaaa', 'alpha', 'b', 'c', 'd', 'e', 'foo', 'zap', 'zip']);
    expect(await t.call('ZREMRANGEBYLEX', 'zrrl:doc', '[alpha', '[omega')).toBe(6);
    expect(await t.call('ZRANGE', 'zrrl:doc', 0, -1)).toEqual(['ALPHA', 'aaaa', 'zap', 'zip']);
    expect.soft(await err(t.call('ZREMRANGEBYLEX', 'zrrl:doc', 'alpha', '+'))).toBe(LEX_RANGE);
    expect.soft(await err(t.call('ZREMRANGEBYLEX', 'zrrl:doc', '-'))).toBe(arity('zremrangebylex'));
  });

  it('WRONGTYPE', async () => {
    await t.call('SET', 'zrr:str', 'x');
    expect.soft(await err(t.call('ZREMRANGEBYSCORE', 'zrr:str', 0, 1))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('ZREMRANGEBYRANK', 'zrr:str', 0, 1))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('ZREMRANGEBYLEX', 'zrr:str', '-', '+'))).toBe(WRONGTYPE);
  });
});

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
    await sleep(50);
    await t.call('ZADD', 'bz:w2', 5, 'x', 3, 'y');
    expect(await p).toEqual(['bz:w2', 'y', '3']);
    expect(await t.call('ZRANGE', 'bz:w2', 0, -1)).toEqual(['x']);

    const c2 = t.client();
    const p2 = c2.call('BZPOPMAX', 'bz:w3', '5');
    await sleep(50);
    await t.call('ZADD', 'bz:w3', 1, 'a', 9, 'z');
    expect(await p2).toEqual(['bz:w3', 'z', '9']);

    const c3 = t.client();
    const p3 = c3.call('BZMPOP', '0', '2', 'bz:w4', 'bz:w5', 'MAX', 'COUNT', '2');
    await sleep(50);
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

// ─────────────────────────── set algebra ───────────────────────────
describe('ZUNION / ZUNIONSTORE', () => {
  it('docs examples', async () => {
    await t.call('ZADD', 'zu:1', 1, 'one', 2, 'two');
    await t.call('ZADD', 'zu:2', 1, 'one', 2, 'two', 3, 'three');
    expect(await t.call('ZUNION', 2, 'zu:1', 'zu:2')).toEqual(['one', 'three', 'two']);
    expect(await t.call('ZUNION', 2, 'zu:1', 'zu:2', 'WITHSCORES')).toEqual(['one', '2', 'three', '3', 'two', '4']);
    expect(await t.call('ZUNIONSTORE', 'zu:out', 2, 'zu:1', 'zu:2', 'WEIGHTS', 2, 3)).toBe(3);
    expect(await t.call('ZRANGE', 'zu:out', 0, -1, 'WITHSCORES')).toEqual(['one', '5', 'three', '9', 'two', '10']);
  });

  it('AGGREGATE, sets as inputs, missing keys', async () => {
    await t.call('ZADD', 'zu:a', 1, 'x', 5, 'y');
    await t.call('ZADD', 'zu:b', 3, 'x', 2, 'y');
    await t.call('SADD', 'zu:set', 'x', 'z');
    expect(await t.call('ZUNION', 2, 'zu:a', 'zu:b', 'AGGREGATE', 'MIN', 'WITHSCORES')).toEqual(['x', '1', 'y', '2']);
    expect(await t.call('ZUNION', 2, 'zu:a', 'zu:b', 'AGGREGATE', 'MAX', 'WITHSCORES')).toEqual(['x', '3', 'y', '5']);
    expect(await t.call('ZUNION', 2, 'zu:a', 'zu:b', 'aggregate', 'sum', 'WITHSCORES')).toEqual(['x', '4', 'y', '7']);
    expect(await t.call('ZUNION', 2, 'zu:a', 'zu:set', 'WITHSCORES')).toEqual(['z', '1', 'x', '2', 'y', '5']);
    expect(await t.call('ZUNION', 3, 'zu:a', 'zu:nope', 'zu:set', 'WEIGHTS', 2, 100, 0.5, 'WITHSCORES')).toEqual(['z', '0.5', 'x', '2.5', 'y', '10']);
    expect(await t.call('ZUNION', 1, 'zu:nope')).toEqual([]);
    expect(await t.call('ZUNIONSTORE', 'zu:empty', 1, 'zu:nope')).toBe(0);
    expect(await t.call('EXISTS', 'zu:empty')).toBe(0);
    expect(await t.call('ZUNIONSTORE', 'zu:a', 2, 'zu:a', 'zu:b')).toBe(2);
    expect(await t.call('ZRANGE', 'zu:a', 0, -1, 'WITHSCORES')).toEqual(['x', '4', 'y', '7']);
  });

  it('inf + -inf aggregates to 0', async () => {
    await t.call('ZADD', 'zu:pinf', 'inf', 'm');
    await t.call('ZADD', 'zu:ninf', '-inf', 'm');
    expect(await t.call('ZUNION', 2, 'zu:pinf', 'zu:ninf', 'WITHSCORES')).toEqual(['m', '0']);
  });

  it('errors', async () => {
    await t.call('ZADD', 'zu:e', 1, 'a');
    expect.soft(await err(t.call('ZUNION', 0, 'zu:e'))).toBe("ERR at least 1 input key is needed for 'zunion' command");
    expect.soft(await err(t.call('ZUNIONSTORE', 'zu:d', 0, 'zu:e'))).toBe("ERR at least 1 input key is needed for 'zunionstore' command");
    expect.soft(await err(t.call('ZUNION', 3, 'zu:e', 'zu:e'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZUNION', 'x', 'zu:e'))).toBe(NOT_INT);
    expect.soft(await err(t.call('ZUNION', 1, 'zu:e', 'WEIGHTS', 'a'))).toBe('ERR weight value is not a float');
    expect.soft(await err(t.call('ZUNION', 2, 'zu:e', 'zu:e', 'WEIGHTS', 1))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZUNION', 1, 'zu:e', 'AGGREGATE', 'AVG'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZUNION', 1, 'zu:e', 'FOO'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZUNIONSTORE', 'zu:d', 1, 'zu:e', 'WITHSCORES'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZUNION', 1))).toBe(arity('zunion'));
    expect.soft(await err(t.call('ZUNIONSTORE', 'zu:d', 1))).toBe(arity('zunionstore'));
    await t.call('SET', 'zu:str', 'x');
    expect.soft(await err(t.call('ZUNION', 2, 'zu:e', 'zu:str'))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('ZUNIONSTORE', 'zu:d', 2, 'zu:e', 'zu:str'))).toBe(WRONGTYPE);
  });

  it('RESP3 WITHSCORES pairs', async () => {
    await t.call('ZADD', 'zu:r3a', 1, 'a');
    await t.call('ZADD', 'zu:r3b', 1.5, 'a', 2, 'b');
    const r = await resp3();
    expect.soft(await r.send('ZUNION', 2, 'zu:r3a', 'zu:r3b', 'WITHSCORES')).toBe('*2\r\n*2\r\n$1\r\nb\r\n,2\r\n*2\r\n$1\r\na\r\n,2.5\r\n');
    expect.soft(await r.send('ZINTER', 2, 'zu:r3a', 'zu:r3b', 'WITHSCORES')).toBe('*1\r\n*2\r\n$1\r\na\r\n,2.5\r\n');
    expect.soft(await r.send('ZDIFF', 2, 'zu:r3b', 'zu:r3a', 'WITHSCORES')).toBe('*1\r\n*2\r\n$1\r\nb\r\n,2\r\n');
  });
});

describe('ZINTER / ZINTERSTORE / ZINTERCARD', () => {
  it('docs examples', async () => {
    await t.call('ZADD', 'zin:1', 1, 'one', 2, 'two');
    await t.call('ZADD', 'zin:2', 1, 'one', 2, 'two', 3, 'three');
    expect(await t.call('ZINTER', 2, 'zin:1', 'zin:2')).toEqual(['one', 'two']);
    expect(await t.call('ZINTER', 2, 'zin:1', 'zin:2', 'WITHSCORES')).toEqual(['one', '2', 'two', '4']);
    expect(await t.call('ZINTERSTORE', 'zin:out', 2, 'zin:1', 'zin:2', 'WEIGHTS', 2, 3)).toBe(2);
    expect(await t.call('ZRANGE', 'zin:out', 0, -1, 'WITHSCORES')).toEqual(['one', '5', 'two', '10']);
    expect(await t.call('ZINTERCARD', 2, 'zin:1', 'zin:2')).toBe(2);
    expect(await t.call('ZINTERCARD', 2, 'zin:1', 'zin:2', 'LIMIT', 1)).toBe(1);
    expect(await t.call('ZINTERCARD', 2, 'zin:1', 'zin:2', 'LIMIT', 0)).toBe(2);
  });

  it('AGGREGATE, sets as inputs, missing keys', async () => {
    await t.call('SADD', 'zin:set', 'a', 'b');
    await t.call('ZADD', 'zin:z', 2, 'a', 3, 'c');
    expect(await t.call('ZINTERSTORE', 'zin:o2', 2, 'zin:set', 'zin:z')).toBe(1);
    expect(await t.call('ZRANGE', 'zin:o2', 0, -1, 'WITHSCORES')).toEqual(['a', '3']);
    expect(await t.call('ZINTER', 2, 'zin:set', 'zin:z', 'AGGREGATE', 'MAX', 'WITHSCORES')).toEqual(['a', '2']);
    expect(await t.call('ZINTER', 2, 'zin:set', 'zin:z', 'AGGREGATE', 'MIN', 'WITHSCORES')).toEqual(['a', '1']);
    expect(await t.call('ZINTER', 2, 'zin:z', 'zin:nope')).toEqual([]);
    expect(await t.call('ZINTERCARD', 2, 'zin:z', 'zin:nope')).toBe(0);
    expect(await t.call('ZINTERCARD', 2, 'zin:set', 'zin:z')).toBe(1);
    await t.call('SET', 'zin:o3', 'string');
    expect(await t.call('ZINTERSTORE', 'zin:o3', 2, 'zin:z', 'zin:nope')).toBe(0);
    expect(await t.call('EXISTS', 'zin:o3')).toBe(0);
  });

  it('errors', async () => {
    await t.call('ZADD', 'zin:e', 1, 'a');
    expect.soft(await err(t.call('ZINTER', 0, 'zin:e'))).toBe("ERR at least 1 input key is needed for 'zinter' command");
    expect.soft(await err(t.call('ZINTERSTORE', 'zin:d', 0, 'zin:e'))).toBe("ERR at least 1 input key is needed for 'zinterstore' command");
    expect.soft(await err(t.call('ZINTER', 1, 'zin:e', 'WEIGHTS', 1, 2))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZINTERCARD', 0, 'zin:e'))).toBe("ERR at least 1 input key is needed for 'zintercard' command"); // unverified: may be 'numkeys should be greater than 0'
    expect.soft(await err(t.call('ZINTERCARD', 1, 'zin:e', 'LIMIT', -1))).toBe("ERR LIMIT can't be negative");
    expect.soft(await err(t.call('ZINTERCARD', 1, 'zin:e', 'LIMIT'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZINTERCARD', 1, 'zin:e', 'WITHSCORES'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZINTERCARD', 1, 'zin:e', 'AGGREGATE', 'MAX'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZINTERCARD', 1))).toBe(arity('zintercard'));
    await t.call('SET', 'zin:str', 'x');
    expect.soft(await err(t.call('ZINTER', 2, 'zin:e', 'zin:str'))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('ZINTERCARD', 2, 'zin:e', 'zin:str'))).toBe(WRONGTYPE);
  });
});

describe('ZDIFF / ZDIFFSTORE', () => {
  it('docs examples', async () => {
    await t.call('ZADD', 'zd:1', 1, 'one', 2, 'two', 3, 'three');
    await t.call('ZADD', 'zd:2', 1, 'one', 2, 'two');
    expect(await t.call('ZDIFF', 2, 'zd:1', 'zd:2')).toEqual(['three']);
    expect(await t.call('ZDIFF', 2, 'zd:1', 'zd:2', 'WITHSCORES')).toEqual(['three', '3']);
    expect(await t.call('ZDIFFSTORE', 'zd:out', 2, 'zd:1', 'zd:2')).toBe(1);
    expect(await t.call('ZRANGE', 'zd:out', 0, -1, 'WITHSCORES')).toEqual(['three', '3']);
  });

  it('sets as inputs, missing keys', async () => {
    await t.call('ZADD', 'zd:a', 1, 'x', 2, 'y', 3, 'z');
    await t.call('SADD', 'zd:set', 'y');
    expect(await t.call('ZDIFF', 2, 'zd:a', 'zd:set', 'WITHSCORES')).toEqual(['x', '1', 'z', '3']);
    expect(await t.call('ZDIFF', 2, 'zd:set', 'zd:nope', 'WITHSCORES')).toEqual(['y', '1']);
    expect(await t.call('ZDIFF', 1, 'zd:nope')).toEqual([]);
    expect(await t.call('ZDIFFSTORE', 'zd:o', 2, 'zd:nope', 'zd:a')).toBe(0);
    expect(await t.call('EXISTS', 'zd:o')).toBe(0);
  });

  it('errors', async () => {
    await t.call('ZADD', 'zd:e', 1, 'a');
    expect.soft(await err(t.call('ZDIFF', 1, 'zd:e', 'WEIGHTS', 1))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZDIFF', 1, 'zd:e', 'AGGREGATE', 'MIN'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZDIFF', 0, 'zd:e'))).toBe("ERR at least 1 input key is needed for 'zdiff' command");
    expect.soft(await err(t.call('ZDIFFSTORE', 'zd:d', 1, 'zd:e', 'WITHSCORES'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZDIFF', 1))).toBe(arity('zdiff'));
    await t.call('SET', 'zd:str', 'x');
    expect.soft(await err(t.call('ZDIFF', 2, 'zd:e', 'zd:str'))).toBe(WRONGTYPE);
  });
});

// ─────────────────────────── scan / random ───────────────────────────
describe('ZSCAN', () => {
  it('small set returns everything with cursor 0', async () => {
    await t.call('ZADD', 'zsc:a', 1, 'one', 2.5, 'two', 3, 'three');
    expect(await t.call('ZSCAN', 'zsc:a', 0)).toEqual(['0', ['one', '1', 'two', '2.5', 'three', '3']]);
    expect(await t.call('ZSCAN', 'zsc:a', 0, 'MATCH', 't*')).toEqual(['0', ['two', '2.5', 'three', '3']]);
    expect(await t.call('ZSCAN', 'zsc:a', 0, 'COUNT', 1)).toEqual(['0', ['one', '1', 'two', '2.5', 'three', '3']]);
    expect(await t.call('ZSCAN', 'zsc:missing', 0)).toEqual(['0', []]);
  });

  it('NOSCORES (Redis 8.0+)', async () => {
    await t.call('ZADD', 'zsc:ns', 1, 'one', 2, 'two');
    expect(await t.call('ZSCAN', 'zsc:ns', 0, 'NOSCORES')).toEqual(['0', ['one', 'two']]);
  });

  it('large set iterates fully', async () => {
    const args: Array<string | number> = [];
    for (let i = 0; i < 300; i++) args.push(i, `m${i}`);
    await t.call('ZADD', 'zsc:big', ...args);
    const seen = new Map<string, string>();
    let cursor = '0';
    do {
      const [next, items] = (await t.call('ZSCAN', 'zsc:big', cursor, 'COUNT', 50)) as [string, string[]];
      for (let i = 0; i < items.length; i += 2) seen.set(items[i]!, items[i + 1]!);
      cursor = next;
    } while (cursor !== '0');
    expect(seen.size).toBe(300);
    expect(seen.get('m42')).toBe('42');
  });

  it('errors', async () => {
    await t.call('ZADD', 'zsc:e', 1, 'a');
    expect.soft(await err(t.call('ZSCAN', 'zsc:e', 'abc'))).toBe('ERR invalid cursor');
    expect.soft(await err(t.call('ZSCAN', 'zsc:e', 0, 'COUNT', 0))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZSCAN', 'zsc:e', 0, 'COUNT', 'x'))).toBe(NOT_INT);
    expect.soft(await err(t.call('ZSCAN', 'zsc:e', 0, 'MATCH'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZSCAN', 'zsc:e', 0, 'FOO', 'x'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZSCAN', 'zsc:e'))).toBe(arity('zscan'));
    await t.call('SET', 'zsc:str', 'x');
    expect.soft(await err(t.call('ZSCAN', 'zsc:str', 0))).toBe(WRONGTYPE);
  });

  it('RESP3 keeps scores as bulk strings', async () => {
    // unverified: ZSCAN scores are bulk strings in RESP3 (scan replies are not typed)
    await t.call('ZADD', 'zsc:r3', 1.5, 'a');
    const r = await resp3();
    expect.soft(await r.send('ZSCAN', 'zsc:r3', 0)).toBe('*2\r\n$1\r\n0\r\n*2\r\n$1\r\na\r\n$3\r\n1.5\r\n');
  });
});

describe('ZRANDMEMBER', () => {
  it('docs example shapes', async () => {
    await t.call('ZADD', 'zrm:dadi', 1, 'uno', 2, 'due', 3, 'tre', 4, 'quattro', 5, 'cinque', 6, 'sei');
    const all = ['uno', 'due', 'tre', 'quattro', 'cinque', 'sei'];
    expect(all).toContain(await t.call('ZRANDMEMBER', 'zrm:dadi'));
    const neg = (await t.call('ZRANDMEMBER', 'zrm:dadi', -5, 'WITHSCORES')) as string[];
    expect(neg.length).toBe(10);
    for (let i = 0; i < neg.length; i += 2) {
      expect(all).toContain(neg[i]);
      expect(neg[i + 1]).toBe(String(all.indexOf(neg[i]!) + 1));
    }
  });

  it('positive count is distinct and capped, negative may repeat', async () => {
    await t.call('ZADD', 'zrm:a', 1, 'a', 2, 'b', 3, 'c');
    const pos = (await t.call('ZRANDMEMBER', 'zrm:a', 10)) as string[];
    expect([...pos].sort()).toEqual(['a', 'b', 'c']);
    const two = (await t.call('ZRANDMEMBER', 'zrm:a', 2)) as string[];
    expect(new Set(two).size).toBe(2);
    expect(((await t.call('ZRANDMEMBER', 'zrm:a', -20)) as string[]).length).toBe(20);
    expect(await t.call('ZRANDMEMBER', 'zrm:a', 0)).toEqual([]);
    expect(await t.call('ZRANDMEMBER', 'zrm:missing')).toBeNull();
    expect(await t.call('ZRANDMEMBER', 'zrm:missing', 5)).toEqual([]);
    expect(await t.call('ZRANDMEMBER', 'zrm:missing', 5, 'WITHSCORES')).toEqual([]);
  });

  it('errors', async () => {
    await t.call('ZADD', 'zrm:e', 1, 'a');
    expect.soft(await err(t.call('ZRANDMEMBER', 'zrm:e', 'x'))).toBe(NOT_INT);
    expect.soft(await err(t.call('ZRANDMEMBER', 'zrm:e', 1, 'FOO'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANDMEMBER', 'zrm:e', 1, 'WITHSCORES', 'x'))).toBe(SYNTAX);
    expect.soft(await err(t.call('ZRANDMEMBER'))).toBe(arity('zrandmember'));
    await t.call('SET', 'zrm:str', 'x');
    expect.soft(await err(t.call('ZRANDMEMBER', 'zrm:str'))).toBe(WRONGTYPE);
  });

  it('RESP3 WITHSCORES pairs', async () => {
    await t.call('ZADD', 'zrm:r3', 1.5, 'a');
    const r = await resp3();
    expect.soft(await r.send('ZRANDMEMBER', 'zrm:r3', 1, 'WITHSCORES')).toBe('*1\r\n*2\r\n$1\r\na\r\n,1.5\r\n');
    expect.soft(await r.send('ZRANDMEMBER', 'zrm:r3')).toBe('$1\r\na\r\n');
    expect.soft(await r.send('ZRANDMEMBER', 'zrm:none')).toBe('_\r\n');
  });
});
