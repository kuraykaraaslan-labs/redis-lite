import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * Sorted sets: the ZRANGE family, ZRANGESTORE, ZREMRANGEBY* (zsets.range.service).
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
