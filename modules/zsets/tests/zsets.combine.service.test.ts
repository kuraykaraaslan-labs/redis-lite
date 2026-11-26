import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * Sorted sets: ZUNION, ZINTER, ZDIFF (+STORE), ZINTERCARD (zsets.combine.service).
 * Expected values come from the redis.io command docs (and their examples) and Redis error strings; anything not
 * certain is marked `// unverified:`.
 */
const t = useServer();

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const SYNTAX = 'ERR syntax error';

const NOT_INT = 'ERR value is not an integer or out of range';

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
    // a NaN weighted score (0 × inf) is 0 before it is aggregated
    await t.call('ZADD', 'zu:zero', 0, 'm');
    expect(await t.call('ZUNION', 2, 'zu:zero', 'zu:pinf', 'WEIGHTS', 'inf', 1, 'WITHSCORES')).toEqual(['m', 'inf']);
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
