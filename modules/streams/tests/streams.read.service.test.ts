import { describe, expect, it } from 'vitest';

import { useServer, waitForBlocked } from '@/tests/helpers';

import { arity, arr, bulk, entry, err, INVALID_ID, NOT_INT, openResp3, toMap, WRONGTYPE } from './streams.test_helpers';

/**
 * XREAD, XREADGROUP (streams.read.service).
 * Checked against the behaviour of Redis Open Source 8.8 (redis.io command docs, t_stream.c / pubsub.c reply and
 * error strings).
 */
const t = useServer();
const resp3 = () => openResp3(t);

// ============================================================================
// XREAD
// ============================================================================
describe('XREAD', () => {
  it('reads entries after the given id', async () => {
    for (let i = 1; i <= 3; i++) await t.call('XADD', 'xrd:a', `${i}-0`, 'f', String(i));
    expect(await t.call('XREAD', 'STREAMS', 'xrd:a', '0')).toEqual([
      ['xrd:a', [['1-0', ['f', '1']], ['2-0', ['f', '2']], ['3-0', ['f', '3']]]],
    ]);
    expect(await t.call('XREAD', 'STREAMS', 'xrd:a', '1-0')).toEqual([['xrd:a', [['2-0', ['f', '2']], ['3-0', ['f', '3']]]]]);
    expect(await t.call('XREAD', 'COUNT', 1, 'STREAMS', 'xrd:a', '0-0')).toEqual([['xrd:a', [['1-0', ['f', '1']]]]]);
    expect(await t.call('XREAD', 'STREAMS', 'xrd:a', '3-0')).toBeNull();
    expect(await t.call('XREAD', 'STREAMS', 'xrd:none', '0')).toBeNull();
  });

  it('multiple streams, only those with data are returned, in argument order', async () => {
    await t.call('XADD', 'xrd:m1', '1-0', 'a', '1');
    await t.call('XADD', 'xrd:m2', '2-0', 'b', '2');
    expect(await t.call('XREAD', 'STREAMS', 'xrd:m2', 'xrd:m1', '0', '0')).toEqual([
      ['xrd:m2', [['2-0', ['b', '2']]]],
      ['xrd:m1', [['1-0', ['a', '1']]]],
    ]);
    expect(await t.call('XREAD', 'STREAMS', 'xrd:m1', 'xrd:missing', 'xrd:m2', '0', '0', '2-0')).toEqual([
      ['xrd:m1', [['1-0', ['a', '1']]]],
    ]);
    expect(await t.call('XREAD', 'COUNT', 1, 'STREAMS', 'xrd:m1', 'xrd:m2', '0', '0')).toEqual([
      ['xrd:m1', [['1-0', ['a', '1']]]],
      ['xrd:m2', [['2-0', ['b', '2']]]],
    ]);
  });

  it('$ without BLOCK returns nil', async () => {
    await t.call('XADD', 'xrd:dollar', '1-0', 'f', 'v');
    expect(await t.call('XREAD', 'STREAMS', 'xrd:dollar', '$')).toBeNull();
  });

  it('+ is an invalid id (Redis 7.0 has no XREAD +)', async () => {
    await t.call('XADD', 'xrd:plus', '1-0', 'f', '1');
    const invalid = 'ERR Invalid stream ID specified as stream command argument';
    await expect(t.call('XREAD', 'STREAMS', 'xrd:plus', '+')).rejects.toThrow(invalid);
    await expect(t.call('XREAD', 'STREAMS', 'xrd:plus-missing', '+')).rejects.toThrow(invalid);
  });

  it('BLOCK wakes up on XADD from another client', async () => {
    await t.call('XADD', 'xrd:blk', '1-0', 'f', 'old');
    const c = t.client();
    const p = c.call('XREAD', 'BLOCK', '0', 'STREAMS', 'xrd:blk', '$');
    await waitForBlocked(t);
    await t.call('XADD', 'xrd:blk', '2-0', 'f', 'new');
    expect(await p).toEqual([['xrd:blk', [['2-0', ['f', 'new']]]]]);
  });

  it('BLOCK on a missing key with $ wakes when the stream is created', async () => {
    const c = t.client();
    const p = c.call('XREAD', 'BLOCK', '20000', 'STREAMS', 'xrd:blk2', '$');
    await waitForBlocked(t);
    await t.call('XADD', 'xrd:blk2', '7-0', 'f', 'v');
    expect(await p).toEqual([['xrd:blk2', [['7-0', ['f', 'v']]]]]);
  });

  it('BLOCK returns immediately when data is available', async () => {
    await t.call('XADD', 'xrd:blk3', '1-0', 'f', 'v');
    const start = performance.now(); // monotonic: the wall clock can be stepped mid-test
    expect(await t.call('XREAD', 'BLOCK', '20000', 'STREAMS', 'xrd:blk3', '0')).toEqual([['xrd:blk3', [['1-0', ['f', 'v']]]]]);
    // far below the BLOCK timeout (generous: a loaded machine can delay any reply by seconds)
    expect(performance.now() - start).toBeLessThan(10_000);
  });

  it('BLOCK timeout returns nil (RESP2 *-1, RESP3 _)', async () => {
    const start = performance.now(); // monotonic: the wall clock can be stepped mid-test
    expect(await t.call('XREAD', 'BLOCK', '100', 'STREAMS', 'xrd:timeout', '$')).toBeNull();
    expect(performance.now() - start).toBeGreaterThanOrEqual(90);
    const c2 = await t.raw();
    expect(await c2.send('XREAD', 'BLOCK', '50', 'STREAMS', 'xrd:timeout', '$')).toBe('*-1\r\n');
    expect(await c2.send('XREAD', 'STREAMS', 'xrd:timeout', '0')).toBe('*-1\r\n');
    const c3 = await resp3();
    expect(await c3.send('XREAD', 'BLOCK', '50', 'STREAMS', 'xrd:timeout', '$')).toBe('_\r\n');
    expect(await c3.send('XREAD', 'STREAMS', 'xrd:timeout', '0')).toBe('_\r\n');
  });

  it('BLOCK with COUNT and with multiple streams', async () => {
    await t.call('XADD', 'xrd:bm1', '1-0', 'f', 'v');
    const c = t.client();
    const p = c.call('XREAD', 'COUNT', '1', 'BLOCK', '0', 'STREAMS', 'xrd:bm1', 'xrd:bm2', '$', '$');
    await waitForBlocked(t);
    await t.call('XADD', 'xrd:bm2', '3-0', 'g', 'w');
    expect(await p).toEqual([['xrd:bm2', [['3-0', ['g', 'w']]]]]);
  });

  it('RESP2 nested arrays vs RESP3 map', async () => {
    await t.call('XADD', 'xrd:w', '1-0', 'f', 'v');
    const c2 = await t.raw();
    expect(await c2.send('XREAD', 'STREAMS', 'xrd:w', '0')).toBe(arr(arr(bulk('xrd:w'), arr(entry('1-0', 'f', 'v')))));
    const c3 = await resp3();
    expect(await c3.send('XREAD', 'STREAMS', 'xrd:w', '0')).toBe(`%1\r\n${bulk('xrd:w')}${arr(entry('1-0', 'f', 'v'))}`);
  });

  it('errors', async () => {
    await t.call('XADD', 'xrd:e', '1-0', 'f', 'v');
    expect.soft(await err(t.call('XREAD', 'COUNT', 1, 'STREAMS', 'xrd:e'))).toBe(
      "ERR Unbalanced XREAD list of streams: for each stream key an ID or '$' must be specified.",
    );
    expect.soft(await err(t.call('XREAD', 'STREAMS', 'xrd:e', 'xrd:e2', '0'))).toBe(
      "ERR Unbalanced XREAD list of streams: for each stream key an ID or '$' must be specified.",
    );
    expect.soft(await err(t.call('XREAD', 'COUNT', 1, 'xrd:e', '0'))).toBe('ERR syntax error');
    expect.soft(await err(t.call('XREAD', 'COUNT', 'x', 'STREAMS', 'xrd:e', '0'))).toBe(NOT_INT);
    expect.soft(await err(t.call('XREAD', 'BLOCK', '-1', 'STREAMS', 'xrd:e', '0'))).toBe('ERR timeout is negative');
    expect.soft(await err(t.call('XREAD', 'BLOCK', 'x', 'STREAMS', 'xrd:e', '0'))).toBe('ERR timeout is not an integer or out of range');
    expect.soft(await err(t.call('XREAD', 'STREAMS', 'xrd:e', 'bad'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XREAD', 'STREAMS', 'xrd:e', '>'))).toBe(
      'ERR The > ID can be specified only when calling XREADGROUP using the GROUP <group> <consumer> option.',
    );
    expect.soft(await err(t.call('XREAD', 'STREAMS'))).toBe(arity('xread'));
    expect.soft(await err(t.call('XREAD'))).toBe(arity('xread'));
    await t.call('SET', 'xrd:str', 'v');
    expect.soft(await err(t.call('XREAD', 'STREAMS', 'xrd:str', '0'))).toBe(WRONGTYPE);
  });
});

// ============================================================================
// XREADGROUP
// ============================================================================
describe('XREADGROUP', () => {
  const k = 'xrg:s';
  it('> delivers new entries once, auto-creates the consumer, COUNT', async () => {
    for (let i = 1; i <= 4; i++) await t.call('XADD', k, `${i}-0`, 'f', String(i));
    await t.call('XGROUP', 'CREATE', k, 'g', '0');
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c1', 'COUNT', 2, 'STREAMS', k, '>')).toEqual([
      [k, [['1-0', ['f', '1']], ['2-0', ['f', '2']]]],
    ]);
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c2', 'STREAMS', k, '>')).toEqual([
      [k, [['3-0', ['f', '3']], ['4-0', ['f', '4']]]],
    ]);
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c1', 'STREAMS', k, '>')).toBeNull();
    const cons = ((await t.call('XINFO', 'CONSUMERS', k, 'g')) as unknown[][]).map((c) => toMap(c).name);
    expect(cons).toEqual(['c1', 'c2']);
  });

  it('history ids return this consumer\'s pending entries', async () => {
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c1', 'STREAMS', k, '0')).toEqual([
      [k, [['1-0', ['f', '1']], ['2-0', ['f', '2']]]],
    ]);
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c1', 'STREAMS', k, '1-0')).toEqual([[k, [['2-0', ['f', '2']]]]]);
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c1', 'COUNT', 1, 'STREAMS', k, '0')).toEqual([[k, [['1-0', ['f', '1']]]]]);
    expect(await t.call('XACK', k, 'g', '1-0', '2-0')).toBe(2);
    // empty history is an empty list, not nil
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c1', 'STREAMS', k, '0')).toEqual([[k, []]]);
    // history read for an unknown consumer also creates it and returns empty
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c9', 'STREAMS', k, '0')).toEqual([[k, []]]);
  });

  it('history read increments the delivery counter', async () => {
    await t.call('XADD', 'xrg:dc', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xrg:dc', 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:dc', '>');
    await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:dc', '0');
    const p = (await t.call('XPENDING', 'xrg:dc', 'g', '-', '+', 10)) as Array<[string, string, number, number]>;
    expect(p[0][0]).toBe('1-0');
    expect(p[0][1]).toBe('c');
    expect(p[0][3]).toBe(2);
  });

  it('deleted pending entries show as id with nil fields in history', async () => {
    await t.call('XADD', 'xrg:del', '1-0', 'f', 'v');
    await t.call('XADD', 'xrg:del', '2-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xrg:del', 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:del', '>');
    await t.call('XDEL', 'xrg:del', '1-0');
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:del', '0')).toEqual([
      ['xrg:del', [['1-0', null], ['2-0', ['f', 'v']]]],
    ]);
    const c2 = await t.raw();
    expect(await c2.send('XREADGROUP', 'GROUP', 'g', 'c', 'COUNT', '1', 'STREAMS', 'xrg:del', '0')).toBe(
      arr(arr(bulk('xrg:del'), arr(arr(bulk('1-0'), '*-1\r\n')))),
    );
    const c3 = await resp3();
    expect(await c3.send('XREADGROUP', 'GROUP', 'g', 'c', 'COUNT', '1', 'STREAMS', 'xrg:del', '0')).toBe(
      `%1\r\n${bulk('xrg:del')}${arr(arr(bulk('1-0'), '_\r\n'))}`,
    );
  });

  it('NOACK does not add to the PEL', async () => {
    await t.call('XADD', 'xrg:noack', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xrg:noack', 'g', '0');
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'NOACK', 'STREAMS', 'xrg:noack', '>')).toEqual([
      ['xrg:noack', [['1-0', ['f', 'v']]]],
    ]);
    expect(await t.call('XPENDING', 'xrg:noack', 'g')).toEqual([0, null, null, null]);
    expect(toMap(((await t.call('XINFO', 'GROUPS', 'xrg:noack')) as unknown[][])[0])['last-delivered-id']).toBe('1-0');
  });

  it('multiple streams', async () => {
    await t.call('XADD', 'xrg:m1', '1-0', 'a', '1');
    await t.call('XADD', 'xrg:m2', '1-0', 'b', '1');
    await t.call('XGROUP', 'CREATE', 'xrg:m1', 'g', '0');
    await t.call('XGROUP', 'CREATE', 'xrg:m2', 'g', '0');
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:m1', 'xrg:m2', '>', '>')).toEqual([
      ['xrg:m1', [['1-0', ['a', '1']]]],
      ['xrg:m2', [['1-0', ['b', '1']]]],
    ]);
  });

  it('BLOCK is served by XADD from another client', async () => {
    await t.call('XGROUP', 'CREATE', 'xrg:blk', 'g', '$', 'MKSTREAM');
    const c = t.client();
    const p = c.call('XREADGROUP', 'GROUP', 'g', 'c', 'BLOCK', '0', 'STREAMS', 'xrg:blk', '>');
    await waitForBlocked(t);
    await t.call('XADD', 'xrg:blk', '5-0', 'f', 'v');
    expect(await p).toEqual([['xrg:blk', [['5-0', ['f', 'v']]]]]);
    const pend = (await t.call('XPENDING', 'xrg:blk', 'g')) as unknown[];
    expect(pend[0]).toBe(1);
  });

  it('BLOCK timeout and history ids with BLOCK', async () => {
    await t.call('XGROUP', 'CREATE', 'xrg:blkto', 'g', '$', 'MKSTREAM');
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'BLOCK', '50', 'STREAMS', 'xrg:blkto', '>')).toBeNull();
    // a history id is answered synchronously even with BLOCK
    expect(await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'BLOCK', '1000', 'STREAMS', 'xrg:blkto', '0')).toEqual([['xrg:blkto', []]]);
    const c3 = await resp3();
    expect(await c3.send('XREADGROUP', 'GROUP', 'g', 'c', 'BLOCK', '50', 'STREAMS', 'xrg:blkto', '>')).toBe('_\r\n');
  });

  it('RESP3 reply is a map', async () => {
    await t.call('XADD', 'xrg:r3', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xrg:r3', 'g', '0');
    const c3 = await resp3();
    expect(await c3.send('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:r3', '>')).toBe(
      `%1\r\n${bulk('xrg:r3')}${arr(entry('1-0', 'f', 'v'))}`,
    );
    const c2 = await t.raw();
    expect(await c2.send('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:r3', '0')).toBe(
      arr(arr(bulk('xrg:r3'), arr(entry('1-0', 'f', 'v')))),
    );
  });

  it('errors', async () => {
    await t.call('XADD', 'xrg:e', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xrg:e', 'g', '0');
    expect.soft(await err(t.call('XREADGROUP', 'GROUP', 'nog', 'c', 'STREAMS', 'xrg:e', '>'))).toBe(
      "NOGROUP No such key 'xrg:e' or consumer group 'nog' in XREADGROUP with GROUP option",
    );
    expect.soft(await err(t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:missing', '>'))).toBe(
      "NOGROUP No such key 'xrg:missing' or consumer group 'g' in XREADGROUP with GROUP option",
    );
    expect.soft(await err(t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:e', '$'))).toBe(
      'ERR The $ ID is meaningless in the context of XREADGROUP: you want to read the history of this consumer by specifying a proper ID, or use the > ID to get new messages. The $ ID would just return an empty result set.',
    );
    expect.soft(await err(t.call('XREADGROUP', 'GROUP', 'g', 'c', 'COUNT', 1, 'STREAMS', 'xrg:e'))).toBe(
      "ERR Unbalanced XREAD list of streams: for each stream key an ID or '$' must be specified.",
    );
    expect.soft(await err(t.call('XREADGROUP', 'COUNT', 1, 'BLOCK', 10, 'STREAMS', 'xrg:e', '>'))).toBe('ERR Missing GROUP option for XREADGROUP');
    expect.soft(await err(t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:e', 'bad'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XREADGROUP', 'GROUP', 'g'))).toBe(arity('xreadgroup'));
    await t.call('SET', 'xrg:str', 'v');
    expect.soft(await err(t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:str', '>'))).toBe(WRONGTYPE);
  });
});
