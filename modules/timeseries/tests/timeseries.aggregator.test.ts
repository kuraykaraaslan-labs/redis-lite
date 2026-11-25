/**
 * Unit tests of the aggregation functions (no server): bucket alignment, every aggregator, twa interpolation, EMPTY
 * buckets, reducers and range evaluation.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import TimeseriesAggregator from '../timeseries.aggregator';
import type { AggregationSpec, RangeQuery, Sample } from '../timeseries.types';

const S = (...pairs: Array<[number, number]>): Sample[] => pairs.map(([timestamp, value]) => ({ timestamp, value }));
const spec = (over: Partial<AggregationSpec> = {}): AggregationSpec => ({
  aggregator: 'sum',
  bucketDuration: 10,
  align: { kind: 'timestamp', value: 0 },
  bucketTimestamp: 'start',
  empty: false,
  ...over,
});
const query = (over: Partial<RangeQuery> = {}): RangeQuery => ({
  from: 0,
  to: Number.MAX_SAFE_INTEGER,
  latest: false,
  filterByTs: null,
  filterByValue: null,
  count: null,
  aggregation: null,
  ...over,
});

describe('bucketStart', () => {
  it('aligns buckets to the alignment timestamp', () => {
    const b = TimeseriesAggregator.bucketStart;
    expect([b(0, 10, 0), b(9, 10, 0), b(10, 10, 0), b(25, 10, 0)]).toEqual([0, 0, 10, 20]);
    expect([b(1000, 20, 10), b(1010, 20, 10), b(1029, 20, 10)]).toEqual([990, 1010, 1010]);
    expect(b(5, 10, 7)).toBe(-3);
    expect(b(86400000 + 21600000, 86400000, 21600000)).toBe(86400000 + 21600000);
  });
});

describe('compute', () => {
  const xs = S([0, 4], [1, 2], [2, 9], [3, 5]);
  it.each([
    ['avg', 5],
    ['sum', 20],
    ['min', 2],
    ['max', 9],
    ['range', 7],
    ['count', 4],
    ['first', 4],
    ['last', 5],
    ['var.p', 6.5],
    ['var.s', 26 / 3],
    ['std.p', Math.sqrt(6.5)],
    ['std.s', Math.sqrt(26 / 3)],
    ['countnan', 0],
    ['countall', 4],
  ] as const)('%s', (aggregator, expected) => {
    expect(TimeseriesAggregator.compute(aggregator, xs)).toBeCloseTo(expected, 12);
  });

  it('a single sample has no spread; no valid sample gives NaN (count 0)', () => {
    expect(TimeseriesAggregator.compute('var.s', S([0, 3]))).toBe(0);
    expect(TimeseriesAggregator.compute('std.p', S([0, 3]))).toBe(0);
    expect(TimeseriesAggregator.compute('avg', S([0, NaN]))).toBeNaN();
    expect(TimeseriesAggregator.compute('count', S([0, NaN]))).toBe(0);
    expect(TimeseriesAggregator.compute('countnan', S([0, NaN], [1, 1]))).toBe(1);
  });

  it('twa: trapezoids, interpolated to the bucket bounds when neighbours exist', () => {
    const tw = (samples: Sample[], prev?: Sample, next?: Sample): number =>
      TimeseriesAggregator.compute('twa', samples, { start: 0, end: 10, prev, next });
    // flat line → its value
    expect(tw(S([2, 5], [8, 5]))).toBe(5);
    // no neighbours: the window is [first, last]
    expect(tw(S([0, 0], [10, 10]))).toBe(5);
    // neighbours: the line through (−10, 0) and (2, 12) reaches 10 at t = 0; no later sample: the window is [0, 2]
    expect(tw(S([2, 12]), { timestamp: -10, value: 0 })).toBe(11);
    expect(tw(S([2, 12], [4, 12]), { timestamp: -10, value: 0 }, { timestamp: 14, value: 2 })).toBeCloseTo(
      // (0,10)(2,12)(4,12)(10,6): the line from (4,12) to (14,2) is 6 at t = 10
      (((10 + 12) / 2) * 2 + 12 * 2 + ((12 + 6) / 2) * 6) / 10,
      12,
    );
  });
});

describe('bucketize', () => {
  it('BUCKETTIMESTAMP and EMPTY', () => {
    const xs = S([1, 1], [2, 2], [31, 4]);
    expect(TimeseriesAggregator.bucketize(xs, spec(), 0)).toEqual(S([0, 3], [30, 4]));
    expect(TimeseriesAggregator.bucketize(xs, spec({ bucketTimestamp: 'end' }), 0)).toEqual(S([10, 3], [40, 4]));
    expect(TimeseriesAggregator.bucketize(xs, spec({ bucketTimestamp: 'mid' }), 0)).toEqual(S([5, 3], [35, 4]));
    expect(TimeseriesAggregator.bucketize(xs, spec({ empty: true }), 0)).toEqual(S([0, 3], [10, 0], [20, 0], [30, 4]));
    const last = TimeseriesAggregator.bucketize(xs, spec({ aggregator: 'last', empty: true }), 0);
    expect(last).toEqual(S([0, 2], [10, 2], [20, 2], [30, 4]));
    const min = TimeseriesAggregator.bucketize(xs, spec({ aggregator: 'min', empty: true }), 0);
    expect(min.map((s) => s.value)).toEqual([1, NaN, NaN, 4]);
  });
});

describe('reduce', () => {
  it('applies a reducer to the values of one timestamp', () => {
    expect(TimeseriesAggregator.reduce('max', [3, 9, 1])).toBe(9);
    expect(TimeseriesAggregator.reduce('avg', [3, 9])).toBe(6);
    expect(TimeseriesAggregator.reduce('range', [3, 9, 1])).toBe(8);
    expect(TimeseriesAggregator.reduce('countall', [3, NaN])).toBe(2);
  });
});

describe('evaluate', () => {
  const xs = S([0, 1], [10, 2], [20, 3], [30, 4]);
  it('filters, then aggregates, then reverses and counts', () => {
    const E = TimeseriesAggregator.evaluate;
    expect(E(xs, query({ filterByValue: [2, 3] }), false, null, {})).toEqual(S([10, 2], [20, 3]));
    expect(E(xs, query({ filterByTs: [0, 30, 99] }), true, null, {})).toEqual(S([30, 4], [0, 1]));
    expect(E(xs, query({ count: 2 }), true, null, {})).toEqual(S([30, 4], [20, 3]));
    expect(E(xs, query({ aggregation: spec({ bucketDuration: 20 }) }), false, null, {})).toEqual(S([0, 3], [20, 7]));
    expect(E(xs, query({ aggregation: spec({ bucketDuration: 20, align: { kind: 'start' } }), from: 10 }), false, null, {})).toEqual(
      S([-10, 1], [10, 5], [30, 4]).map((s) => ({ ...s, timestamp: Math.max(0, s.timestamp) })),
    );
  });

  it('LATEST replaces or extends the samples within the range', () => {
    expect(TimeseriesAggregator.evaluate(xs, query(), false, { timestamp: 40, value: 9 }, {})).toEqual([...xs, { timestamp: 40, value: 9 }]);
    expect(TimeseriesAggregator.evaluate(xs, query({ to: 35 }), false, { timestamp: 40, value: 9 }, {})).toEqual(xs);
  });
});
