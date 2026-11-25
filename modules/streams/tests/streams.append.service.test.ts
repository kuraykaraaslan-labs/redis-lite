import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { arity, bulk, err, INVALID_ID, NOT_INT, openResp3, WRONGTYPE } from './streams.test_helpers';

/**
 * XADD, XDEL, XTRIM (streams.append.service).
 * Checked against the behaviour of Redis Open Source 8.8 (redis.io command docs, t_stream.c / pubsub.c reply and
 * error strings).
 */
const t = useServer();
const resp3 = () => openResp3(t);

// ============================================================================
// XADD
// ============================================================================
describe('XADD', () => {
  it('* generates <ms>-<seq> ids that increase', async () => {
    const before = Date.now();
    const id1 = (await t.call('XADD', 'xa:auto', '*', 'f', 'v')) as string;
    const id2 = (await t.call('XADD', 'xa:auto', '*', 'f', 'v')) as string;
    expect(id1).toMatch(/^\d+-\d+$/);
    const [ms1, seq1] = id1.split('-').map(Number);
    expect(ms1).toBeGreaterThanOrEqual(before - 5);
    expect(ms1).toBeLessThanOrEqual(Date.now() + 5);
    const [ms2, seq2] = id2.split('-').map(Number);
    expect(ms2 > ms1 || (ms2 === ms1 && seq2 === seq1 + 1)).toBe(true);
    expect(await t.call('XLEN', 'xa:auto')).toBe(2);
    expect(await t.call('TYPE', 'xa:auto')).toBe('stream');
  });

  it('explicit ids, and * after a future explicit id continues its ms with seq+1', async () => {
    expect(await t.call('XADD', 'xa:exp', '1-1', 'a', '1')).toBe('1-1');
    expect(await t.call('XADD', 'xa:exp', '1-2', 'a', '2')).toBe('1-2');
    expect(await t.call('XADD', 'xa:exp', '5', 'a', '3')).toBe('5-0');
    const future = Date.now() + 10_000_000;
    expect(await t.call('XADD', 'xa:exp', `${future}-5`, 'a', '4')).toBe(`${future}-5`);
    expect(await t.call('XADD', 'xa:exp', '*', 'a', '5')).toBe(`${future}-6`);
  });

  it('<ms>-* auto-generates the sequence', async () => {
    expect(await t.call('XADD', 'xa:seq', '5-*', 'f', 'v')).toBe('5-0');
    expect(await t.call('XADD', 'xa:seq', '5-*', 'f', 'v')).toBe('5-1');
    expect(await t.call('XADD', 'xa:seq', '7-*', 'f', 'v')).toBe('7-0');
    expect.soft(await err(t.call('XADD', 'xa:seq', '6-*', 'f', 'v'))).toBe(
      'ERR The ID specified in XADD is equal or smaller than the target stream top item',
    );
    // 0-* on an empty stream yields 0-1 (0-0 is not allowed)
    expect(await t.call('XADD', 'xa:seq0', '0-*', 'f', 'v')).toBe('0-1');
  });

  it('equal or smaller id errors', async () => {
    await t.call('XADD', 'xa:small', '10-5', 'f', 'v');
    const msg = 'ERR The ID specified in XADD is equal or smaller than the target stream top item';
    expect.soft(await err(t.call('XADD', 'xa:small', '10-5', 'f', 'v'))).toBe(msg);
    expect.soft(await err(t.call('XADD', 'xa:small', '10-4', 'f', 'v'))).toBe(msg);
    expect.soft(await err(t.call('XADD', 'xa:small', '9-9', 'f', 'v'))).toBe(msg);
    expect.soft(await err(t.call('XADD', 'xa:small', '10', 'f', 'v'))).toBe(msg);
    expect(await t.call('XLEN', 'xa:small')).toBe(1);
  });

  it('0-0 is rejected', async () => {
    expect.soft(await err(t.call('XADD', 'xa:zero', '0-0', 'f', 'v'))).toBe('ERR The ID specified in XADD must be greater than 0-0');
    expect.soft(await err(t.call('XADD', 'xa:zero', '0', 'f', 'v'))).toBe('ERR The ID specified in XADD must be greater than 0-0');
    expect(await t.call('EXISTS', 'xa:zero')).toBe(0);
  });

  it('invalid ids', async () => {
    expect.soft(await err(t.call('XADD', 'xa:bad', 'abc', 'f', 'v'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XADD', 'xa:bad', '1-abc', 'f', 'v'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XADD', 'xa:bad', '-1', 'f', 'v'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XADD', 'xa:bad', '18446744073709551616-0', 'f', 'v'))).toBe(INVALID_ID);
  });

  it('exhausted id space', async () => {
    await t.call('XADD', 'xa:max', '18446744073709551615-18446744073709551615', 'f', 'v');
    expect.soft(await err(t.call('XADD', 'xa:max', '*', 'f', 'v'))).toBe(
      'ERR The stream has exhausted the last possible ID, unable to add more items',
    );
  });

  it('NOMKSTREAM', async () => {
    expect(await t.call('XADD', 'xa:nomk', 'NOMKSTREAM', '*', 'f', 'v')).toBeNull();
    expect(await t.call('EXISTS', 'xa:nomk')).toBe(0);
    await t.call('XADD', 'xa:nomk', '1-0', 'f', 'v');
    expect(await t.call('XADD', 'xa:nomk', 'NOMKSTREAM', '2-0', 'f', 'v')).toBe('2-0');
    expect(await t.call('XLEN', 'xa:nomk')).toBe(2);
  });

  it('NOMKSTREAM nil in RESP3 is _', async () => {
    const c = await resp3();
    expect(await c.send('XADD', 'xa:nomk3', 'NOMKSTREAM', '*', 'f', 'v')).toBe('_\r\n');
    const c2 = await t.raw();
    expect(await c2.send('XADD', 'xa:nomk3', 'NOMKSTREAM', '*', 'f', 'v')).toBe('$-1\r\n');
    expect(await c2.send('XADD', 'xa:nomk3', '1-0', 'f', 'v')).toBe(bulk('1-0'));
  });

  it('MAXLEN = exact and plain', async () => {
    for (let i = 1; i <= 5; i++) await t.call('XADD', 'xa:ml', `${i}-0`, 'f', String(i));
    expect(await t.call('XADD', 'xa:ml', 'MAXLEN', '3', '6-0', 'f', '6')).toBe('6-0');
    expect(await t.call('XLEN', 'xa:ml')).toBe(3);
    expect(await t.call('XRANGE', 'xa:ml', '-', '+')).toEqual([
      ['4-0', ['f', '4']],
      ['5-0', ['f', '5']],
      ['6-0', ['f', '6']],
    ]);
    await t.call('XADD', 'xa:ml', 'MAXLEN', '=', '2', '7-0', 'f', '7');
    expect(await t.call('XRANGE', 'xa:ml', '-', '+')).toEqual([
      ['6-0', ['f', '6']],
      ['7-0', ['f', '7']],
    ]);
    await t.call('XADD', 'xa:ml', 'MAXLEN', '0', '8-0', 'f', '8');
    expect(await t.call('XLEN', 'xa:ml')).toBe(0);
    expect(await t.call('EXISTS', 'xa:ml')).toBe(1);
  });

  it('MAXLEN ~ on a small stream keeps whole nodes', async () => {
    for (let i = 1; i <= 10; i++) await t.call('XADD', 'xa:mla', `${i}-0`, 'f', 'v');
    await t.call('XADD', 'xa:mla', 'MAXLEN', '~', '2', '11-0', 'f', 'v');
    // all 11 entries live in one node, which can't be removed whole
    expect(await t.call('XLEN', 'xa:mla')).toBe(11);
  });

  it('MINID', async () => {
    for (let i = 1; i <= 5; i++) await t.call('XADD', 'xa:minid', `${i}-0`, 'f', 'v');
    await t.call('XADD', 'xa:minid', 'MINID', '3', '6-0', 'f', 'v');
    expect((await t.call('XRANGE', 'xa:minid', '-', '+') as Array<[string]>).map((e) => e[0])).toEqual(['3-0', '4-0', '5-0', '6-0']);
    await t.call('XADD', 'xa:minid', 'MINID', '=', '5-0', '7-0', 'f', 'v');
    expect(await t.call('XLEN', 'xa:minid')).toBe(3);
    await t.call('XADD', 'xa:minid', 'MINID', '~', '7', '8-0', 'f', 'v');
    expect(await t.call('XLEN', 'xa:minid')).toBe(4); // one node, not removed
  });

  it('LIMIT requires ~', async () => {
    expect.soft(await err(t.call('XADD', 'xa:lim', 'MAXLEN', '10', 'LIMIT', '5', '*', 'f', 'v'))).toBe(
      'ERR syntax error, LIMIT cannot be used without the special ~ option',
    );
    expect.soft(await err(t.call('XADD', 'xa:lim', 'MAXLEN', '=', '10', 'LIMIT', '5', '*', 'f', 'v'))).toBe(
      'ERR syntax error, LIMIT cannot be used without the special ~ option',
    );
    expect(await t.call('XADD', 'xa:lim', 'MAXLEN', '~', '10', 'LIMIT', '5', '1-0', 'f', 'v')).toBe('1-0');
  });

  it('option errors', async () => {
    expect.soft(await err(t.call('XADD', 'xa:opt', 'MAXLEN', '-1', '*', 'f', 'v'))).toBe('ERR The MAXLEN argument must be >= 0.');
    expect.soft(await err(t.call('XADD', 'xa:opt', 'MAXLEN', 'abc', '*', 'f', 'v'))).toBe(NOT_INT);
    expect.soft(await err(t.call('XADD', 'xa:opt', 'MAXLEN', '5', 'MINID', '1', '*', 'f', 'v'))).toBe(
      'ERR syntax error, MAXLEN and MINID options at the same time are not compatible',
    );
    expect(await t.call('EXISTS', 'xa:opt')).toBe(0);
  });

  it('arity, odd field count, wrong type', async () => {
    expect.soft(await err(t.call('XADD', 'xa:ar'))).toBe(arity('xadd'));
    expect.soft(await err(t.call('XADD', 'xa:ar', '*'))).toBe(arity('xadd'));
    expect.soft(await err(t.call('XADD', 'xa:ar', '*', 'f'))).toBe(arity('xadd'));
    expect.soft(await err(t.call('XADD', 'xa:ar', '*', 'f', 'v', 'g'))).toBe(arity('xadd'));
    expect.soft(await err(t.call('XADD', 'xa:ar', 'MAXLEN', '5', '*', 'f'))).toBe(arity('xadd'));
    expect(await t.call('EXISTS', 'xa:ar')).toBe(0);
    await t.call('SET', 'xa:str', 'x');
    expect.soft(await err(t.call('XADD', 'xa:str', '*', 'f', 'v'))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('GET', 'xa:nomk'))).toBe(WRONGTYPE);
  });

  it('binary fields and values round-trip', async () => {
    const bin = Buffer.from([0, 1, 2, 255, 13, 10]);
    await t.call('XADD', 'xa:bin', '1-0', bin, bin);
    const r = (await t.redis.xrangeBuffer('xa:bin', '-', '+')) as unknown as Array<[Buffer, Buffer[]]>;
    expect(Buffer.compare(r[0][1][0], bin)).toBe(0);
    expect(Buffer.compare(r[0][1][1], bin)).toBe(0);
  });

  it('duplicate field names are kept as given', async () => {
    await t.call('XADD', 'xa:dup', '1-0', 'a', '1', 'a', '2');
    expect(await t.call('XRANGE', 'xa:dup', '-', '+')).toEqual([['1-0', ['a', '1', 'a', '2']]]);
  });
});

// ============================================================================
// XDEL / XTRIM
// ============================================================================
describe('XDEL', () => {
  it('deletes existing ids and counts them', async () => {
    for (let i = 1; i <= 4; i++) await t.call('XADD', 'xd:s', `${i}-0`, 'f', 'v');
    expect(await t.call('XDEL', 'xd:s', '2-0', '3-0', '9-0')).toBe(2);
    expect(await t.call('XDEL', 'xd:s', '2-0')).toBe(0);
    expect(await t.call('XLEN', 'xd:s')).toBe(2);
    expect((await t.call('XRANGE', 'xd:s', '-', '+') as Array<[string]>).map((e) => e[0])).toEqual(['1-0', '4-0']);
    expect(await t.call('XDEL', 'xd:none', '1-0')).toBe(0);
  });

  it('deleting the last entry keeps the key and last id', async () => {
    await t.call('XADD', 'xd:last', '5-0', 'f', 'v');
    expect(await t.call('XDEL', 'xd:last', '5-0')).toBe(1);
    expect(await t.call('EXISTS', 'xd:last')).toBe(1);
    expect(await t.call('XLEN', 'xd:last')).toBe(0);
    expect.soft(await err(t.call('XADD', 'xd:last', '5-0', 'f', 'v'))).toBe(
      'ERR The ID specified in XADD is equal or smaller than the target stream top item',
    );
  });

  it('errors', async () => {
    await t.call('XADD', 'xd:e', '1-0', 'f', 'v');
    expect.soft(await err(t.call('XDEL', 'xd:e', 'bad'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XDEL', 'xd:e'))).toBe(arity('xdel'));
    await t.call('SET', 'xd:str', 'v');
    expect.soft(await err(t.call('XDEL', 'xd:str', '1-0'))).toBe(WRONGTYPE);
  });
});

describe('XTRIM', () => {
  it('MAXLEN exact', async () => {
    for (let i = 1; i <= 10; i++) await t.call('XADD', 'xt:ml', `${i}-0`, 'f', 'v');
    expect(await t.call('XTRIM', 'xt:ml', 'MAXLEN', 7)).toBe(3);
    expect(await t.call('XTRIM', 'xt:ml', 'MAXLEN', '=', 5)).toBe(2);
    expect(await t.call('XTRIM', 'xt:ml', 'MAXLEN', 5)).toBe(0);
    expect((await t.call('XRANGE', 'xt:ml', '-', '+') as Array<[string]>)[0][0]).toBe('6-0');
    expect(await t.call('XTRIM', 'xt:ml', 'MAXLEN', 0)).toBe(5);
    expect(await t.call('EXISTS', 'xt:ml')).toBe(1);
  });

  it('MINID exact', async () => {
    for (let i = 1; i <= 10; i++) await t.call('XADD', 'xt:mi', `${i}-0`, 'f', 'v');
    expect(await t.call('XTRIM', 'xt:mi', 'MINID', '4-0')).toBe(3);
    expect(await t.call('XTRIM', 'xt:mi', 'MINID', '=', 6)).toBe(2);
    expect(await t.call('XTRIM', 'xt:mi', 'MINID', 1)).toBe(0);
    expect(await t.call('XLEN', 'xt:mi')).toBe(5);
  });

  it('missing key returns 0 and does not create it', async () => {
    expect(await t.call('XTRIM', 'xt:none', 'MAXLEN', 0)).toBe(0);
    expect(await t.call('EXISTS', 'xt:none')).toBe(0);
  });

  it('node-based trimming with ~ (stream-node-max-entries 100)', async () => {
    expect(await t.call('CONFIG', 'GET', 'stream-node-max-entries')).toEqual(['stream-node-max-entries', '100']);
    const add = async (key: string) => {
      const p = t.redis.pipeline();
      for (let i = 1; i <= 250; i++) p.call('XADD', key, `${i}-0`, 'f', 'v');
      await p.exec();
    };
    await add('xt:node');
    // nodes of 100,100,50: removing the first node leaves 150 >= 120; removing the second would leave 50 < 120
    expect(await t.call('XTRIM', 'xt:node', 'MAXLEN', '~', 120)).toBe(100);
    expect(await t.call('XLEN', 'xt:node')).toBe(150);
    expect((await t.call('XRANGE', 'xt:node', '-', '+', 'COUNT', 1) as Array<[string]>)[0][0]).toBe('101-0');

    await add('xt:node2');
    // LIMIT smaller than a node: nothing can be removed
    expect(await t.call('XTRIM', 'xt:node2', 'MAXLEN', '~', 0, 'LIMIT', 50)).toBe(0);
    expect(await t.call('XTRIM', 'xt:node2', 'MAXLEN', '~', 0, 'LIMIT', 100)).toBe(100);
    expect(await t.call('XLEN', 'xt:node2')).toBe(150);
    // MINID ~ 230: the 101..200 node is entirely below 230
    expect(await t.call('XTRIM', 'xt:node2', 'MINID', '~', 230)).toBe(100);
    expect(await t.call('XLEN', 'xt:node2')).toBe(50);

    await add('xt:node3');
    expect(await t.call('XADD', 'xt:node3', 'MAXLEN', '~', 120, '251-0', 'f', 'v')).toBe('251-0');
    expect(await t.call('XLEN', 'xt:node3')).toBe(151);
  });

  it('errors', async () => {
    await t.call('XADD', 'xt:e', '1-0', 'f', 'v');
    expect.soft(await err(t.call('XTRIM', 'xt:e', 'MAXLEN', 10, 'LIMIT', 5))).toBe(
      'ERR syntax error, LIMIT cannot be used without the special ~ option',
    );
    expect.soft(await err(t.call('XTRIM', 'xt:e', 'FOO', 1))).toBe('ERR syntax error');
    expect.soft(await err(t.call('XTRIM', 'xt:e', 'MAXLEN', -1))).toBe('ERR The MAXLEN argument must be >= 0.');
    expect.soft(await err(t.call('XTRIM', 'xt:e', 'MAXLEN', 'x'))).toBe(NOT_INT);
    expect.soft(await err(t.call('XTRIM', 'xt:e', 'MINID', 'bad'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XTRIM', 'xt:e', 'MAXLEN'))).toBe(arity('xtrim'));
    expect.soft(await err(t.call('XTRIM', 'xt:e'))).toBe(arity('xtrim'));
    await t.call('SET', 'xt:str', 'v');
    expect.soft(await err(t.call('XTRIM', 'xt:str', 'MAXLEN', 1))).toBe(WRONGTYPE);
  });
});
