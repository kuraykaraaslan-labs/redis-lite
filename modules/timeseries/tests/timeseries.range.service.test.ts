/**
 * TS.GET, TS.RANGE, TS.REVRANGE (timeseries.range.service): filters, COUNT, ALIGN, every aggregator, BUCKETTIMESTAMP,
 * EMPTY, RESP3. The ALIGN and FILTER_BY_VALUE expectations are the redis.io TS.RANGE examples; aggregator values are
 * worked out by hand from the documented definitions.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { err, resp3Client, SYNTAX, useServer } from '@/tests/helpers';

const t = useServer();

const agg = (key: string, aggregator: string, bucket: number, ...extra: Array<string | number>): Promise<unknown> =>
  t.call('TS.RANGE', key, '-', '+', ...extra, 'AGGREGATION', aggregator, bucket);

beforeAll(async () => {
  await t.call('TS.CREATE', 'temp:TLV', 'LABELS', 'type', 'temp', 'location', 'TLV');
  await t.call('TS.MADD', 'temp:TLV', 1000, 30, 'temp:TLV', 1010, 35, 'temp:TLV', 1020, 9999, 'temp:TLV', 1030, 40);
  await t.call('TS.CREATE', 'stock:A', 'LABELS', 'type', 'stock', 'name', 'A');
  await t.call('TS.MADD', 'stock:A', 1000, 100, 'stock:A', 1010, 110, 'stock:A', 1020, 120);
  await t.call('TS.MADD', 'stock:A', 2000, 200, 'stock:A', 2010, 210, 'stock:A', 2020, 220);
  await t.call('TS.MADD', 'stock:A', 3000, 300, 'stock:A', 3010, 310, 'stock:A', 3020, 320);
  // aggregator fixture: buckets of 10 → [0:1, 5:3], [10:2, 15:6], [20:4]
  await t.call('TS.CREATE', 'ag');
  await t.call('TS.MADD', 'ag', 0, 1, 'ag', 5, 3, 'ag', 10, 2, 'ag', 15, 6, 'ag', 20, 4);
});

// ============================================================================
// TS.GET
// ============================================================================

describe('TS.GET', () => {
  it('returns the newest sample, [] for an empty series', async () => {
    expect(await t.call('TS.GET', 'temp:TLV')).toEqual([1030, '40']);
    await t.call('TS.CREATE', 'rg:empty');
    expect(await t.call('TS.GET', 'rg:empty')).toEqual([]);
    expect(await t.call('TS.GET', 'rg:empty', 'LATEST')).toEqual([]);
  });

  it('errors', async () => {
    expect(await err(t.call('TS.GET', 'rg:none'))).toBe('ERR TSDB: the key does not exist');
    expect(await err(t.call('TS.GET', 'temp:TLV', 'NEWEST'))).toBe(SYNTAX);
    expect(await err(t.call('TS.GET', 'temp:TLV', 'LATEST', 'LATEST'))).toBe(SYNTAX);
  });
});

// ============================================================================
// TS.RANGE / TS.REVRANGE: raw samples
// ============================================================================

describe('TS.RANGE / TS.REVRANGE', () => {
  it('filters by value, then aggregates (docs example)', async () => {
    expect(await t.call('TS.RANGE', 'temp:TLV', '-', '+', 'FILTER_BY_VALUE', -100, 100)).toEqual([
      [1000, '30'],
      [1010, '35'],
      [1030, '40'],
    ]);
    expect(await t.call('TS.RANGE', 'temp:TLV', '-', '+', 'FILTER_BY_VALUE', -100, 100, 'AGGREGATION', 'avg', 1000)).toEqual([[1000, '35']]);
  });

  it('bounds are inclusive; REVRANGE returns newest first', async () => {
    expect(await t.call('TS.RANGE', 'temp:TLV', 1010, 1020)).toEqual([[1010, '35'], [1020, '9999']]);
    expect(await t.call('TS.REVRANGE', 'temp:TLV', 1010, 1030)).toEqual([[1030, '40'], [1020, '9999'], [1010, '35']]);
    expect(await t.call('TS.RANGE', 'temp:TLV', 1031, '+')).toEqual([]);
    expect(await t.call('TS.RANGE', 'temp:TLV', 1030, 1000)).toEqual([]);
  });

  it('FILTER_BY_TS and COUNT (COUNT counts from the start of the reply)', async () => {
    expect(await t.call('TS.RANGE', 'temp:TLV', '-', '+', 'FILTER_BY_TS', 1000, 1030, 1005)).toEqual([[1000, '30'], [1030, '40']]);
    expect(await t.call('TS.RANGE', 'temp:TLV', '-', '+', 'COUNT', 2)).toEqual([[1000, '30'], [1010, '35']]);
    expect(await t.call('TS.REVRANGE', 'temp:TLV', '-', '+', 'COUNT', 2)).toEqual([[1030, '40'], [1020, '9999']]);
    expect(await t.call('TS.RANGE', 'temp:TLV', '-', '+', 'FILTER_BY_TS', 1000, 1010, 'FILTER_BY_VALUE', 31, 100)).toEqual([[1010, '35']]);
  });

  it('argument errors', async () => {
    const R = (...a: Array<string | number>): Promise<string> => err(t.call('TS.RANGE', 'temp:TLV', ...a));
    expect(await R('x', '+')).toBe('ERR TSDB: wrong fromTimestamp');
    expect(await R('-', 'y')).toBe('ERR TSDB: wrong toTimestamp');
    expect(await R('-', '+', 'COUNT', 0)).toBe("ERR TSDB: Couldn't parse COUNT");
    expect(await R('-', '+', 'COUNT', 'x')).toBe("ERR TSDB: Couldn't parse COUNT");
    expect(await R('-', '+', 'AGGREGATION', 'median', 10)).toBe('ERR TSDB: Unknown aggregation type');
    expect(await R('-', '+', 'AGGREGATION', 'avg', 0)).toBe('ERR TSDB: bucketDuration must be greater than zero');
    expect(await R('-', '+', 'AGGREGATION', 'avg')).toBe("ERR TSDB: Couldn't parse AGGREGATION");
    expect(await R('-', '+', 'AGGREGATION', 'avg', 'x')).toBe("ERR TSDB: Couldn't parse AGGREGATION");
    expect(await R('-', '+', 'ALIGN', 0)).toBe('ERR TSDB: ALIGN parameter can only be used with AGGREGATION');
    expect(await R('-', '+', 'ALIGN', 'middle', 'AGGREGATION', 'avg', 10)).toBe('ERR TSDB: unknown ALIGN parameter');
    expect(await R('-', '+', 'EMPTY')).toBe('ERR TSDB: EMPTY parameter can only be used with AGGREGATION');
    expect(await R('-', '+', 'BUCKETTIMESTAMP', '+')).toBe('ERR TSDB: BUCKETTIMESTAMP parameter can only be used with AGGREGATION');
    expect(await R('-', '+', 'AGGREGATION', 'avg', 10, 'BUCKETTIMESTAMP', 'x')).toBe('ERR TSDB: unknown BUCKETTIMESTAMP parameter');
    expect(await R('-', '+', 'FILTER_BY_VALUE', 1)).toBe("ERR TSDB: Couldn't parse FILTER_BY_VALUE");
    expect(await R('-', '+', 'FILTER_BY_TS')).toBe("ERR TSDB: Couldn't parse FILTER_BY_TS");
    expect(await R('-', '+', 'WITHLABELS')).toBe(SYNTAX);
    expect(await err(t.call('TS.RANGE', 'rg:none', '-', '+'))).toBe('ERR TSDB: the key does not exist');
  });
});

// ============================================================================
// Aggregation
// ============================================================================

describe('AGGREGATION', () => {
  it('buckets start at multiples of the duration by default (docs example)', async () => {
    expect(await agg('stock:A', 'min', 20)).toEqual([
      [1000, '100'],
      [1020, '120'],
      [2000, '200'],
      [2020, '220'],
      [3000, '300'],
      [3020, '320'],
    ]);
  });

  it('ALIGN start aligns buckets to the query start (docs example)', async () => {
    expect(await t.call('TS.RANGE', 'stock:A', 10, '+', 'ALIGN', 'start', 'AGGREGATION', 'min', 20)).toEqual([
      [990, '100'],
      [1010, '110'],
      [1990, '200'],
      [2010, '210'],
      [2990, '300'],
      [3010, '310'],
    ]);
    // `-` is the same alias; an explicit timestamp works too
    expect(await t.call('TS.RANGE', 'stock:A', 10, 3000, 'ALIGN', '-', 'AGGREGATION', 'min', 20)).toEqual([
      [990, '100'],
      [1010, '110'],
      [1990, '200'],
      [2010, '210'],
      [2990, '300'],
    ]);
    expect(await t.call('TS.RANGE', 'stock:A', '-', '+', 'ALIGN', 10, 'AGGREGATION', 'min', 20)).toHaveLength(6);
  });

  it('ALIGN end aligns buckets to the query end', async () => {
    expect(await t.call('TS.RANGE', 'stock:A', 0, 2015, 'ALIGN', 'end', 'AGGREGATION', 'max', 20)).toEqual([
      [995, '110'],
      [1015, '120'],
      [1995, '210'],
    ]);
  });

  const cases: Array<[string, string[]]> = [
    ['avg', ['2', '4', '4']],
    ['sum', ['4', '8', '4']],
    ['min', ['1', '2', '4']],
    ['max', ['3', '6', '4']],
    ['range', ['2', '4', '0']],
    ['count', ['2', '2', '1']],
    ['first', ['1', '2', '4']],
    ['last', ['3', '6', '4']],
    ['var.p', ['1', '4', '0']],
    ['var.s', ['2', '8', '0']],
    ['std.p', ['1', '2', '0']],
    ['std.s', [String(Math.sqrt(2)), String(Math.sqrt(8)), '0']],
    // twa: the piecewise-linear curve, interpolated to the bucket end when a later sample exists
    //   [0,10): (0,1)(5,3)(10,2) → (10 + 12.5) / 10;  [10,20): (10,2)(15,6)(20,4) → 45 / 10;  [20,30): one point → 4
    ['twa', ['2.25', '4.5', '4']],
    ['countNaN', ['0', '0', '0']],
    ['countAll', ['2', '2', '1']],
  ];
  for (const [aggregator, values] of cases) {
    it(`${aggregator}`, async () => {
      expect(await agg('ag', aggregator, 10)).toEqual([
        [0, values[0]],
        [10, values[1]],
        [20, values[2]],
      ]);
    });
  }

  it('aggregator names are case-insensitive', async () => {
    expect(await agg('ag', 'AVG', 10)).toEqual(await agg('ag', 'avg', 10));
    expect(await agg('ag', 'STD.P', 10)).toEqual(await agg('ag', 'std.p', 10));
  });

  it('NaN samples only count for countNaN and countAll', async () => {
    await t.call('TS.CREATE', 'ag:nan');
    await t.call('TS.MADD', 'ag:nan', 0, 1, 'ag:nan', 1, 'nan', 'ag:nan', 2, 3, 'ag:nan', 10, 'nan');
    expect(await agg('ag:nan', 'avg', 10)).toEqual([[0, '2'], [10, 'nan']]);
    expect(await agg('ag:nan', 'count', 10)).toEqual([[0, '2'], [10, '0']]);
    expect(await agg('ag:nan', 'countNaN', 10)).toEqual([[0, '1'], [10, '1']]);
    expect(await agg('ag:nan', 'countAll', 10)).toEqual([[0, '3'], [10, '1']]);
    expect(await agg('ag:nan', 'max', 10)).toEqual([[0, '3'], [10, 'nan']]);
  });

  it('BUCKETTIMESTAMP start / end / mid', async () => {
    expect(await t.call('TS.RANGE', 'ag', '-', '+', 'AGGREGATION', 'sum', 10, 'BUCKETTIMESTAMP', '-')).toEqual([[0, '4'], [10, '8'], [20, '4']]);
    const end = await t.call('TS.RANGE', 'ag', '-', '+', 'AGGREGATION', 'sum', 10, 'BUCKETTIMESTAMP', 'end');
    expect(end).toEqual([[10, '4'], [20, '8'], [30, '4']]);
    expect(await t.call('TS.RANGE', 'ag', '-', '+', 'AGGREGATION', 'sum', 10, 'BUCKETTIMESTAMP', '+')).toEqual(end);
    const mid = await t.call('TS.RANGE', 'ag', '-', '+', 'AGGREGATION', 'sum', 10, 'BUCKETTIMESTAMP', 'mid');
    expect(mid).toEqual([[5, '4'], [15, '8'], [25, '4']]);
    expect(await t.call('TS.RANGE', 'ag', '-', '+', 'AGGREGATION', 'sum', 10, 'BUCKETTIMESTAMP', '~')).toEqual(mid);
  });

  it('EMPTY reports the empty buckets between filled ones', async () => {
    await t.call('TS.CREATE', 'ag:gap');
    await t.call('TS.MADD', 'ag:gap', 0, 1, 'ag:gap', 5, 2, 'ag:gap', 35, 4);
    expect(await agg('ag:gap', 'sum', 10)).toEqual([[0, '3'], [30, '4']]);
    expect(await t.call('TS.RANGE', 'ag:gap', '-', '+', 'AGGREGATION', 'sum', 10, 'EMPTY')).toEqual([[0, '3'], [10, '0'], [20, '0'], [30, '4']]);
    expect(await t.call('TS.RANGE', 'ag:gap', '-', '+', 'AGGREGATION', 'count', 10, 'EMPTY')).toEqual([[0, '2'], [10, '0'], [20, '0'], [30, '1']]);
    expect(await t.call('TS.RANGE', 'ag:gap', '-', '+', 'AGGREGATION', 'max', 10, 'EMPTY')).toEqual([[0, '2'], [10, 'nan'], [20, 'nan'], [30, '4']]);
    // last: the value of the last sample before the empty bucket
    expect(await t.call('TS.RANGE', 'ag:gap', '-', '+', 'AGGREGATION', 'last', 10, 'EMPTY')).toEqual([[0, '2'], [10, '2'], [20, '2'], [30, '4']]);
    // twa: filled buckets interpolate towards their neighbours; an empty bucket averages the line from (5, 2) to
    // (35, 4) over the bucket, i.e. its value at the bucket middle
    //   [0,10): (0,1)(5,2)(10, 2+10/30)          [30,40): (30, 2+50/30)(35,4)
    expect(await t.call('TS.RANGE', 'ag:gap', '-', '+', 'AGGREGATION', 'twa', 10, 'EMPTY')).toEqual([
      [0, String((1.5 * 5 + ((2 + 10 / 30 + 2) / 2) * 5) / 10)],
      [10, String(2 + (2 * 10) / 30)],
      [20, String(2 + (2 * 20) / 30)],
      [30, String((((4 + (2 + 50 / 30)) / 2) * 5) / 5)],
    ]);
    expect(await t.call('TS.REVRANGE', 'ag:gap', '-', '+', 'AGGREGATION', 'sum', 10, 'EMPTY', 'COUNT', 2)).toEqual([[30, '4'], [20, '0']]);
  });

  it('REVRANGE reverses the buckets; COUNT limits them', async () => {
    expect(await t.call('TS.REVRANGE', 'ag', '-', '+', 'AGGREGATION', 'max', 10)).toEqual([[20, '4'], [10, '6'], [0, '3']]);
    expect(await t.call('TS.RANGE', 'ag', '-', '+', 'COUNT', 2, 'AGGREGATION', 'max', 10)).toEqual([[0, '3'], [10, '6']]);
    expect(await t.call('TS.RANGE', 'ag', 5, 15, 'AGGREGATION', 'sum', 10)).toEqual([[0, '3'], [10, '8']]);
  });
});

// ============================================================================
// RESP3
// ============================================================================

describe('RESP3', () => {
  it('samples are [integer, double]', async () => {
    const r = await resp3Client(t);
    expect(await r.send('TS.GET', 'temp:TLV')).toBe('*2\r\n:1030\r\n,40\r\n');
    expect(await r.send('TS.RANGE', 'temp:TLV', 1000, 1010)).toBe('*2\r\n*2\r\n:1000\r\n,30\r\n*2\r\n:1010\r\n,35\r\n');
    expect(await r.send('TS.RANGE', 'ag:nan', 1, 1)).toBe('*1\r\n*2\r\n:1\r\n,nan\r\n');
  });

  it('RESP2 sends the value as a bulk string', async () => {
    const r = await t.raw();
    expect(await r.send('TS.GET', 'temp:TLV')).toBe('*2\r\n:1030\r\n$2\r\n40\r\n');
  });
});
