import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';

/**
 * Lists. Expected values come from the redis.io command docs / Redis source
 * semantics (Redis Open Source 8.x), not from redis-lite output.
 */
const t = useServer();

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const NOT_INT = 'ERR value is not an integer or out of range';

const SYNTAX = 'ERR syntax error';

const enc = (key: string) => t.call('OBJECT', 'ENCODING', key);

const resp3 = async () => {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
};

/** Asserts that every command rejects with WRONGTYPE against a string key. */
async function expectWrongType(key: string, cmds: Array<Array<string | number>>) {
  await t.call('SET', key, 'str');
  for (const c of cmds) {
    await expect(t.call(...c), c.join(' ')).rejects.toThrow(WRONGTYPE);
  }
}

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */
describe('lists: push / pop / basic reads', () => {
  it('LPUSH / RPUSH / LPUSHX / RPUSHX', async () => {
    expect(await t.call('LPUSH', 'l:push', 'a', 'b', 'c')).toBe(3);
    expect(await t.call('RPUSH', 'l:push', 'x', 'y')).toBe(5);
    expect(await t.call('LRANGE', 'l:push', 0, -1)).toEqual(['c', 'b', 'a', 'x', 'y']);
    expect(await t.call('LPUSHX', 'l:push', 'h')).toBe(6);
    expect(await t.call('RPUSHX', 'l:push', 't', 'u')).toBe(8);
    expect(await t.call('LPUSHX', 'l:pushx-missing', 'a')).toBe(0);
    expect(await t.call('RPUSHX', 'l:pushx-missing', 'a')).toBe(0);
    expect(await t.call('EXISTS', 'l:pushx-missing')).toBe(0);
    await expect(t.call('LPUSH', 'l:push')).rejects.toThrow(arity('lpush'));
    await expect(t.call('RPUSH', 'l:push')).rejects.toThrow(arity('rpush'));
    await expect(t.call('LPUSHX', 'l:push')).rejects.toThrow(arity('lpushx'));
    await expect(t.call('RPUSHX', 'l:push')).rejects.toThrow(arity('rpushx'));
  });

  it('LPOP / RPOP with and without count', async () => {
    await t.call('RPUSH', 'l:pop', 'one', 'two', 'three', 'four', 'five');
    expect(await t.call('LPOP', 'l:pop')).toBe('one');
    expect(await t.call('LPOP', 'l:pop', 2)).toEqual(['two', 'three']);
    expect(await t.call('RPOP', 'l:pop')).toBe('five');
    expect(await t.call('LPOP', 'l:pop', 0)).toEqual([]);
    expect(await t.call('RPOP', 'l:pop', 0)).toEqual([]);
    expect(await t.call('RPOP', 'l:pop', 10)).toEqual(['four']);
    expect(await t.call('EXISTS', 'l:pop')).toBe(0);
    expect(await t.call('LPOP', 'l:pop')).toBeNull();
    expect(await t.call('LPOP', 'l:pop', 2)).toBeNull();
    expect(await t.call('RPOP', 'l:pop', 0)).toBeNull();
    await expect(t.call('LPOP', 'l:pop', -1)).rejects.toThrow('ERR value is out of range, must be positive');
    await expect(t.call('RPOP', 'l:pop', 'x')).rejects.toThrow('ERR value is out of range, must be positive');
    await expect(t.call('RPOP')).rejects.toThrow(arity('rpop'));
  });

  it('LPOP / RPOP with more than one count argument is an arity error', async () => {
    await expect(t.call('LPOP', 'l:pop', 1, 2)).rejects.toThrow(arity('lpop'));
    await expect(t.call('RPOP', 'l:pop', 1, 2)).rejects.toThrow(arity('rpop'));
  });

  it('LPOP wire format: nil array with count on missing key, empty array for count 0', async () => {
    await t.call('RPUSH', 'l:popwire', 'a');
    const r2 = await t.raw();
    expect(await r2.send('LPOP', 'l:popwire-missing')).toBe('$-1\r\n');
    expect(await r2.send('LPOP', 'l:popwire', '0')).toBe('*0\r\n');
    const r3 = await resp3();
    expect(await r3.send('LPOP', 'l:popwire-missing', '1')).toBe('_\r\n');
    expect(await r3.send('RPOP', 'l:popwire-missing')).toBe('_\r\n');
    expect(await r3.send('LPOP', 'l:popwire', '5')).toBe('*1\r\n$1\r\na\r\n');
  });

  it('LPOP / RPOP with count on a missing key reply with a null array in RESP2', async () => {
    const r2 = await t.raw();
    expect(await r2.send('LPOP', 'l:popwire-missing', '1')).toBe('*-1\r\n');
    expect(await r2.send('RPOP', 'l:popwire-missing', '0')).toBe('*-1\r\n');
  });

  it('LLEN / LRANGE / LINDEX', async () => {
    await t.call('RPUSH', 'l:range', 'one', 'two', 'three');
    expect(await t.call('LLEN', 'l:range')).toBe(3);
    expect(await t.call('LLEN', 'l:range-missing')).toBe(0);
    expect(await t.call('LRANGE', 'l:range', 0, 0)).toEqual(['one']);
    expect(await t.call('LRANGE', 'l:range', -3, 2)).toEqual(['one', 'two', 'three']);
    expect(await t.call('LRANGE', 'l:range', -100, 100)).toEqual(['one', 'two', 'three']);
    expect(await t.call('LRANGE', 'l:range', 5, 10)).toEqual([]);
    expect(await t.call('LRANGE', 'l:range', 2, 1)).toEqual([]);
    expect(await t.call('LRANGE', 'l:range-missing', 0, -1)).toEqual([]);
    expect(await t.call('LINDEX', 'l:range', 0)).toBe('one');
    expect(await t.call('LINDEX', 'l:range', -1)).toBe('three');
    expect(await t.call('LINDEX', 'l:range', 3)).toBeNull();
    expect(await t.call('LINDEX', 'l:range-missing', 0)).toBeNull();
    await expect(t.call('LRANGE', 'l:range', 'a', 1)).rejects.toThrow(NOT_INT);
    await expect(t.call('LINDEX', 'l:range', 'a')).rejects.toThrow(NOT_INT);
    await expect(t.call('LRANGE', 'l:range', 0)).rejects.toThrow(arity('lrange'));
    await expect(t.call('LINDEX', 'l:range')).rejects.toThrow(arity('lindex'));
    await expect(t.call('LLEN')).rejects.toThrow(arity('llen'));
  });

  it('LSET', async () => {
    await t.call('RPUSH', 'l:set', 'one', 'two', 'three');
    expect(await t.call('LSET', 'l:set', 0, 'four')).toBe('OK');
    expect(await t.call('LSET', 'l:set', -2, 'five')).toBe('OK');
    expect(await t.call('LRANGE', 'l:set', 0, -1)).toEqual(['four', 'five', 'three']);
    await expect(t.call('LSET', 'l:set', 3, 'x')).rejects.toThrow('ERR index out of range');
    await expect(t.call('LSET', 'l:set', -4, 'x')).rejects.toThrow('ERR index out of range');
    await expect(t.call('LSET', 'l:set-missing', 0, 'x')).rejects.toThrow('ERR no such key');
    await expect(t.call('LSET', 'l:set', 'x', 'x')).rejects.toThrow(NOT_INT);
    await expect(t.call('LSET', 'l:set', 0)).rejects.toThrow(arity('lset'));
  });

  it('LREM with positive, negative and zero count', async () => {
    await t.call('RPUSH', 'l:rem', 'hello', 'hello', 'foo', 'hello');
    expect(await t.call('LREM', 'l:rem', -2, 'hello')).toBe(2);
    expect(await t.call('LRANGE', 'l:rem', 0, -1)).toEqual(['hello', 'foo']);
    await t.call('RPUSH', 'l:rem2', 'a', 'b', 'a', 'c', 'a', 'a');
    expect(await t.call('LREM', 'l:rem2', 2, 'a')).toBe(2);
    expect(await t.call('LRANGE', 'l:rem2', 0, -1)).toEqual(['b', 'c', 'a', 'a']);
    expect(await t.call('LREM', 'l:rem2', 0, 'a')).toBe(2);
    expect(await t.call('LREM', 'l:rem2', 0, 'zz')).toBe(0);
    expect(await t.call('LREM', 'l:rem2', 0, 'b')).toBe(1);
    expect(await t.call('LREM', 'l:rem2', 0, 'c')).toBe(1);
    expect(await t.call('EXISTS', 'l:rem2')).toBe(0);
    expect(await t.call('LREM', 'l:rem-missing', 0, 'a')).toBe(0);
    await expect(t.call('LREM', 'l:rem', 'x', 'a')).rejects.toThrow(NOT_INT);
    await expect(t.call('LREM', 'l:rem', 0)).rejects.toThrow(arity('lrem'));
  });

  it('LTRIM', async () => {
    await t.call('RPUSH', 'l:trim', 'one', 'two', 'three');
    expect(await t.call('LTRIM', 'l:trim', 1, -1)).toBe('OK');
    expect(await t.call('LRANGE', 'l:trim', 0, -1)).toEqual(['two', 'three']);
    expect(await t.call('LTRIM', 'l:trim', 5, 10)).toBe('OK');
    expect(await t.call('EXISTS', 'l:trim')).toBe(0);
    expect(await t.call('LTRIM', 'l:trim-missing', 0, 1)).toBe('OK');
    await t.call('RPUSH', 'l:trim2', 'a', 'b', 'c', 'd');
    expect(await t.call('LTRIM', 'l:trim2', -2, 100)).toBe('OK');
    expect(await t.call('LRANGE', 'l:trim2', 0, -1)).toEqual(['c', 'd']);
    await expect(t.call('LTRIM', 'l:trim2', 'a', 1)).rejects.toThrow(NOT_INT);
    await expect(t.call('LTRIM', 'l:trim2', 0)).rejects.toThrow(arity('ltrim'));
  });

  it('LINSERT', async () => {
    await t.call('RPUSH', 'l:ins', 'Hello', 'World');
    expect(await t.call('LINSERT', 'l:ins', 'BEFORE', 'World', 'There')).toBe(3);
    expect(await t.call('LRANGE', 'l:ins', 0, -1)).toEqual(['Hello', 'There', 'World']);
    expect(await t.call('LINSERT', 'l:ins', 'after', 'World', '!')).toBe(4);
    expect(await t.call('LRANGE', 'l:ins', 0, -1)).toEqual(['Hello', 'There', 'World', '!']);
    expect(await t.call('LINSERT', 'l:ins', 'BEFORE', 'nope', 'x')).toBe(-1);
    expect(await t.call('LINSERT', 'l:ins-missing', 'BEFORE', 'a', 'x')).toBe(0);
    expect(await t.call('EXISTS', 'l:ins-missing')).toBe(0);
    await expect(t.call('LINSERT', 'l:ins', 'MIDDLE', 'World', 'x')).rejects.toThrow(SYNTAX);
    await expect(t.call('LINSERT', 'l:ins', 'BEFORE', 'World')).rejects.toThrow(arity('linsert'));
  });

  it('LPOS with RANK / COUNT / MAXLEN (docs examples)', async () => {
    await t.call('RPUSH', 'l:pos', 'a', 'b', 'c', 'd', '1', '2', '3', '4', '3', '3', '3');
    expect(await t.call('LPOS', 'l:pos', '3')).toBe(6);
    expect(await t.call('LPOS', 'l:pos', '3', 'COUNT', 0, 'RANK', 2)).toEqual([8, 9, 10]);
    await t.call('RPUSH', 'l:pos2', 'a', 'b', 'c', '1', '2', '3', 'c', 'c');
    expect(await t.call('LPOS', 'l:pos2', 'c', 'RANK', 2)).toBe(6);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'RANK', -1)).toBe(7);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'COUNT', 2)).toEqual([2, 6]);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'RANK', -1, 'COUNT', 2)).toEqual([7, 6]);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'COUNT', 0)).toEqual([2, 6, 7]);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'COUNT', 0, 'MAXLEN', 7)).toEqual([2, 6]);
    expect(await t.call('LPOS', 'l:pos2', 'c', 'MAXLEN', 2)).toBeNull();
    expect(await t.call('LPOS', 'l:pos2', 'c', 'MAXLEN', 0)).toBe(2);
    expect(await t.call('LPOS', 'l:pos2', 'zz')).toBeNull();
    expect(await t.call('LPOS', 'l:pos2', 'zz', 'COUNT', 1)).toEqual([]);
    expect(await t.call('LPOS', 'l:pos-missing', 'a')).toBeNull();
    expect(await t.call('LPOS', 'l:pos-missing', 'a', 'COUNT', 1)).toEqual([]);
    await expect(t.call('LPOS', 'l:pos2', 'c', 'RANK', 0)).rejects.toThrow(
      "ERR RANK can't be zero: use 1 to start from the first match, 2 from the second ... or use negative to start from the end of the list",
    );
    await expect(t.call('LPOS', 'l:pos2', 'c', 'COUNT', -1)).rejects.toThrow("ERR COUNT can't be negative");
    await expect(t.call('LPOS', 'l:pos2', 'c', 'FOO', 1)).rejects.toThrow(SYNTAX);
    await expect(t.call('LPOS', 'l:pos2', 'c', 'RANK', 'x')).rejects.toThrow(NOT_INT);
    await expect(t.call('LPOS', 'l:pos2')).rejects.toThrow(arity('lpos'));
  });

  it('LPOS option without a value is a syntax error', async () => {
    await t.call('RPUSH', 'l:pos-syn', 'a');
    await expect(t.call('LPOS', 'l:pos-syn', 'c', 'RANK')).rejects.toThrow(SYNTAX);
    await expect(t.call('LPOS', 'l:pos-syn', 'a', 'COUNT')).rejects.toThrow(SYNTAX);
    await expect(t.call('LPOS', 'l:pos-syn', 'a', 'MAXLEN')).rejects.toThrow(SYNTAX);
  });

  it('LPOS negative MAXLEN', async () => {
    await t.call('RPUSH', 'l:pos-ml', 'a');
    await expect(t.call('LPOS', 'l:pos-ml', 'c', 'MAXLEN', -1)).rejects.toThrow("ERR MAXLEN can't be negative");
  });

  it('LPOS RESP3 null', async () => {
    const r = await resp3();
    expect(await r.send('LPOS', 'l:pos3-missing', 'a')).toBe('_\r\n');
    const r2 = await t.raw();
    expect(await r2.send('LPOS', 'l:pos3-missing', 'a')).toBe('$-1\r\n');
  });
});

describe('lists: moves and multi-pop', () => {
  it('LMOVE (docs example) and same-key rotation', async () => {
    await t.call('RPUSH', 'l:mv', 'one', 'two', 'three');
    expect(await t.call('LMOVE', 'l:mv', 'l:mv-dst', 'RIGHT', 'LEFT')).toBe('three');
    expect(await t.call('LMOVE', 'l:mv', 'l:mv-dst', 'LEFT', 'RIGHT')).toBe('one');
    expect(await t.call('LRANGE', 'l:mv', 0, -1)).toEqual(['two']);
    expect(await t.call('LRANGE', 'l:mv-dst', 0, -1)).toEqual(['three', 'one']);
    await t.call('RPUSH', 'l:rot', 'a', 'b', 'c');
    expect(await t.call('LMOVE', 'l:rot', 'l:rot', 'LEFT', 'RIGHT')).toBe('a');
    expect(await t.call('LRANGE', 'l:rot', 0, -1)).toEqual(['b', 'c', 'a']);
    expect(await t.call('LMOVE', 'l:mv-missing', 'l:mv-dst', 'LEFT', 'LEFT')).toBeNull();
    expect(await t.call('LMOVE', 'l:mv', 'l:mv-dst', 'left', 'left')).toBe('two');
    expect(await t.call('EXISTS', 'l:mv')).toBe(0);
    await expect(t.call('LMOVE', 'l:mv-dst', 'x', 'UP', 'LEFT')).rejects.toThrow(SYNTAX);
    await expect(t.call('LMOVE', 'l:mv-dst', 'x', 'LEFT')).rejects.toThrow(arity('lmove'));
    // wrong-type destination leaves the source untouched
    await t.call('SET', 'l:mv-str', 'v');
    await expect(t.call('LMOVE', 'l:mv-dst', 'l:mv-str', 'LEFT', 'LEFT')).rejects.toThrow(WRONGTYPE);
    expect(await t.call('LLEN', 'l:mv-dst')).toBe(3);
  });

  it('RPOPLPUSH', async () => {
    await t.call('RPUSH', 'l:rpl', 'one', 'two', 'three');
    expect(await t.call('RPOPLPUSH', 'l:rpl', 'l:rpl-dst')).toBe('three');
    expect(await t.call('LRANGE', 'l:rpl', 0, -1)).toEqual(['one', 'two']);
    expect(await t.call('LRANGE', 'l:rpl-dst', 0, -1)).toEqual(['three']);
    expect(await t.call('RPOPLPUSH', 'l:rpl', 'l:rpl')).toBe('two');
    expect(await t.call('LRANGE', 'l:rpl', 0, -1)).toEqual(['two', 'one']);
    expect(await t.call('RPOPLPUSH', 'l:rpl-missing', 'l:rpl-dst')).toBeNull();
    await expect(t.call('RPOPLPUSH', 'l:rpl')).rejects.toThrow(arity('rpoplpush'));
  });

  it('LMPOP (docs example) and errors', async () => {
    expect(await t.call('LMPOP', 2, 'l:mp-non1', 'l:mp-non2', 'LEFT', 'COUNT', 10)).toBeNull();
    await t.call('LPUSH', 'l:mp', 'one', 'two', 'three', 'four', 'five');
    expect(await t.call('LMPOP', 1, 'l:mp', 'LEFT')).toEqual(['l:mp', ['five']]);
    expect(await t.call('LRANGE', 'l:mp', 0, -1)).toEqual(['four', 'three', 'two', 'one']);
    expect(await t.call('LMPOP', 1, 'l:mp', 'RIGHT', 'COUNT', 10)).toEqual(['l:mp', ['one', 'two', 'three', 'four']]);
    expect(await t.call('EXISTS', 'l:mp')).toBe(0);
    await t.call('LPUSH', 'l:mp2', 'a', 'b', 'c');
    await t.call('LPUSH', 'l:mp3', 'x');
    expect(await t.call('LMPOP', 3, 'l:mp-non1', 'l:mp2', 'l:mp3', 'RIGHT', 'COUNT', 2)).toEqual(['l:mp2', ['a', 'b']]);
    await expect(t.call('LMPOP', 0, 'l:mp2', 'LEFT')).rejects.toThrow('ERR numkeys should be greater than 0');
    await expect(t.call('LMPOP', 1, 'l:mp2', 'UP')).rejects.toThrow(SYNTAX);
    await expect(t.call('LMPOP', 1, 'l:mp2', 'LEFT', 'COUNT', 0)).rejects.toThrow('ERR count should be greater than 0');
    await expect(t.call('LMPOP', 1, 'l:mp2', 'LEFT', 'COUNT')).rejects.toThrow(SYNTAX);
    await expect(t.call('LMPOP', 1, 'l:mp2', 'LEFT', 'FOO', 1)).rejects.toThrow(SYNTAX);
    await expect(t.call('LMPOP', 1, 'l:mp2')).rejects.toThrow(arity('lmpop'));
  });

  it('LMPOP RESP3 shape and nil', async () => {
    await t.call('RPUSH', 'l:mp3r', 'a');
    const r = await resp3();
    expect(await r.send('LMPOP', '1', 'l:mp3r', 'LEFT')).toBe('*2\r\n$6\r\nl:mp3r\r\n*1\r\n$1\r\na\r\n');
    expect(await r.send('LMPOP', '1', 'l:mp3r', 'LEFT')).toBe('_\r\n');
    const r2 = await t.raw();
    expect(await r2.send('LMPOP', '1', 'l:mp3r', 'LEFT')).toBe('*-1\r\n');
  });

  it('WRONGTYPE for every list command', async () => {
    await expectWrongType('l:wt', [
      ['LPUSH', 'l:wt', 'a'],
      ['RPUSH', 'l:wt', 'a'],
      ['LPUSHX', 'l:wt', 'a'],
      ['RPUSHX', 'l:wt', 'a'],
      ['LPOP', 'l:wt'],
      ['RPOP', 'l:wt', 2],
      ['LLEN', 'l:wt'],
      ['LRANGE', 'l:wt', 0, -1],
      ['LINDEX', 'l:wt', 0],
      ['LSET', 'l:wt', 0, 'a'],
      ['LREM', 'l:wt', 0, 'a'],
      ['LTRIM', 'l:wt', 0, 1],
      ['LINSERT', 'l:wt', 'BEFORE', 'a', 'b'],
      ['LPOS', 'l:wt', 'a'],
      ['LMOVE', 'l:wt', 'l:wt-d', 'LEFT', 'LEFT'],
      ['RPOPLPUSH', 'l:wt', 'l:wt-d'],
      ['LMPOP', 1, 'l:wt', 'LEFT'],
      ['BLPOP', 'l:wt', 0],
      ['BRPOP', 'l:wt', 0],
      ['BLMOVE', 'l:wt', 'l:wt-d', 'LEFT', 'LEFT', 0],
      ['BRPOPLPUSH', 'l:wt', 'l:wt-d', 0],
      ['BLMPOP', 0, 1, 'l:wt', 'LEFT'],
    ]);
  });
});

describe('lists: blocking', () => {
  it('BLPOP / BRPOP return immediately when data exists, first non-empty key wins', async () => {
    await t.call('RPUSH', 'l:b-k2', 'a', 'b', 'c');
    expect(await t.call('BLPOP', 'l:b-k1', 'l:b-k2', 0)).toEqual(['l:b-k2', 'a']);
    expect(await t.call('BRPOP', 'l:b-k1', 'l:b-k2', 0)).toEqual(['l:b-k2', 'c']);
  });

  it('BLPOP blocks until another client pushes', async () => {
    const c = t.client();
    const p = c.call('BLPOP', 'l:b-wait', '0');
    await sleep(50);
    expect(await t.call('RPUSH', 'l:b-wait', 'x', 'y')).toBe(2);
    expect(await p).toEqual(['l:b-wait', 'x']);
    expect(await t.call('LRANGE', 'l:b-wait', 0, -1)).toEqual(['y']);
  });

  it('BRPOP blocks until another client pushes', async () => {
    const c = t.client();
    const p = c.call('BRPOP', 'l:b-wait2', 'l:b-wait3', '0');
    await sleep(50);
    await t.call('RPUSH', 'l:b-wait3', 'x', 'y');
    expect(await p).toEqual(['l:b-wait3', 'y']);
  });

  it('waiters are served FIFO', async () => {
    const c1 = t.client();
    const c2 = t.client();
    const c3 = t.client();
    const p1 = c1.call('BLPOP', 'l:b-fifo', '0');
    await sleep(30);
    const p2 = c2.call('BLPOP', 'l:b-fifo', '0');
    await sleep(30);
    const p3 = c3.call('BLPOP', 'l:b-fifo', '0');
    await sleep(30);
    await t.call('RPUSH', 'l:b-fifo', 'a', 'b');
    expect(await p1).toEqual(['l:b-fifo', 'a']);
    expect(await p2).toEqual(['l:b-fifo', 'b']);
    await t.call('RPUSH', 'l:b-fifo', 'c');
    expect(await p3).toEqual(['l:b-fifo', 'c']);
    expect(await t.call('EXISTS', 'l:b-fifo')).toBe(0);
  });

  it('timeout returns nil; float timeouts are accepted', async () => {
    const start = Date.now();
    expect(await t.call('BLPOP', 'l:b-to', '0.1')).toBeNull();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1000);
    expect(await t.call('BRPOP', 'l:b-to', '0.05')).toBeNull();
    expect(await t.call('BLMOVE', 'l:b-to', 'l:b-to2', 'LEFT', 'LEFT', '0.05')).toBeNull();
    expect(await t.call('BRPOPLPUSH', 'l:b-to', 'l:b-to2', '0.05')).toBeNull();
    expect(await t.call('BLMPOP', '0.05', 1, 'l:b-to', 'LEFT')).toBeNull();
  });

  it('timeout wire format: null array in RESP2, _ in RESP3', async () => {
    const r2 = await t.raw();
    expect(await r2.send('BLPOP', 'l:b-tow', '0.05')).toBe('*-1\r\n');
    expect(await r2.send('BLMPOP', '0.05', '1', 'l:b-tow', 'LEFT')).toBe('*-1\r\n');
    const r3 = await resp3();
    expect(await r3.send('BLPOP', 'l:b-tow', '0.05')).toBe('_\r\n');
    expect(await r3.send('BLMOVE', 'l:b-tow', 'l:b-tow2', 'LEFT', 'LEFT', '0.05')).toBe('_\r\n');
  });

  it('BRPOPLPUSH / BLMOVE timeout is a null array in RESP2 too', async () => {
    // Redis replyToBlockedClientTimedOut sends a null array for every list-blocking command
    const r2 = await t.raw();
    expect(await r2.send('BRPOPLPUSH', 'l:b-tow', 'l:b-tow2', '0.05')).toBe('*-1\r\n');
    expect(await r2.send('BLMOVE', 'l:b-tow', 'l:b-tow2', 'LEFT', 'LEFT', '0.05')).toBe('*-1\r\n');
  });

  it('timeout errors', async () => {
    await expect(t.call('BLPOP', 'l:b-err', -1)).rejects.toThrow('ERR timeout is negative');
    await expect(t.call('BRPOP', 'l:b-err', 'abc')).rejects.toThrow('ERR timeout is not a float or out of range');
    await expect(t.call('BLMOVE', 'l:b-err', 'x', 'LEFT', 'LEFT', -1)).rejects.toThrow('ERR timeout is negative');
    await expect(t.call('BRPOPLPUSH', 'l:b-err', 'x', 'abc')).rejects.toThrow('ERR timeout is not a float or out of range');
    await expect(t.call('BLMPOP', -1, 1, 'l:b-err', 'LEFT')).rejects.toThrow('ERR timeout is negative');
    await expect(t.call('BLPOP', 'l:b-err')).rejects.toThrow(arity('blpop'));
    await expect(t.call('BLMOVE', 'l:b-err', 'x', 'LEFT', 'LEFT')).rejects.toThrow(arity('blmove'));
    await expect(t.call('BRPOPLPUSH', 'l:b-err', 'x')).rejects.toThrow(arity('brpoplpush'));
    await expect(t.call('BLMPOP', 0, 1, 'l:b-err')).rejects.toThrow(arity('blmpop'));
    await expect(t.call('BLMOVE', 'l:b-err', 'x', 'UP', 'LEFT', 0)).rejects.toThrow(SYNTAX);
    await expect(t.call('BLMPOP', 0, 0, 'l:b-err', 'LEFT')).rejects.toThrow('ERR numkeys should be greater than 0');
  });

  it('BLMOVE / BRPOPLPUSH block and wake', async () => {
    const c = t.client();
    const p = c.call('BLMOVE', 'l:b-mv', 'l:b-mv-dst', 'RIGHT', 'LEFT', '0');
    await sleep(50);
    await t.call('RPUSH', 'l:b-mv', 'a', 'b');
    expect(await p).toBe('b');
    expect(await t.call('LRANGE', 'l:b-mv-dst', 0, -1)).toEqual(['b']);
    const p2 = c.call('BRPOPLPUSH', 'l:b-rpl', 'l:b-rpl-dst', '0');
    await sleep(50);
    await t.call('LPUSH', 'l:b-rpl', 'z');
    expect(await p2).toBe('z');
    expect(await t.call('LRANGE', 'l:b-rpl-dst', 0, -1)).toEqual(['z']);
    expect(await t.call('EXISTS', 'l:b-rpl')).toBe(0);
  });

  it('BLMPOP blocks and wakes with count', async () => {
    const c = t.client();
    const p = c.call('BLMPOP', '0', '2', 'l:b-mp1', 'l:b-mp2', 'LEFT', 'COUNT', '2');
    await sleep(50);
    await t.call('RPUSH', 'l:b-mp2', 'a', 'b', 'c');
    expect(await p).toEqual(['l:b-mp2', ['a', 'b']]);
    expect(await t.call('LRANGE', 'l:b-mp2', 0, -1)).toEqual(['c']);
  });

  it('a blocked BLPOP is served by an LMOVE into its key', async () => {
    const c = t.client();
    const p = c.call('BLPOP', 'l:b-chain', '0');
    await sleep(50);
    await t.call('RPUSH', 'l:b-chain-src', 'v');
    expect(await t.call('LMOVE', 'l:b-chain-src', 'l:b-chain', 'LEFT', 'LEFT')).toBe('v');
    expect(await p).toEqual(['l:b-chain', 'v']);
    expect(await t.call('EXISTS', 'l:b-chain')).toBe(0);
  });

  it('inside MULTI blocking commands do not block', async () => {
    const r = await t.raw();
    expect(await r.send('MULTI')).toBe('+OK\r\n');
    expect(await r.send('BLPOP', 'l:b-multi', '0')).toBe('+QUEUED\r\n');
    expect(await r.send('BRPOP', 'l:b-multi', '0')).toBe('+QUEUED\r\n');
    expect(await r.send('BLMPOP', '0', '1', 'l:b-multi', 'LEFT')).toBe('+QUEUED\r\n');
    expect(await r.send('EXEC')).toBe('*3\r\n*-1\r\n*-1\r\n*-1\r\n');
    expect(await r.send('MULTI')).toBe('+OK\r\n');
    await r.send('BLMOVE', 'l:b-multi', 'x', 'LEFT', 'LEFT', '0');
    await r.send('BRPOPLPUSH', 'l:b-multi', 'x', '0');
    // Redis replies with a plain null bulk for BLMOVE / BRPOPLPUSH under CLIENT_DENY_BLOCKING
    expect(await r.send('EXEC')).toBe('*2\r\n$-1\r\n$-1\r\n');
    await t.call('RPUSH', 'l:b-multi2', 'a');
    const res = await t.redis.multi().call('BLPOP', 'l:b-multi2', '0').exec();
    expect(res).toEqual([[null, ['l:b-multi2', 'a']]]);
  });
});

describe('lists: encodings', () => {
  it('listpack → quicklist and back', async () => {
    await t.call('RPUSH', 'l:enc', 'a', 'b');
    expect(await enc('l:enc')).toBe('listpack');
    const big = 'x'.repeat(100);
    for (let i = 0; i < 100; i++) await t.call('RPUSH', 'l:enc', big);
    expect(await enc('l:enc')).toBe('quicklist');
    await t.call('LTRIM', 'l:enc', 0, 1);
    expect(await enc('l:enc')).toBe('listpack');
    await t.call('RPUSH', 'l:enc2', 'y'.repeat(9000));
    expect(await enc('l:enc2')).toBe('quicklist');
    // unverified: whether a single 9000-byte element is converted back after shrinking; not asserted
  });
});
