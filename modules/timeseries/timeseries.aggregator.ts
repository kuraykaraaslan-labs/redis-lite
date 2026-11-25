/**
 * Aggregation of samples: the aggregators of AGGREGATION / TS.CREATERULE, the GROUPBY reducers, bucketing with ALIGN,
 * BUCKETTIMESTAMP and EMPTY, and the evaluation of a whole range query over a list of samples. Pure functions, no
 * keyspace access (the samples and the LATEST sample are handed in).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * NaN samples are ignored by every aggregator except countNaN and countAll. `twa` is the time-weighted average of the
 * piecewise-linear curve through the samples over the bucket: when a sample exists before (after) the bucket, the curve
 * is interpolated to the bucket start (end); otherwise the window starts (ends) at the first (last) sample.
 */
import type { Aggregator, BucketTimestamp, Reducer } from './timeseries.enums';
import type { AggregationSpec, RangeQuery, Sample } from './timeseries.types';

/** Samples around a bucket, for `twa` and for EMPTY buckets. */
export type BucketContext = {
  start: number;
  end: number;
  prev?: Sample;
  next?: Sample;
};

export default class TimeseriesAggregator {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static variance(values: number[], sample: boolean): number {
    const n = values.length;
    if (n === 0) return NaN;
    if (n === 1) return 0;
    let mean = 0;
    for (const v of values) mean += v;
    mean /= n;
    let sq = 0;
    for (const v of values) sq += (v - mean) * (v - mean);
    return sq / (sample ? n - 1 : n);
  }

  /** Linear interpolation of the line through a and b at time t. */
  private static lerp(a: Sample, b: Sample, t: number): number {
    if (b.timestamp === a.timestamp) return b.value;
    return a.value + ((b.value - a.value) * (t - a.timestamp)) / (b.timestamp - a.timestamp);
  }

  private static twa(samples: Sample[], ctx: BucketContext): number {
    const A = TimeseriesAggregator;
    if (!samples.length) return NaN;
    const points: Sample[] = [];
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (ctx.prev && first.timestamp > ctx.start) points.push({ timestamp: ctx.start, value: A.lerp(ctx.prev, first, ctx.start) });
    points.push(...samples);
    if (ctx.next && last.timestamp < ctx.end) points.push({ timestamp: ctx.end, value: A.lerp(last, ctx.next, ctx.end) });
    const span = points[points.length - 1].timestamp - points[0].timestamp;
    if (span <= 0) return points[0].value;
    let area = 0;
    for (let i = 1; i < points.length; i++) {
      area += ((points[i].value + points[i - 1].value) / 2) * (points[i].timestamp - points[i - 1].timestamp);
    }
    return area / span;
  }

  /** The value an EMPTY bucket reports. */
  private static emptyValue(aggregator: Aggregator, ctx: BucketContext): number {
    switch (aggregator) {
      case 'sum':
      case 'count':
      case 'countnan':
      case 'countall':
        return 0;
      case 'last':
        return ctx.prev ? ctx.prev.value : NaN;
      case 'twa':
        return ctx.prev && ctx.next ? TimeseriesAggregator.lerp(ctx.prev, ctx.next, (ctx.start + ctx.end) / 2) : NaN;
      default:
        return NaN;
    }
  }

  private static reported(start: number, duration: number, at: BucketTimestamp): number {
    const ts = at === 'start' ? start : at === 'end' ? start + duration : start + Math.floor(duration / 2);
    return Math.max(0, ts);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Start of the bucket holding `ts`: buckets are `duration` wide and one of them starts at `align`. */
  static bucketStart(ts: number, duration: number, align: number): number {
    return ts - ((((ts - align) % duration) + duration) % duration);
  }

  /** One aggregator over the samples of a bucket (`ctx` is only read by twa). */
  static compute(aggregator: Aggregator, samples: Sample[], ctx: BucketContext = { start: 0, end: 0 }): number {
    if (aggregator === 'countall') return samples.length;
    if (aggregator === 'countnan') return samples.filter((s) => Number.isNaN(s.value)).length;
    const valid = samples.filter((s) => !Number.isNaN(s.value));
    const values = valid.map((s) => s.value);
    switch (aggregator) {
      case 'count':
        return values.length;
      case 'sum':
        return values.reduce((a, b) => a + b, 0);
      case 'avg':
        return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
      case 'min':
        return values.length ? values.reduce((a, b) => (b < a ? b : a)) : NaN;
      case 'max':
        return values.length ? values.reduce((a, b) => (b > a ? b : a)) : NaN;
      case 'range':
        return values.length ? values.reduce((a, b) => (b > a ? b : a)) - values.reduce((a, b) => (b < a ? b : a)) : NaN;
      case 'first':
        return values.length ? values[0] : NaN;
      case 'last':
        return values.length ? values[values.length - 1] : NaN;
      case 'var.p':
        return TimeseriesAggregator.variance(values, false);
      case 'var.s':
        return TimeseriesAggregator.variance(values, true);
      case 'std.p':
        return Math.sqrt(TimeseriesAggregator.variance(values, false));
      case 'std.s':
        return Math.sqrt(TimeseriesAggregator.variance(values, true));
      case 'twa':
        return TimeseriesAggregator.twa(valid, ctx);
    }
  }

  /** A GROUPBY reducer over the values the grouped series hold at one timestamp. */
  static reduce(reducer: Reducer, values: number[]): number {
    return TimeseriesAggregator.compute(reducer, values.map((value, i) => ({ timestamp: i, value })));
  }

  /**
   * Buckets ascending `samples` and aggregates each bucket. `align` is the absolute alignment timestamp; `outer` holds
   * the samples just outside the list (twa interpolation). EMPTY reports the empty buckets between non-empty ones.
   */
  static bucketize(samples: Sample[], spec: AggregationSpec, align: number, outer: { prev?: Sample; next?: Sample } = {}): Sample[] {
    const A = TimeseriesAggregator;
    const { aggregator, bucketDuration: duration, bucketTimestamp, empty } = spec;
    const out: Sample[] = [];
    let lastBucket: number | null = null;
    let i = 0;
    while (i < samples.length) {
      const start = A.bucketStart(samples[i].timestamp, duration, align);
      const end = start + duration;
      let j = i;
      while (j < samples.length && samples[j].timestamp < end) j++;
      const prev = i > 0 ? samples[i - 1] : outer.prev;
      if (empty && lastBucket !== null) {
        for (let b = lastBucket + duration; b < start; b += duration) {
          const value = A.emptyValue(aggregator, { start: b, end: b + duration, prev, next: samples[i] });
          out.push({ timestamp: A.reported(b, duration, bucketTimestamp), value });
        }
      }
      const next = j < samples.length ? samples[j] : outer.next;
      const value = A.compute(aggregator, samples.slice(i, j), { start, end, prev, next });
      out.push({ timestamp: A.reported(start, duration, bucketTimestamp), value });
      lastBucket = start;
      i = j;
    }
    return out;
  }

  /**
   * A whole range query over the samples of [from, to] (oldest first): FILTER_BY_TS / FILTER_BY_VALUE, the LATEST
   * sample of a compaction, AGGREGATION, direction and COUNT. `outer` are the samples just outside [from, to].
   */
  static evaluate(samples: Sample[], query: RangeQuery, reverse: boolean, latest: Sample | null, outer: { prev?: Sample; next?: Sample }): Sample[] {
    let list = samples;
    if (latest && latest.timestamp >= query.from && latest.timestamp <= query.to) {
      list = list.filter((s) => s.timestamp < latest.timestamp);
      list.push(latest);
    }
    const filtered = query.filterByTs !== null || query.filterByValue !== null;
    if (query.filterByTs) {
      const wanted = new Set(query.filterByTs);
      list = list.filter((s) => wanted.has(s.timestamp));
    }
    if (query.filterByValue) {
      const [min, max] = query.filterByValue;
      list = list.filter((s) => s.value >= min && s.value <= max);
    }
    const agg = query.aggregation;
    if (agg) {
      const align = agg.align.kind === 'timestamp' ? agg.align.value : agg.align.kind === 'start' ? query.from : query.to;
      list = TimeseriesAggregator.bucketize(list, agg, Number.isFinite(align) ? align : 0, filtered ? {} : outer);
    }
    if (reverse) list = [...list].reverse();
    if (query.count !== null && list.length > query.count) list = list.slice(0, query.count);
    return list;
  }
}
