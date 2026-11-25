import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { arity, arr, entry, err, INVALID_ID, NOT_INT, openResp3, WRONGTYPE } from './streams.test_helpers';

/**
 * XLEN, XRANGE, XREVRANGE (streams.range.service).
 * Checked against the behaviour of Redis Open Source 8.8 (redis.io command docs, t_stream.c / pubsub.c reply and
 * error strings).
 */
const t = useServer();
const resp3 = () => openResp3(t);

// ============================================================================
// XLEN / XRANGE / XREVRANGE
// ============================================================================
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
