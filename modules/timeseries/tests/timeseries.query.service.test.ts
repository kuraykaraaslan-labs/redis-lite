/**
 * TS.QUERYINDEX, TS.MGET, TS.MRANGE / TS.MREVRANGE (timeseries.query.service): every filter form, label selection,
 * GROUPBY … REDUCE, RESP3 shapes. Fixtures and expectations follow the redis.io examples of these commands.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { err, resp3Client, SYNTAX, useServer } from '@/tests/helpers';

const t = useServer();

beforeAll(async () => {
  // TS.QUERYINDEX example
  await t.call('TS.CREATE', 'telemetry:study:temperature', 'LABELS', 'room', 'study', 'type', 'temperature');
  await t.call('TS.CREATE', 'telemetry:study:humidity', 'LABELS', 'room', 'study', 'type', 'humidity');
  await t.call('TS.CREATE', 'telemetry:kitchen:temperature', 'LABELS', 'room', 'kitchen', 'type', 'temperature');
  await t.call('TS.CREATE', 'telemetry:kitchen:humidity', 'LABELS', 'room', 'kitchen', 'type', 'humidity');
  // TS.MGET example
  await t.call('TS.CREATE', 'temp:TLV', 'LABELS', 'type', 'temp', 'location', 'TLV');
  await t.call('TS.CREATE', 'temp:JLM', 'LABELS', 'type', 'temp', 'location', 'JLM');
  await t.call('TS.MADD', 'temp:TLV', 1000, 30, 'temp:TLV', 1010, 35, 'temp:TLV', 1020, 9999, 'temp:TLV', 1030, 40);
  await t.call('TS.MADD', 'temp:JLM', 1005, 30, 'temp:JLM', 1015, 35, 'temp:JLM', 1025, 9999, 'temp:JLM', 1035, 40);
  // TS.MRANGE example
  await t.call('TS.CREATE', 'stock:A', 'LABELS', 'type', 'stock', 'name', 'A');
  await t.call('TS.CREATE', 'stock:B', 'LABELS', 'type', 'stock', 'name', 'B');
  await t.call('TS.MADD', 'stock:A', 1000, 100, 'stock:A', 1010, 110, 'stock:A', 1020, 120);
  await t.call('TS.MADD', 'stock:B', 1000, 120, 'stock:B', 1010, 110, 'stock:B', 1020, 100);
  // not a series: never reported
  await t.call('HSET', 'room=kitchen', 'room', 'kitchen');
});

// ============================================================================
// TS.QUERYINDEX
// ============================================================================

describe('TS.QUERYINDEX', () => {
  it('selects by label (docs example)', async () => {
    expect(await t.call('TS.QUERYINDEX', 'room=kitchen')).toEqual(['telemetry:kitchen:humidity', 'telemetry:kitchen:temperature']);
    expect(await t.call('TS.QUERYINDEX', 'type=temperature')).toEqual(['telemetry:kitchen:temperature', 'telemetry:study:temperature']);
  });

  it('supports every filter form', async () => {
    const q = (...f: string[]): Promise<unknown> => t.call('TS.QUERYINDEX', ...f);
    expect(await q('room=kitchen', 'type!=humidity')).toEqual(['telemetry:kitchen:temperature']);
    expect(await q('type=(temperature,humidity)', 'room!=(study)')).toEqual(['telemetry:kitchen:humidity', 'telemetry:kitchen:temperature']);
    expect(await q('type=temp', 'location=')).toEqual([]);
    expect(await q('type=temp', 'location!=')).toEqual(['temp:JLM', 'temp:TLV']);
    expect(await q('type=temp', 'room=')).toEqual(['temp:JLM', 'temp:TLV']);
    expect(await q('type=(temp,stock)', 'name!=A')).toEqual(['stock:B', 'temp:JLM', 'temp:TLV']);
    expect(await q('type=(temp,stock)', 'name!=(A,B)')).toEqual(['temp:JLM', 'temp:TLV']);
    expect(await q('type=nothing')).toEqual([]);
  });

  it('needs a label=value matcher; malformed filters are refused', async () => {
    expect(await err(t.call('TS.QUERYINDEX', 'type!=temp'))).toBe('ERR TSDB: please provide at least one matcher');
    expect(await err(t.call('TS.QUERYINDEX', 'type='))).toBe('ERR TSDB: please provide at least one matcher');
    expect(await err(t.call('TS.QUERYINDEX', 'nonsense'))).toBe('ERR TSDB: failed parsing labels');
    expect(await err(t.call('TS.QUERYINDEX', '=x'))).toBe('ERR TSDB: failed parsing labels');
  });

  it('RESP3: a set', async () => {
    const r = await resp3Client(t);
    expect(await r.send('TS.QUERYINDEX', 'location=TLV')).toBe('~1\r\n$8\r\ntemp:TLV\r\n');
  });
});

// ============================================================================
// TS.MGET
// ============================================================================

describe('TS.MGET', () => {
  it('WITHLABELS (docs example)', async () => {
    expect(await t.call('TS.MGET', 'WITHLABELS', 'FILTER', 'type=temp')).toEqual([
      ['temp:JLM', [['type', 'temp'], ['location', 'JLM']], [1035, '40']],
      ['temp:TLV', [['type', 'temp'], ['location', 'TLV']], [1030, '40']],
    ]);
  });

  it('SELECTED_LABELS (docs example) and no labels', async () => {
    expect(await t.call('TS.MGET', 'SELECTED_LABELS', 'location', 'FILTER', 'type=temp')).toEqual([
      ['temp:JLM', [['location', 'JLM']], [1035, '40']],
      ['temp:TLV', [['location', 'TLV']], [1030, '40']],
    ]);
    expect(await t.call('TS.MGET', 'SELECTED_LABELS', 'location', 'unit', 'FILTER', 'location=TLV')).toEqual([
      ['temp:TLV', [['location', 'TLV'], ['unit', null]], [1030, '40']],
    ]);
    expect(await t.call('TS.MGET', 'FILTER', 'room=study')).toEqual([
      ['telemetry:study:humidity', [], []],
      ['telemetry:study:temperature', [], []],
    ]);
  });

  it('errors', async () => {
    expect(await err(t.call('TS.MGET', 'WITHLABELS', 'type=temp'))).toBe('ERR TSDB: missing FILTER argument');
    expect(await err(t.call('TS.MGET', 'WITHLABELS', 'SELECTED_LABELS', 'a', 'FILTER', 'type=temp'))).toBe(
      'ERR TSDB: cannot accept WITHLABELS and SELECT_LABELS together',
    );
    expect(await err(t.call('TS.MGET', 'NOPE', 'FILTER', 'type=temp'))).toBe(SYNTAX);
    expect(await err(t.call('TS.MGET', 'FILTER', 'type!=temp'))).toBe('ERR TSDB: please provide at least one matcher');
  });

  it('RESP3: a map of key → [labels map, sample]', async () => {
    const r = await resp3Client(t);
    expect(await r.send('TS.MGET', 'WITHLABELS', 'FILTER', 'location=TLV')).toBe(
      '%1\r\n$8\r\ntemp:TLV\r\n*2\r\n%2\r\n$4\r\ntype\r\n$4\r\ntemp\r\n$8\r\nlocation\r\n$3\r\nTLV\r\n*2\r\n:1030\r\n,40\r\n',
    );
  });
});

// ============================================================================
// TS.MRANGE / TS.MREVRANGE
// ============================================================================

describe('TS.MRANGE / TS.MREVRANGE', () => {
  it('per-series ranges with labels', async () => {
    expect(await t.call('TS.MRANGE', '-', '+', 'WITHLABELS', 'FILTER', 'type=stock')).toEqual([
      ['stock:A', [['type', 'stock'], ['name', 'A']], [[1000, '100'], [1010, '110'], [1020, '120']]],
      ['stock:B', [['type', 'stock'], ['name', 'B']], [[1000, '120'], [1010, '110'], [1020, '100']]],
    ]);
    expect(await t.call('TS.MREVRANGE', 1010, '+', 'FILTER', 'name=A')).toEqual([['stock:A', [], [[1020, '120'], [1010, '110']]]]);
  });

  it('FILTER_BY_VALUE, COUNT, SELECTED_LABELS and AGGREGATION per series', async () => {
    expect(await t.call('TS.MRANGE', '-', '+', 'FILTER_BY_VALUE', 105, 115, 'FILTER', 'type=stock')).toEqual([
      ['stock:A', [], [[1010, '110']]],
      ['stock:B', [], [[1010, '110']]],
    ]);
    expect(await t.call('TS.MRANGE', '-', '+', 'COUNT', 1, 'SELECTED_LABELS', 'name', 'FILTER', 'type=stock')).toEqual([
      ['stock:A', [['name', 'A']], [[1000, '100']]],
      ['stock:B', [['name', 'B']], [[1000, '120']]],
    ]);
    expect(await t.call('TS.MRANGE', '-', '+', 'AGGREGATION', 'avg', 20, 'FILTER', 'type=stock')).toEqual([
      ['stock:A', [], [[1000, '105'], [1020, '120']]],
      ['stock:B', [], [[1000, '115'], [1020, '100']]],
    ]);
  });

  it('GROUPBY … REDUCE max (docs example)', async () => {
    expect(await t.call('TS.MRANGE', '-', '+', 'WITHLABELS', 'FILTER', 'type=stock', 'GROUPBY', 'type', 'REDUCE', 'max')).toEqual([
      [
        'type=stock',
        [['type', 'stock'], ['__reducer__', 'max'], ['__source__', 'stock:A,stock:B']],
        [[1000, '120'], [1010, '110'], [1020, '120']],
      ],
    ]);
  });

  it('GROUPBY with other reducers, groups ordered by value, MREVRANGE reversed', async () => {
    const group = async (reducer: string): Promise<unknown> =>
      ((await t.call('TS.MRANGE', '-', '+', 'FILTER', 'type=stock', 'GROUPBY', 'type', 'REDUCE', reducer)) as unknown[][])[0][2];
    expect(await group('sum')).toEqual([[1000, '220'], [1010, '220'], [1020, '220']]);
    expect(await group('min')).toEqual([[1000, '100'], [1010, '110'], [1020, '100']]);
    expect(await group('avg')).toEqual([[1000, '110'], [1010, '110'], [1020, '110']]);
    expect(await group('range')).toEqual([[1000, '20'], [1010, '0'], [1020, '20']]);
    expect(await group('count')).toEqual([[1000, '2'], [1010, '2'], [1020, '2']]);
    expect(await group('var.p')).toEqual([[1000, '100'], [1010, '0'], [1020, '100']]);
    expect(await group('std.s')).toEqual([[1000, String(Math.sqrt(200))], [1010, '0'], [1020, String(Math.sqrt(200))]]);
    const byName = (await t.call('TS.MREVRANGE', '-', '+', 'FILTER', 'type=stock', 'GROUPBY', 'name', 'REDUCE', 'max')) as unknown[][];
    expect(byName.map((g) => g[0])).toEqual(['name=A', 'name=B']);
    expect(byName[0][2]).toEqual([[1020, '120'], [1010, '110'], [1000, '100']]);
  });

  it('errors', async () => {
    const M = (...a: Array<string | number>): Promise<string> => err(t.call('TS.MRANGE', '-', '+', ...a));
    expect(await M('WITHLABELS', 'COUNT', 1)).toBe('ERR TSDB: missing FILTER argument');
    expect(await M('FILTER', 'type=stock', 'GROUPBY', 'type')).toBe("ERR TSDB: Couldn't parse GROUPBY");
    expect(await M('FILTER', 'type=stock', 'GROUPBY', 'type', 'REDUCE', 'median')).toBe('ERR TSDB: Unknown REDUCE type');
    expect(await M('FILTER', 'type=stock', 'GROUPBY', 'type', 'REDUCE', 'first')).toBe('ERR TSDB: Unknown REDUCE type');
    expect(await M('WITHLABELS', 'SELECTED_LABELS', 'x', 'FILTER', 'type=stock')).toBe('ERR TSDB: cannot accept WITHLABELS and SELECT_LABELS together');
    expect(await M('BOGUS', 'FILTER', 'type=stock')).toBe(SYNTAX);
    expect(await err(t.call('TS.MRANGE', 'x', '+', 'FILTER', 'type=stock'))).toBe('ERR TSDB: wrong fromTimestamp');
  });

  it('RESP3 shapes', async () => {
    const r = await resp3Client(t);
    expect(await r.send('TS.MRANGE', 1000, 1000, 'SELECTED_LABELS', 'name', 'FILTER', 'name=A')).toBe(
      '%1\r\n$7\r\nstock:A\r\n*3\r\n%1\r\n$4\r\nname\r\n$1\r\nA\r\n%1\r\n$11\r\naggregators\r\n*0\r\n*1\r\n*2\r\n:1000\r\n,100\r\n',
    );
    expect(await r.send('TS.MRANGE', 1000, 1000, 'FILTER', 'type=stock', 'GROUPBY', 'type', 'REDUCE', 'max')).toBe(
      '%1\r\n$10\r\ntype=stock\r\n*4\r\n%1\r\n$4\r\ntype\r\n$5\r\nstock\r\n%1\r\n$8\r\nreducers\r\n*1\r\n$3\r\nmax\r\n' +
        '%1\r\n$7\r\nsources\r\n*2\r\n$7\r\nstock:A\r\n$7\r\nstock:B\r\n*1\r\n*2\r\n:1000\r\n,120\r\n',
    );
  });
});
