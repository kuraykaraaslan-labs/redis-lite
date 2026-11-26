import { describe, expect, it } from 'vitest';

import { arity, SYNTAX, useServer, waitForBlocked, WRONGTYPE } from '@/tests/helpers';

/**
 * LMOVE, RPOPLPUSH and the blocking commands BLPOP, BRPOP, BLMPOP, BLMOVE, BRPOPLPUSH (lists.move.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

/** Asserts that every command rejects with WRONGTYPE against a string key. */
async function expectWrongType(key: string, cmds: Array<Array<string | number>>) {
  await t.call('SET', key, 'str');
  for (const c of cmds) {
    await expect(t.call(...c), c.join(' ')).rejects.toThrow(WRONGTYPE);
  }
}

describe('lists: moves', () => {
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
    await waitForBlocked(t);
    expect(await t.call('RPUSH', 'l:b-wait', 'x', 'y')).toBe(2);
    expect(await p).toEqual(['l:b-wait', 'x']);
    expect(await t.call('LRANGE', 'l:b-wait', 0, -1)).toEqual(['y']);
  });

  it('BRPOP blocks until another client pushes', async () => {
    const c = t.client();
    const p = c.call('BRPOP', 'l:b-wait2', 'l:b-wait3', '0');
    await waitForBlocked(t);
    await t.call('RPUSH', 'l:b-wait3', 'x', 'y');
    expect(await p).toEqual(['l:b-wait3', 'y']);
  });

  it('waiters are served FIFO', async () => {
    const c1 = t.client();
    const c2 = t.client();
    const c3 = t.client();
    const p1 = c1.call('BLPOP', 'l:b-fifo', '0');
    await waitForBlocked(t, 1);
    const p2 = c2.call('BLPOP', 'l:b-fifo', '0');
    await waitForBlocked(t, 2);
    const p3 = c3.call('BLPOP', 'l:b-fifo', '0');
    await waitForBlocked(t, 3);
    await t.call('RPUSH', 'l:b-fifo', 'a', 'b');
    expect(await p1).toEqual(['l:b-fifo', 'a']);
    expect(await p2).toEqual(['l:b-fifo', 'b']);
    await t.call('RPUSH', 'l:b-fifo', 'c');
    expect(await p3).toEqual(['l:b-fifo', 'c']);
    expect(await t.call('EXISTS', 'l:b-fifo')).toBe(0);
  });

  it('timeout returns nil; float timeouts are accepted', async () => {
    const start = performance.now(); // monotonic: the wall clock can be stepped mid-test
    expect(await t.call('BLPOP', 'l:b-to', '0.1')).toBeNull();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90); // never before the timeout
    expect(elapsed).toBeLessThan(10_000); // but it does fire (generous: a loaded machine delays the reply)
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
    await waitForBlocked(t);
    await t.call('RPUSH', 'l:b-mv', 'a', 'b');
    expect(await p).toBe('b');
    expect(await t.call('LRANGE', 'l:b-mv-dst', 0, -1)).toEqual(['b']);
    const p2 = c.call('BRPOPLPUSH', 'l:b-rpl', 'l:b-rpl-dst', '0');
    await waitForBlocked(t);
    await t.call('LPUSH', 'l:b-rpl', 'z');
    expect(await p2).toBe('z');
    expect(await t.call('LRANGE', 'l:b-rpl-dst', 0, -1)).toEqual(['z']);
    expect(await t.call('EXISTS', 'l:b-rpl')).toBe(0);
  });

  it('BLMPOP blocks and wakes with count', async () => {
    const c = t.client();
    const p = c.call('BLMPOP', '0', '2', 'l:b-mp1', 'l:b-mp2', 'LEFT', 'COUNT', '2');
    await waitForBlocked(t);
    await t.call('RPUSH', 'l:b-mp2', 'a', 'b', 'c');
    expect(await p).toEqual(['l:b-mp2', ['a', 'b']]);
    expect(await t.call('LRANGE', 'l:b-mp2', 0, -1)).toEqual(['c']);
  });

  it('a blocked BLPOP is served by an LMOVE into its key', async () => {
    const c = t.client();
    const p = c.call('BLPOP', 'l:b-chain', '0');
    await waitForBlocked(t);
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
