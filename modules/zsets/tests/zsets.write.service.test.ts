import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * Sorted sets: ZADD, ZINCRBY, score formatting and encodings (zsets.write.service).
 * Expected values come from the redis.io command docs (and their examples) and Redis error strings; anything not
 * certain is marked `// unverified:`.
 */
const t = useServer();

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const SYNTAX = 'ERR syntax error';

const NOT_FLOAT = 'ERR value is not a valid float';

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

  it('-0: a listpack stores it as 0, a skiplist keeps it; a new member replies the increment itself', async () => {
    await t.call('ZADD', 'z:neg0', '-0', 'a');
    expect(await t.call('ZSCORE', 'z:neg0', 'a')).toBe('0');
    const r = await t.raw();
    expect(await r.send('ZINCRBY', 'z:neg0', '-0', 'b')).toBe('$2\r\n-0\r\n');
    expect(await t.call('ZSCORE', 'z:neg0', 'b')).toBe('0');
    await t.call('CONFIG', 'SET', 'zset-max-listpack-entries', '0');
    try {
      await t.call('ZADD', 'z:neg0-sk', '-0', 'a');
      expect(await t.call('ZSCORE', 'z:neg0-sk', 'a')).toBe('-0');
    } finally {
      await t.call('CONFIG', 'SET', 'zset-max-listpack-entries', '128');
    }
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
