import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * Sorted sets: ZREM, ZCARD, ZSCORE, ZMSCORE, ZCOUNT, ZLEXCOUNT, ZRANK, ZSCAN, ZRANDMEMBER (zsets.query.service; ZREM is zsets.write.service).
 * Expected values come from the redis.io command docs (and their examples) and Redis error strings; anything not
 * certain is marked `// unverified:`.
 */
const t = useServer();

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const SYNTAX = 'ERR syntax error';

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

// ─────────────────────────── ranks ───────────────────────────
describe('ZRANK / ZREVRANK', () => {
  it('ZRANK docs examples', async () => {
    await seed123('zrk:doc');
    expect(await t.call('ZRANK', 'zrk:doc', 'three')).toBe(2);
    expect(await t.call('ZRANK', 'zrk:doc', 'four')).toBeNull();
    expect(await t.call('ZRANK', 'zrk:missing', 'a')).toBeNull();
  });

  it('ZREVRANK docs examples', async () => {
    await seed123('zrrk:doc');
    expect(await t.call('ZREVRANK', 'zrrk:doc', 'one')).toBe(2);
    expect(await t.call('ZREVRANK', 'zrrk:doc', 'four')).toBeNull();
  });

  it('wire shapes: null bulk, RESP3 null', async () => {
    await t.call('ZADD', 'zrk:wire', 1.5, 'a');
    const r = await t.raw();
    expect.soft(await r.send('ZRANK', 'zrk:wire', 'x')).toBe('$-1\r\n');
    const r3 = await resp3();
    expect.soft(await r3.send('ZRANK', 'zrk:wire', 'x')).toBe('_\r\n');
    expect.soft(await r3.send('ZREVRANK', 'zrk:wire', 'x')).toBe('_\r\n');
  });

  it('errors', async () => {
    await seed123('zrk:e');
    expect.soft(await err(t.call('ZRANK', 'zrk:e', 'one', 'WITHSCORE'))).toBe(arity('zrank'));
    expect.soft(await err(t.call('ZREVRANK', 'zrk:e', 'one', 'WITHSCORE'))).toBe(arity('zrevrank'));
    expect.soft(await err(t.call('ZRANK', 'zrk:e'))).toBe(arity('zrank'));
    expect.soft(await err(t.call('ZREVRANK', 'zrk:e'))).toBe(arity('zrevrank'));
    await t.call('SET', 'zrk:str', 'x');
    expect.soft(await err(t.call('ZRANK', 'zrk:str', 'a'))).toBe(WRONGTYPE);
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

  it('NOSCORES is a syntax error (Redis 7.0)', async () => {
    await t.call('ZADD', 'zsc:ns', 1, 'one', 2, 'two');
    expect(await err(t.call('ZSCAN', 'zsc:ns', 0, 'NOSCORES'))).toBe(SYNTAX);
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
