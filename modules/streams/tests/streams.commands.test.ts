import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * Streams, checked against the behaviour of Redis Open Source 8.8
 * (redis.io command docs, t_stream.c / pubsub.c reply and error strings).
 */
const t = useServer();

/** Resolves to the error message of a rejected call, or 'NO ERROR'. */
async function err(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'NO ERROR';
}

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const INVALID_ID = 'ERR Invalid stream ID specified as stream command argument';

const NOT_INT = 'ERR value is not an integer or out of range';

// RESP builders (latin1 lengths, matching RawClient).
const bulk = (s: string) => `$${Buffer.byteLength(s, 'latin1')}\r\n${s}\r\n`;

const arr = (...items: string[]) => `*${items.length}\r\n${items.join('')}`;

const entry = (id: string, ...fv: string[]) => arr(bulk(id), arr(...fv.map(bulk)));

async function resp3(): Promise<RawClient> {
  const c = await t.raw();
  await c.send('HELLO', '3');
  return c;
}

/** Asserts that `keys` appear in `flat` (a flat field/value list) in this relative order. */
function expectOrderedFields(flat: unknown[], keys: string[]): void {
  const names = flat.filter((_, i) => i % 2 === 0) as string[];
  const positions = keys.map((k) => names.indexOf(k));
  for (const [i, p] of positions.entries()) expect(p, `field ${keys[i]}`).toBeGreaterThanOrEqual(0);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
}

function toMap(flat: unknown[]): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (let i = 0; i < flat.length; i += 2) m[String(flat[i])] = flat[i + 1];
  return m;
}

// ---------------------------------------------------------------------------
// XADD
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// XLEN / XRANGE / XREVRANGE / XDEL / XTRIM
// ---------------------------------------------------------------------------
describe('XLEN', () => {
  it('counts, missing key, wrong type, arity', async () => {
    expect(await t.call('XLEN', 'xl:none')).toBe(0);
    await t.call('XADD', 'xl:s', '1-0', 'f', 'v');
    await t.call('XADD', 'xl:s', '2-0', 'f', 'v');
    expect(await t.call('XLEN', 'xl:s')).toBe(2);
    await t.call('LPUSH', 'xl:list', 'a');
    expect.soft(await err(t.call('XLEN', 'xl:list'))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('XLEN'))).toBe(arity('xlen'));
    expect.soft(await err(t.call('XLEN', 'a', 'b'))).toBe(arity('xlen'));
  });
});

describe('XRANGE / XREVRANGE', () => {
  const k = 'xr:s';
  const setup = async () => {
    if ((await t.call('EXISTS', k)) === 1) return;
    await t.call('XADD', k, '1-0', 'a', '1');
    await t.call('XADD', k, '1-1', 'a', '2');
    await t.call('XADD', k, '2-0', 'a', '3');
    await t.call('XADD', k, '2-5', 'a', '4');
    await t.call('XADD', k, '3-0', 'a', '5');
  };
  const ids = (r: unknown) => (r as Array<[string]>).map((e) => e[0]);

  it('- and + cover the whole stream', async () => {
    await setup();
    expect(await t.call('XRANGE', k, '-', '+')).toEqual([
      ['1-0', ['a', '1']],
      ['1-1', ['a', '2']],
      ['2-0', ['a', '3']],
      ['2-5', ['a', '4']],
      ['3-0', ['a', '5']],
    ]);
    expect(ids(await t.call('XREVRANGE', k, '+', '-'))).toEqual(['3-0', '2-5', '2-0', '1-1', '1-0']);
  });

  it('incomplete ids: start ms -> ms-0, end ms -> ms-max', async () => {
    await setup();
    expect(ids(await t.call('XRANGE', k, '2', '2'))).toEqual(['2-0', '2-5']);
    expect(ids(await t.call('XRANGE', k, '1', '2'))).toEqual(['1-0', '1-1', '2-0', '2-5']);
    expect(ids(await t.call('XREVRANGE', k, '2', '1'))).toEqual(['2-5', '2-0', '1-1', '1-0']);
    expect(ids(await t.call('XRANGE', k, '1-1', '2-0'))).toEqual(['1-1', '2-0']);
  });

  it('exclusive ( bounds', async () => {
    await setup();
    expect(ids(await t.call('XRANGE', k, '(1-0', '+'))).toEqual(['1-1', '2-0', '2-5', '3-0']);
    expect(ids(await t.call('XRANGE', k, '-', '(3-0'))).toEqual(['1-0', '1-1', '2-0', '2-5']);
    expect(ids(await t.call('XRANGE', k, '(1-1', '(2-5'))).toEqual(['2-0']);
    expect(ids(await t.call('XREVRANGE', k, '(3-0', '(1-0'))).toEqual(['2-5', '2-0', '1-1']);
    // pagination idiom from the docs
    const page1 = ids(await t.call('XRANGE', k, '-', '+', 'COUNT', 2));
    expect(page1).toEqual(['1-0', '1-1']);
    expect(ids(await t.call('XRANGE', k, `(${page1[1]}`, '+', 'COUNT', 2))).toEqual(['2-0', '2-5']);
    expect.soft(await err(t.call('XRANGE', k, '(18446744073709551615-18446744073709551615', '+'))).toBe(
      'ERR invalid start ID for the interval',
    );
    expect.soft(await err(t.call('XRANGE', k, '-', '(0-0'))).toBe('ERR invalid end ID for the interval');
  });

  it('COUNT', async () => {
    await setup();
    expect(ids(await t.call('XRANGE', k, '-', '+', 'COUNT', 2))).toEqual(['1-0', '1-1']);
    expect(ids(await t.call('XREVRANGE', k, '+', '-', 'COUNT', 2))).toEqual(['3-0', '2-5']);
    expect(await t.call('XRANGE', k, '-', '+', 'COUNT', 0)).toEqual([]);
    expect(ids(await t.call('XRANGE', k, '-', '+', 'COUNT', 100))).toHaveLength(5);
    expect.soft(await err(t.call('XRANGE', k, '-', '+', 'COUNT'))).toBe('ERR syntax error');
    expect.soft(await err(t.call('XRANGE', k, '-', '+', 'COUNT', 'x'))).toBe(NOT_INT);
    expect.soft(await err(t.call('XRANGE', k, '-', '+', 'LIMIT', 1))).toBe('ERR syntax error');
  });

  it('empty results, start > end, missing key', async () => {
    await setup();
    expect(await t.call('XRANGE', k, '3', '1')).toEqual([]);
    expect(await t.call('XREVRANGE', k, '1', '3')).toEqual([]);
    expect(await t.call('XRANGE', 'xr:none', '-', '+')).toEqual([]);
    expect(await t.call('XRANGE', k, '10', '+')).toEqual([]);
  });

  it('errors', async () => {
    await setup();
    expect.soft(await err(t.call('XRANGE', k, 'abc', '+'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XRANGE', k, '-', 'x-1'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XRANGE', k, '-'))).toBe(arity('xrange'));
    expect.soft(await err(t.call('XREVRANGE', k, '+'))).toBe(arity('xrevrange'));
    await t.call('SET', 'xr:str', 'v');
    expect.soft(await err(t.call('XRANGE', 'xr:str', '-', '+'))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('XREVRANGE', 'xr:str', '+', '-'))).toBe(WRONGTYPE);
  });

  it('wire format in RESP2 and RESP3 (entries stay arrays)', async () => {
    await t.call('XADD', 'xr:wire', '1-0', 'f', 'v');
    const c2 = await t.raw();
    expect(await c2.send('XRANGE', 'xr:wire', '-', '+')).toBe(arr(entry('1-0', 'f', 'v')));
    const c3 = await resp3();
    expect(await c3.send('XRANGE', 'xr:wire', '-', '+')).toBe(arr(entry('1-0', 'f', 'v')));
    expect(await c3.send('XRANGE', 'xr:none', '-', '+')).toBe('*0\r\n');
  });
});

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

// ---------------------------------------------------------------------------
// XREAD
// ---------------------------------------------------------------------------
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

  it('+ returns the last entry', async () => {
    await t.call('XADD', 'xrd:plus', '1-0', 'f', '1');
    await t.call('XADD', 'xrd:plus', '2-0', 'f', '2');
    expect(await t.call('XREAD', 'STREAMS', 'xrd:plus', '+')).toEqual([['xrd:plus', [['2-0', ['f', '2']]]]]);
    expect(await t.call('XREAD', 'COUNT', 10, 'STREAMS', 'xrd:plus', '+')).toEqual([['xrd:plus', [['2-0', ['f', '2']]]]]);
    expect(await t.call('XREAD', 'STREAMS', 'xrd:plus-missing', '+')).toBeNull();
  });

  it('BLOCK wakes up on XADD from another client', async () => {
    await t.call('XADD', 'xrd:blk', '1-0', 'f', 'old');
    const c = t.client();
    const p = c.call('XREAD', 'BLOCK', '0', 'STREAMS', 'xrd:blk', '$');
    await sleep(50);
    await t.call('XADD', 'xrd:blk', '2-0', 'f', 'new');
    expect(await p).toEqual([['xrd:blk', [['2-0', ['f', 'new']]]]]);
  });

  it('BLOCK on a missing key with $ wakes when the stream is created', async () => {
    const c = t.client();
    const p = c.call('XREAD', 'BLOCK', '2000', 'STREAMS', 'xrd:blk2', '$');
    await sleep(50);
    await t.call('XADD', 'xrd:blk2', '7-0', 'f', 'v');
    expect(await p).toEqual([['xrd:blk2', [['7-0', ['f', 'v']]]]]);
  });

  it('BLOCK returns immediately when data is available', async () => {
    await t.call('XADD', 'xrd:blk3', '1-0', 'f', 'v');
    const start = Date.now();
    expect(await t.call('XREAD', 'BLOCK', '5000', 'STREAMS', 'xrd:blk3', '0')).toEqual([['xrd:blk3', [['1-0', ['f', 'v']]]]]);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('BLOCK timeout returns nil (RESP2 *-1, RESP3 _)', async () => {
    const start = Date.now();
    expect(await t.call('XREAD', 'BLOCK', '100', 'STREAMS', 'xrd:timeout', '$')).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
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
    await sleep(50);
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
      "ERR Unbalanced 'xread' list of streams: for each stream key an ID or '$' must be specified.",
    );
    expect.soft(await err(t.call('XREAD', 'STREAMS', 'xrd:e', 'xrd:e2', '0'))).toBe(
      "ERR Unbalanced 'xread' list of streams: for each stream key an ID or '$' must be specified.",
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

// ---------------------------------------------------------------------------
// Consumer groups
// ---------------------------------------------------------------------------
describe('XGROUP', () => {
  it('CREATE on an existing stream, BUSYGROUP, $ and ids', async () => {
    await t.call('XADD', 'xg:s', '1-0', 'f', 'v');
    expect(await t.call('XGROUP', 'CREATE', 'xg:s', 'g1', '0')).toBe('OK');
    expect(await t.call('XGROUP', 'CREATE', 'xg:s', 'g2', '$')).toBe('OK');
    expect(await t.call('XGROUP', 'CREATE', 'xg:s', 'g3', '1-0')).toBe('OK');
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:s', 'g1', '0'))).toBe('BUSYGROUP Consumer Group name already exists');
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:s', 'g4', 'bad'))).toBe(INVALID_ID);
    const groups = (await t.call('XINFO', 'GROUPS', 'xg:s')) as unknown[][];
    expect(groups.map((g) => toMap(g).name)).toEqual(['g1', 'g2', 'g3']);
    expect(toMap(groups[1])['last-delivered-id']).toBe('1-0');
    expect(toMap(groups[0])['last-delivered-id']).toBe('0-0');
  });

  it('CREATE on a missing key needs MKSTREAM', async () => {
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:none', 'g', '$'))).toBe(
      'ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.',
    );
    expect(await t.call('XGROUP', 'CREATE', 'xg:mk', 'g', '$', 'MKSTREAM')).toBe('OK');
    expect(await t.call('EXISTS', 'xg:mk')).toBe(1);
    expect(await t.call('TYPE', 'xg:mk')).toBe('stream');
    expect(await t.call('XLEN', 'xg:mk')).toBe(0);
  });

  it('CREATE with ENTRIESREAD', async () => {
    for (let i = 1; i <= 5; i++) await t.call('XADD', 'xg:er', `${i}-0`, 'f', 'v');
    expect(await t.call('XGROUP', 'CREATE', 'xg:er', 'g', '2-0', 'ENTRIESREAD', 2)).toBe('OK');
    const g = toMap(((await t.call('XINFO', 'GROUPS', 'xg:er')) as unknown[][])[0]);
    expect(g['entries-read']).toBe(2);
    expect(g.lag).toBe(3);
  });

  it('SETID', async () => {
    for (let i = 1; i <= 3; i++) await t.call('XADD', 'xg:setid', `${i}-0`, 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xg:setid', 'g', '$');
    expect(await t.call('XGROUP', 'SETID', 'xg:setid', 'g', '0')).toBe('OK');
    const r = (await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xg:setid', '>')) as Array<[string, Array<[string]>]>;
    expect(r[0][1].map((e) => e[0])).toEqual(['1-0', '2-0', '3-0']);
    expect(await t.call('XGROUP', 'SETID', 'xg:setid', 'g', '$')).toBe('OK');
    expect(await t.call('XGROUP', 'SETID', 'xg:setid', 'g', '1-0', 'ENTRIESREAD', 1)).toBe('OK');
    const g = toMap(((await t.call('XINFO', 'GROUPS', 'xg:setid')) as unknown[][])[0]);
    expect(g['last-delivered-id']).toBe('1-0');
    expect(g['entries-read']).toBe(1);
    expect(g.lag).toBe(2);
    expect.soft(await err(t.call('XGROUP', 'SETID', 'xg:setid', 'nog', '0'))).toBe("NOGROUP No such consumer group 'nog' for key name 'xg:setid'");
    expect.soft(await err(t.call('XGROUP', 'SETID', 'xg:nokey', 'g', '0'))).toBe(
      'ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.',
    );
  });

  it('CREATECONSUMER / DELCONSUMER / DESTROY', async () => {
    await t.call('XADD', 'xg:cons', '1-0', 'f', 'v');
    await t.call('XADD', 'xg:cons', '2-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xg:cons', 'g', '0');
    expect(await t.call('XGROUP', 'CREATECONSUMER', 'xg:cons', 'g', 'alice')).toBe(1);
    expect(await t.call('XGROUP', 'CREATECONSUMER', 'xg:cons', 'g', 'alice')).toBe(0);
    await t.call('XREADGROUP', 'GROUP', 'g', 'bob', 'STREAMS', 'xg:cons', '>');
    const cons = (await t.call('XINFO', 'CONSUMERS', 'xg:cons', 'g')) as unknown[][];
    expect(cons.map((c) => [toMap(c).name, toMap(c).pending])).toEqual([
      ['alice', 0],
      ['bob', 2],
    ]);
    expect(await t.call('XGROUP', 'DELCONSUMER', 'xg:cons', 'g', 'bob')).toBe(2);
    expect(await t.call('XGROUP', 'DELCONSUMER', 'xg:cons', 'g', 'bob')).toBe(0);
    expect(await t.call('XGROUP', 'DELCONSUMER', 'xg:cons', 'g', 'alice')).toBe(0);
    expect(await t.call('XINFO', 'CONSUMERS', 'xg:cons', 'g')).toEqual([]);
    // the deleted consumer's pending entries are gone from the PEL
    expect((await t.call('XPENDING', 'xg:cons', 'g')) as unknown[]).toEqual([0, null, null, null]);
    expect.soft(await err(t.call('XGROUP', 'CREATECONSUMER', 'xg:cons', 'nog', 'x'))).toBe(
      "NOGROUP No such consumer group 'nog' for key name 'xg:cons'",
    );
    expect.soft(await err(t.call('XGROUP', 'DELCONSUMER', 'xg:cons', 'nog', 'x'))).toBe(
      "NOGROUP No such consumer group 'nog' for key name 'xg:cons'",
    );
    expect(await t.call('XGROUP', 'DESTROY', 'xg:cons', 'g')).toBe(1);
    expect(await t.call('XGROUP', 'DESTROY', 'xg:cons', 'g')).toBe(0);
    expect(await t.call('XINFO', 'GROUPS', 'xg:cons')).toEqual([]);
  });

  it('errors: unknown subcommand, arity, wrong type', async () => {
    await t.call('XADD', 'xg:e', '1-0', 'f', 'v');
    expect.soft(await err(t.call('XGROUP', 'FOO', 'xg:e'))).toBe("ERR unknown subcommand 'FOO'. Try XGROUP HELP.");
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:e', 'g'))).toBe(arity('xgroup|create'));
    expect.soft(await err(t.call('XGROUP', 'DESTROY', 'xg:e'))).toBe(arity('xgroup|destroy'));
    // unverified (fairly sure): addReplySubcommandSyntaxError text
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:e', 'g', '0', 'FOO'))).toBe(
      "ERR unknown subcommand or wrong number of arguments for 'CREATE'. Try XGROUP HELP.",
    );
    expect.soft(await err(t.call('XGROUP'))).toBe(arity('xgroup'));
    await t.call('SET', 'xg:str', 'v');
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:str', 'g', '$'))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:str', 'g', '$', 'MKSTREAM'))).toBe(WRONGTYPE);
    expect(Array.isArray(await t.call('XGROUP', 'HELP'))).toBe(true);
  });
});

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
    await sleep(50);
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
      "ERR Unbalanced 'xreadgroup' list of streams: for each stream key an ID or '>' must be specified.",
    );
    expect.soft(await err(t.call('XREADGROUP', 'COUNT', 1, 'BLOCK', 10, 'STREAMS', 'xrg:e', '>'))).toBe('ERR Missing GROUP option for XREADGROUP');
    expect.soft(await err(t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:e', 'bad'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XREADGROUP', 'GROUP', 'g'))).toBe(arity('xreadgroup'));
    await t.call('SET', 'xrg:str', 'v');
    expect.soft(await err(t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xrg:str', '>'))).toBe(WRONGTYPE);
  });
});

describe('XACK', () => {
  it('acknowledges pending ids', async () => {
    for (let i = 1; i <= 3; i++) await t.call('XADD', 'xack:s', `${i}-0`, 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xack:s', 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xack:s', '>');
    expect(await t.call('XACK', 'xack:s', 'g', '1-0')).toBe(1);
    expect(await t.call('XACK', 'xack:s', 'g', '1-0', '2-0', '3-0', '9-0')).toBe(2);
    expect(await t.call('XACK', 'xack:s', 'g', '1-0')).toBe(0);
    expect(await t.call('XACK', 'xack:s', 'nog', '1-0')).toBe(0);
    expect(await t.call('XACK', 'xack:none', 'g', '1-0')).toBe(0);
    expect((await t.call('XPENDING', 'xack:s', 'g') as unknown[])[0]).toBe(0);
  });

  it('errors', async () => {
    await t.call('XADD', 'xack:e', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xack:e', 'g', '0');
    expect.soft(await err(t.call('XACK', 'xack:e', 'g', 'bad'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XACK', 'xack:e', 'g'))).toBe(arity('xack'));
    await t.call('SET', 'xack:str', 'v');
    expect.soft(await err(t.call('XACK', 'xack:str', 'g', '1-0'))).toBe(WRONGTYPE);
  });
});

describe('XPENDING', () => {
  const k = 'xp:s';
  const setup = async () => {
    if ((await t.call('EXISTS', k)) === 1) return;
    for (let i = 1; i <= 5; i++) await t.call('XADD', k, `${i}-0`, 'f', 'v');
    await t.call('XGROUP', 'CREATE', k, 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'alice', 'COUNT', 2, 'STREAMS', k, '>');
    await t.call('XREADGROUP', 'GROUP', 'g', 'bob', 'COUNT', 3, 'STREAMS', k, '>');
  };

  it('summary form', async () => {
    await setup();
    expect(await t.call('XPENDING', k, 'g')).toEqual([5, '1-0', '5-0', [['alice', '2'], ['bob', '3']]]);
  });

  it('summary of an empty group (RESP2 and RESP3)', async () => {
    await t.call('XGROUP', 'CREATE', 'xp:empty', 'g', '$', 'MKSTREAM');
    expect(await t.call('XPENDING', 'xp:empty', 'g')).toEqual([0, null, null, null]);
    const c2 = await t.raw();
    expect(await c2.send('XPENDING', 'xp:empty', 'g')).toBe('*4\r\n:0\r\n$-1\r\n$-1\r\n*-1\r\n');
    const c3 = await resp3();
    expect(await c3.send('XPENDING', 'xp:empty', 'g')).toBe('*4\r\n:0\r\n_\r\n_\r\n_\r\n');
  });

  it('extended form, COUNT, consumer filter, ranges', async () => {
    await setup();
    const all = (await t.call('XPENDING', k, 'g', '-', '+', 10)) as Array<[string, string, number, number]>;
    expect(all.map((e) => [e[0], e[1], e[3]])).toEqual([
      ['1-0', 'alice', 1],
      ['2-0', 'alice', 1],
      ['3-0', 'bob', 1],
      ['4-0', 'bob', 1],
      ['5-0', 'bob', 1],
    ]);
    for (const e of all) {
      expect(typeof e[2]).toBe('number');
      expect(e[2]).toBeGreaterThanOrEqual(0);
    }
    expect(((await t.call('XPENDING', k, 'g', '-', '+', 2)) as unknown[]).length).toBe(2);
    expect(((await t.call('XPENDING', k, 'g', '-', '+', 10, 'bob')) as Array<[string]>).map((e) => e[0])).toEqual(['3-0', '4-0', '5-0']);
    expect(((await t.call('XPENDING', k, 'g', '2', '4', 10)) as Array<[string]>).map((e) => e[0])).toEqual(['2-0', '3-0', '4-0']);
    expect(((await t.call('XPENDING', k, 'g', '(2-0', '+', 10)) as Array<[string]>).map((e) => e[0])).toEqual(['3-0', '4-0', '5-0']);
    expect(await t.call('XPENDING', k, 'g', '-', '+', 10, 'nobody')).toEqual([]);
    expect(await t.call('XPENDING', k, 'g', '-', '+', 0)).toEqual([]);
  });

  it('IDLE filter', async () => {
    await setup();
    expect(await t.call('XPENDING', k, 'g', 'IDLE', 100000, '-', '+', 10)).toEqual([]);
    await sleep(30);
    expect(((await t.call('XPENDING', k, 'g', 'IDLE', 20, '-', '+', 10, 'alice')) as unknown[]).length).toBe(2);
  });

  it('errors', async () => {
    await setup();
    expect.soft(await err(t.call('XPENDING', k, 'nog'))).toBe("NOGROUP No such key 'xp:s' or consumer group 'nog'");
    expect.soft(await err(t.call('XPENDING', 'xp:missing', 'g'))).toBe("NOGROUP No such key 'xp:missing' or consumer group 'g'");
    expect.soft(await err(t.call('XPENDING', k, 'g', '-', '+'))).toBe('ERR syntax error');
    expect.soft(await err(t.call('XPENDING', k, 'g', '-', '+', 'x'))).toBe(NOT_INT);
    expect.soft(await err(t.call('XPENDING', k, 'g', 'bad', '+', 10))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XPENDING', k))).toBe(arity('xpending'));
    await t.call('SET', 'xp:str', 'v');
    expect.soft(await err(t.call('XPENDING', 'xp:str', 'g'))).toBe(WRONGTYPE);
  });
});

describe('XCLAIM', () => {
  const prep = async (key: string, n = 3) => {
    for (let i = 1; i <= n; i++) await t.call('XADD', key, `${i}-0`, 'f', String(i));
    await t.call('XGROUP', 'CREATE', key, 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'alice', 'STREAMS', key, '>');
  };
  const pending = async (key: string) => (await t.call('XPENDING', key, 'g', '-', '+', 100)) as Array<[string, string, number, number]>;

  it('claims idle entries and increments deliveries', async () => {
    await prep('xc:s');
    await sleep(20);
    expect(await t.call('XCLAIM', 'xc:s', 'g', 'bob', 10, '1-0', '2-0')).toEqual([
      ['1-0', ['f', '1']],
      ['2-0', ['f', '2']],
    ]);
    const p = await pending('xc:s');
    expect(p.map((e) => [e[0], e[1], e[3]])).toEqual([
      ['1-0', 'bob', 2],
      ['2-0', 'bob', 2],
      ['3-0', 'alice', 1],
    ]);
    expect(p[0][2]).toBeLessThan(20); // idle reset on claim
  });

  it('min-idle-time not reached: nothing claimed', async () => {
    await prep('xc:fresh');
    expect(await t.call('XCLAIM', 'xc:fresh', 'g', 'bob', 1_000_000, '1-0')).toEqual([]);
    expect((await pending('xc:fresh'))[0][1]).toBe('alice');
  });

  it('JUSTID returns ids and does not increment deliveries', async () => {
    await prep('xc:jid');
    expect(await t.call('XCLAIM', 'xc:jid', 'g', 'bob', 0, '1-0', '3-0', 'JUSTID')).toEqual(['1-0', '3-0']);
    const p = await pending('xc:jid');
    expect(p.map((e) => [e[0], e[1], e[3]])).toEqual([
      ['1-0', 'bob', 1],
      ['2-0', 'alice', 1],
      ['3-0', 'bob', 1],
    ]);
  });

  it('IDLE, TIME, RETRYCOUNT', async () => {
    await prep('xc:opts');
    await t.call('XCLAIM', 'xc:opts', 'g', 'bob', 0, '1-0', 'IDLE', 50000, 'RETRYCOUNT', 7);
    let p = await pending('xc:opts');
    expect(p[0][1]).toBe('bob');
    expect(p[0][2]).toBeGreaterThanOrEqual(50000);
    expect(p[0][2]).toBeLessThan(55000);
    expect(p[0][3]).toBe(7);
    await t.call('XCLAIM', 'xc:opts', 'g', 'carol', 0, '2-0', 'TIME', Date.now() - 30000, 'JUSTID');
    p = await pending('xc:opts');
    expect(p[1][1]).toBe('carol');
    expect(p[1][2]).toBeGreaterThanOrEqual(30000);
    expect(p[1][2]).toBeLessThan(35000);
    expect(p[1][3]).toBe(1);
  });

  it('FORCE creates a PEL entry for an existing but unpending id', async () => {
    for (let i = 1; i <= 3; i++) await t.call('XADD', 'xc:force', `${i}-0`, 'f', String(i));
    await t.call('XGROUP', 'CREATE', 'xc:force', 'g', '$');
    expect(await t.call('XCLAIM', 'xc:force', 'g', 'bob', 0, '2-0')).toEqual([]);
    expect(await t.call('XCLAIM', 'xc:force', 'g', 'bob', 0, '2-0', 'FORCE')).toEqual([['2-0', ['f', '2']]]);
    // FORCE on an id not in the stream does nothing
    expect(await t.call('XCLAIM', 'xc:force', 'g', 'bob', 0, '9-0', 'FORCE')).toEqual([]);
    const p = await pending('xc:force');
    expect(p.map((e) => [e[0], e[1]])).toEqual([['2-0', 'bob']]);
  });

  it('LASTID advances the group last id', async () => {
    await prep('xc:lastid');
    await t.call('XGROUP', 'SETID', 'xc:lastid', 'g', '1-0');
    await t.call('XCLAIM', 'xc:lastid', 'g', 'bob', 0, '1-0', 'LASTID', '3-0');
    expect(toMap(((await t.call('XINFO', 'GROUPS', 'xc:lastid')) as unknown[][])[0])['last-delivered-id']).toBe('3-0');
    // a smaller LASTID does not move it back
    await t.call('XCLAIM', 'xc:lastid', 'g', 'bob', 0, '1-0', 'LASTID', '2-0');
    expect(toMap(((await t.call('XINFO', 'GROUPS', 'xc:lastid')) as unknown[][])[0])['last-delivered-id']).toBe('3-0');
  });

  it('deleted entries are dropped from the PEL and not returned', async () => {
    await prep('xc:del');
    await t.call('XDEL', 'xc:del', '2-0');
    expect(await t.call('XCLAIM', 'xc:del', 'g', 'bob', 0, '1-0', '2-0', '3-0')).toEqual([
      ['1-0', ['f', '1']],
      ['3-0', ['f', '3']],
    ]);
    expect((await pending('xc:del')).map((e) => e[0])).toEqual(['1-0', '3-0']);
  });

  it('creates the claiming consumer', async () => {
    await prep('xc:newc');
    await t.call('XCLAIM', 'xc:newc', 'g', 'zed', 0, '1-0');
    const names = ((await t.call('XINFO', 'CONSUMERS', 'xc:newc', 'g')) as unknown[][]).map((c) => toMap(c).name);
    expect(names).toEqual(['alice', 'zed']);
  });

  it('errors', async () => {
    await prep('xc:e');
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'nog', 'bob', 0, '1-0'))).toBe("NOGROUP No such key 'xc:e' or consumer group 'nog'");
    expect.soft(await err(t.call('XCLAIM', 'xc:missing', 'g', 'bob', 0, '1-0'))).toBe(
      "NOGROUP No such key 'xc:missing' or consumer group 'g'",
    );
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 'x', '1-0'))).toBe('ERR Invalid min-idle-time argument for XCLAIM');
    // ids are parsed until the first non-id, which is then treated as an option
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 0, 'bad'))).toBe("ERR Unrecognized XCLAIM option 'bad'");
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 0, '1-0', 'IDLE', 'x'))).toBe('ERR Invalid IDLE option argument for XCLAIM');
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 0, '1-0', 'TIME', 'x'))).toBe('ERR Invalid TIME option argument for XCLAIM');
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 0, '1-0', 'RETRYCOUNT', 'x'))).toBe(
      'ERR Invalid RETRYCOUNT option argument for XCLAIM',
    );
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 0))).toBe(arity('xclaim'));
    await t.call('SET', 'xc:str', 'v');
    expect.soft(await err(t.call('XCLAIM', 'xc:str', 'g', 'bob', 0, '1-0'))).toBe(WRONGTYPE);
  });
});

describe('XAUTOCLAIM', () => {
  const prep = async (key: string, n: number) => {
    for (let i = 1; i <= n; i++) await t.call('XADD', key, `${i}-0`, 'f', String(i));
    await t.call('XGROUP', 'CREATE', key, 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'alice', 'STREAMS', key, '>');
  };

  it('claims everything with cursor 0-0', async () => {
    await prep('xac:s', 2);
    expect(await t.call('XAUTOCLAIM', 'xac:s', 'g', 'bob', 0, '0-0')).toEqual([
      '0-0',
      [
        ['1-0', ['f', '1']],
        ['2-0', ['f', '2']],
      ],
      [],
    ]);
    const p = (await t.call('XPENDING', 'xac:s', 'g', '-', '+', 10)) as Array<[string, string, number, number]>;
    expect(p.map((e) => [e[1], e[3]])).toEqual([
      ['bob', 2],
      ['bob', 2],
    ]);
  });

  it('COUNT and cursor iteration', async () => {
    await prep('xac:cur', 5);
    expect(await t.call('XAUTOCLAIM', 'xac:cur', 'g', 'bob', 0, '0', 'COUNT', 2)).toEqual([
      '3-0',
      [
        ['1-0', ['f', '1']],
        ['2-0', ['f', '2']],
      ],
      [],
    ]);
    expect(await t.call('XAUTOCLAIM', 'xac:cur', 'g', 'bob', 0, '3-0', 'COUNT', 2, 'JUSTID')).toEqual(['5-0', ['3-0', '4-0'], []]);
    expect(await t.call('XAUTOCLAIM', 'xac:cur', 'g', 'bob', 0, '5-0', 'COUNT', 2, 'JUSTID')).toEqual(['0-0', ['5-0'], []]);
    // JUSTID did not bump deliveries
    const p = (await t.call('XPENDING', 'xac:cur', 'g', '-', '+', 10)) as Array<[string, string, number, number]>;
    expect(p.map((e) => e[3])).toEqual([2, 2, 1, 1, 1]);
  });

  it('min-idle-time filters', async () => {
    await prep('xac:idle', 2);
    expect(await t.call('XAUTOCLAIM', 'xac:idle', 'g', 'bob', 1_000_000, '0')).toEqual(['0-0', [], []]);
  });

  it('deleted entries are reported and removed from the PEL', async () => {
    await prep('xac:del', 3);
    await t.call('XDEL', 'xac:del', '1-0', '3-0');
    expect(await t.call('XAUTOCLAIM', 'xac:del', 'g', 'bob', 0, '0')).toEqual(['0-0', [['2-0', ['f', '2']]], ['1-0', '3-0']]);
    expect(((await t.call('XPENDING', 'xac:del', 'g')) as unknown[])[0]).toBe(1);
  });

  it('errors', async () => {
    await prep('xac:e', 1);
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:e', 'nog', 'bob', 0, '0'))).toBe("NOGROUP No such key 'xac:e' or consumer group 'nog'");
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:e', 'g', 'bob', 0, '0', 'COUNT', 0))).toBe(
      'ERR COUNT must be > 0',
    );
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:e', 'g', 'bob', 0, 'bad'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:e', 'g', 'bob', 0, '0', 'FOO'))).toBe('ERR syntax error');
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:e', 'g', 'bob', 0))).toBe(arity('xautoclaim'));
    await t.call('SET', 'xac:str', 'v');
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:str', 'g', 'bob', 0, '0'))).toBe(WRONGTYPE);
  });
});

// ---------------------------------------------------------------------------
// XINFO / XSETID
// ---------------------------------------------------------------------------
describe('XINFO', () => {
  it('STREAM fields, order and values', async () => {
    for (let i = 1; i <= 3; i++) await t.call('XADD', 'xi:s', `${i}-0`, 'f', String(i));
    await t.call('XDEL', 'xi:s', '2-0');
    await t.call('XGROUP', 'CREATE', 'xi:s', 'g', '0');
    const flat = (await t.call('XINFO', 'STREAM', 'xi:s')) as unknown[];
    expectOrderedFields(flat, [
      'length',
      'radix-tree-keys',
      'radix-tree-nodes',
      'last-generated-id',
      'max-deleted-entry-id',
      'entries-added',
      'recorded-first-entry-id',
      'groups',
      'first-entry',
      'last-entry',
    ]);
    const m = toMap(flat);
    expect(m.length).toBe(2);
    expect(m['radix-tree-keys']).toBe(1);
    expect(m['last-generated-id']).toBe('3-0');
    expect(m['max-deleted-entry-id']).toBe('2-0');
    expect(m['entries-added']).toBe(3);
    expect(m['recorded-first-entry-id']).toBe('1-0');
    expect(m.groups).toBe(1);
    expect(m['first-entry']).toEqual(['1-0', ['f', '1']]);
    expect(m['last-entry']).toEqual(['3-0', ['f', '3']]);
  });

  it('STREAM on an empty stream has nil first/last entry', async () => {
    await t.call('XGROUP', 'CREATE', 'xi:empty', 'g', '$', 'MKSTREAM');
    const m = toMap((await t.call('XINFO', 'STREAM', 'xi:empty')) as unknown[]);
    expect(m.length).toBe(0);
    expect(m['last-generated-id']).toBe('0-0');
    expect(m['entries-added']).toBe(0);
    expect(m['first-entry']).toBeNull();
    expect(m['last-entry']).toBeNull();
  });

  it('STREAM in RESP3 is a map', async () => {
    await t.call('XADD', 'xi:r3', '1-0', 'f', 'v');
    const c3 = await resp3();
    const out = await c3.send('XINFO', 'STREAM', 'xi:r3');
    expect(out.startsWith('%')).toBe(true);
    expect(out).toContain(`${bulk('length')}:1\r\n`);
    expect(out).toContain(`${bulk('first-entry')}${entry('1-0', 'f', 'v')}`);
    expect(out).toContain(`${bulk('last-generated-id')}${bulk('1-0')}`);
  });

  it('STREAM FULL', async () => {
    await t.call('XADD', 'xi:full', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xi:full', 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xi:full', '>');
    const m = toMap((await t.call('XINFO', 'STREAM', 'xi:full', 'FULL')) as unknown[]);
    expect(m.length).toBe(1);
    expect(m.entries).toEqual([['1-0', ['f', 'v']]]);
    const groups = m.groups as unknown[][];
    const g = toMap(groups[0]);
    expect(g.name).toBe('g');
    expect(g['last-delivered-id']).toBe('1-0');
    expect(g['entries-read']).toBe(1);
    expect(g.lag).toBe(0);
    expect(g['pel-count']).toBe(1);
  });

  it('GROUPS fields, entries-read and lag', async () => {
    for (let i = 1; i <= 3; i++) await t.call('XADD', 'xi:g', `${i}-0`, 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xi:g', 'g', '0');
    let flat = ((await t.call('XINFO', 'GROUPS', 'xi:g')) as unknown[][])[0];
    expect(flat.filter((_, i) => i % 2 === 0)).toEqual(['name', 'consumers', 'pending', 'last-delivered-id', 'entries-read', 'lag']);
    expect(flat).toEqual(['name', 'g', 'consumers', 0, 'pending', 0, 'last-delivered-id', '0-0', 'entries-read', null, 'lag', 3]);
    await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'COUNT', 2, 'STREAMS', 'xi:g', '>');
    flat = ((await t.call('XINFO', 'GROUPS', 'xi:g')) as unknown[][])[0];
    expect(flat).toEqual(['name', 'g', 'consumers', 1, 'pending', 2, 'last-delivered-id', '2-0', 'entries-read', 2, 'lag', 1]);
    await t.call('XADD', 'xi:g', '4-0', 'f', 'v');
    expect(toMap(((await t.call('XINFO', 'GROUPS', 'xi:g')) as unknown[][])[0]).lag).toBe(2);
    await t.call('XGROUP', 'CREATE', 'xi:g', 'g2', '$');
    const g2 = toMap(((await t.call('XINFO', 'GROUPS', 'xi:g')) as unknown[][])[1]);
    expect(g2['entries-read']).toBe(4);
    expect(g2.lag).toBe(0);
  });

  it('CONSUMERS fields', async () => {
    await t.call('XADD', 'xi:c', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xi:c', 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'c1', 'STREAMS', 'xi:c', '>');
    await t.call('XGROUP', 'CREATECONSUMER', 'xi:c', 'g', 'c2');
    const cons = (await t.call('XINFO', 'CONSUMERS', 'xi:c', 'g')) as unknown[][];
    expect(cons).toHaveLength(2);
    expect(cons[0].filter((_, i) => i % 2 === 0)).toEqual(['name', 'pending', 'idle', 'inactive']);
    const c1 = toMap(cons[0]);
    expect(c1.name).toBe('c1');
    expect(c1.pending).toBe(1);
    expect(typeof c1.idle).toBe('number');
    expect(typeof c1.inactive).toBe('number');
    const c2 = toMap(cons[1]);
    expect(c2.name).toBe('c2');
    expect(c2.pending).toBe(0);
    expect(c2.inactive).toBe(-1); // never attempted a read
  });

  it('GROUPS / CONSUMERS in RESP3 are arrays of maps', async () => {
    await t.call('XADD', 'xi:r3g', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xi:r3g', 'g', '0');
    await t.call('XGROUP', 'CREATECONSUMER', 'xi:r3g', 'g', 'c');
    const c3 = await resp3();
    expect(await c3.send('XINFO', 'GROUPS', 'xi:r3g')).toBe(
      `*1\r\n%6\r\n${bulk('name')}${bulk('g')}${bulk('consumers')}:1\r\n${bulk('pending')}:0\r\n` +
        `${bulk('last-delivered-id')}${bulk('0-0')}${bulk('entries-read')}_\r\n${bulk('lag')}:1\r\n`,
    );
    const cons = await c3.send('XINFO', 'CONSUMERS', 'xi:r3g', 'g');
    expect(cons.startsWith(`*1\r\n%4\r\n${bulk('name')}${bulk('c')}${bulk('pending')}:0\r\n${bulk('idle')}:`)).toBe(true);
  });

  it('errors', async () => {
    expect.soft(await err(t.call('XINFO', 'STREAM', 'xi:none'))).toBe('ERR no such key');
    expect.soft(await err(t.call('XINFO', 'GROUPS', 'xi:none'))).toBe('ERR no such key');
    await t.call('XADD', 'xi:e', '1-0', 'f', 'v');
    expect.soft(await err(t.call('XINFO', 'CONSUMERS', 'xi:e', 'nog'))).toBe("NOGROUP No such consumer group 'nog' for key name 'xi:e'");
    expect.soft(await err(t.call('XINFO', 'FOO', 'xi:e'))).toBe("ERR unknown subcommand 'FOO'. Try XINFO HELP.");
    expect.soft(await err(t.call('XINFO', 'STREAM'))).toBe(arity('xinfo|stream'));
    await t.call('SET', 'xi:str', 'v');
    expect.soft(await err(t.call('XINFO', 'STREAM', 'xi:str'))).toBe(WRONGTYPE);
  });
});

describe('XSETID', () => {
  it('sets the last id and affects XADD', async () => {
    await t.call('XADD', 'xs:s', '1-0', 'f', 'v');
    expect(await t.call('XSETID', 'xs:s', '10-0')).toBe('OK');
    expect(toMap((await t.call('XINFO', 'STREAM', 'xs:s')) as unknown[])['last-generated-id']).toBe('10-0');
    expect.soft(await err(t.call('XADD', 'xs:s', '5-0', 'f', 'v'))).toBe(
      'ERR The ID specified in XADD is equal or smaller than the target stream top item',
    );
    expect(await t.call('XADD', 'xs:s', '10-*', 'f', 'v')).toBe('10-1');
  });

  it('ENTRIESADDED and MAXDELETEDID', async () => {
    await t.call('XADD', 'xs:o', '1-0', 'f', 'v');
    expect(await t.call('XSETID', 'xs:o', '5-0', 'ENTRIESADDED', 10, 'MAXDELETEDID', '3-0')).toBe('OK');
    const m = toMap((await t.call('XINFO', 'STREAM', 'xs:o')) as unknown[]);
    expect(m['entries-added']).toBe(10);
    expect(m['max-deleted-entry-id']).toBe('3-0');
    expect(m['last-generated-id']).toBe('5-0');
  });

  it('errors', async () => {
    await t.call('XADD', 'xs:e', '5-0', 'f', 'v');
    expect.soft(await err(t.call('XSETID', 'xs:e', '4-0'))).toBe('ERR The ID specified in XSETID is smaller than the target stream top item');
    expect.soft(await err(t.call('XSETID', 'xs:none', '1-0'))).toBe('ERR no such key');
    expect.soft(await err(t.call('XSETID', 'xs:e', 'bad'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XSETID', 'xs:e', '9-0', 'ENTRIESADDED', 0))).toBe(
      'ERR The entries_added specified in XSETID is smaller than the target stream length',
    );
    expect.soft(await err(t.call('XSETID', 'xs:e', '9-0', 'MAXDELETEDID', '10-0'))).toBe(
      'ERR The ID specified in XSETID is smaller than the provided max_deleted_entry_id',
    );
    expect.soft(await err(t.call('XSETID', 'xs:e'))).toBe(arity('xsetid'));
    await t.call('SET', 'xs:str', 'v');
    expect.soft(await err(t.call('XSETID', 'xs:str', '1-0'))).toBe(WRONGTYPE);
  });
});
