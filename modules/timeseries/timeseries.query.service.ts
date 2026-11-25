/**
 * Multi-series reads by label filters: TS.QUERYINDEX, TS.MGET, TS.MRANGE / TS.MREVRANGE (with GROUPBY … REDUCE).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * Series are reported in key-name order. Grouped results are named `label=value`, ordered by value, and carry the
 * labels `label`, `__reducer__` and `__source__` (the grouped keys, comma separated); their samples are the reducer
 * applied, per timestamp, to the samples the grouped series hold at that timestamp.
 */
import { RespMap, RespSet } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import TimeseriesAggregator from './timeseries.aggregator';
import type { MGetInput, MRangeInput, QueryIndexInput } from './timeseries.dto';
import TimeseriesReply from './timeseries.reply';
import TimeseriesStore from './timeseries.store';
import type { TimeSeries } from './timeseries.structure';
import type { GroupBy, LabelMatcher, Sample } from './timeseries.types';

export default class TimeseriesQueryService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static matches(series: TimeSeries, matchers: LabelMatcher[]): boolean {
    return matchers.every(({ label, negate, values }) => {
      const value = series.labels.get(label);
      if (!values.length) return negate ? value !== undefined : value === undefined;
      const hit = value !== undefined && values.includes(value);
      return negate ? !hit : hit;
    });
  }

  private static select(ctx: CommandContext, matchers: LabelMatcher[]): Array<[string, TimeSeries]> {
    return TimeseriesStore.all(ctx.db).filter(([, series]) => TimeseriesQueryService.matches(series, matchers));
  }

  /** GROUPBY … REDUCE: one row per value of the label, samples reduced per timestamp. */
  private static grouped(ctx: CommandContext, rows: Array<[string, TimeSeries, Sample[]]>, { label, reducer }: GroupBy, reverse: boolean, count: number | null): Reply {
    const groups = new Map<string, Array<[string, Sample[]]>>();
    for (const [key, series, samples] of rows) {
      const value = series.labels.get(label);
      if (value === undefined) continue;
      const list = groups.get(value) ?? [];
      list.push([key, samples]);
      groups.set(value, list);
    }
    const out: Array<[string, Reply, string[], Reply[]]> = [];
    for (const value of [...groups.keys()].sort()) {
      const members = groups.get(value) ?? [];
      const byTs = new Map<number, number[]>();
      for (const [, samples] of members) {
        for (const s of samples) {
          const values = byTs.get(s.timestamp);
          if (values) values.push(s.value);
          else byTs.set(s.timestamp, [s.value]);
        }
      }
      const stamps = [...byTs.keys()].sort((a, b) => (reverse ? b - a : a - b));
      let reduced = stamps.map((ts) => ({ timestamp: ts, value: TimeseriesAggregator.reduce(reducer, byTs.get(ts) ?? []) }));
      if (count !== null) reduced = reduced.slice(0, count);
      const sources = members.map(([key]) => key);
      const labels = TimeseriesReply.labels([
        [label, value],
        ['__reducer__', reducer],
        ['__source__', sources.join(',')],
      ]);
      out.push([`${label}=${value}`, labels, sources, TimeseriesReply.samples(reduced)]);
    }
    if (!TimeseriesReply.resp3(ctx)) return out.map(([name, labels, , samples]) => [name, labels, samples]);
    return new RespMap(
      out.map(([name, , sources, samples]) => [
        name,
        [TimeseriesReply.labels([[label, name.slice(label.length + 1)]]), new RespMap([['reducers', [reducer]]]), new RespMap([['sources', sources]]), samples],
      ]),
    );
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** TS.QUERYINDEX: the keys of the matching series (a set in RESP3). */
  static queryIndex(ctx: CommandContext, { filters }: QueryIndexInput): Reply {
    const keys = TimeseriesQueryService.select(ctx, filters).map(([key]) => key);
    return TimeseriesReply.resp3(ctx) ? new RespSet(keys) : keys;
  }

  /** TS.MGET: the newest sample of every matching series, with the selected labels. */
  static mGet(ctx: CommandContext, { latest, labels, filters }: MGetInput): Reply {
    const rows = TimeseriesQueryService.select(ctx, filters).map(([key, series]): [string, Reply, Reply] => {
      const open = latest ? TimeseriesStore.latest(ctx.db, key, series) : null;
      const sample = TimeseriesReply.sample(open ?? series.lastSample());
      return [key, TimeseriesReply.labels(TimeseriesReply.selectLabels(series, labels)), sample];
    });
    if (TimeseriesReply.resp3(ctx)) return new RespMap(rows.map(([key, l, sample]) => [key, [l, sample]]));
    return rows.map(([key, l, sample]) => [key, l, sample]);
  }

  /** TS.MRANGE (reverse = false) / TS.MREVRANGE (reverse = true). */
  static mRange(ctx: CommandContext, { query, labels, filters, groupBy }: MRangeInput, reverse: boolean): Reply {
    const rows = TimeseriesQueryService.select(ctx, filters).map(([key, series]): [string, TimeSeries, Sample[]] => [
      key,
      series,
      TimeseriesStore.evaluate(ctx.db, key, series, query, reverse),
    ]);
    if (groupBy) return TimeseriesQueryService.grouped(ctx, rows, groupBy, reverse, query.count);
    const aggregators = query.aggregation ? [query.aggregation.aggregator] : [];
    const out = rows.map(([key, series, samples]): [string, Reply, Reply[]] => [
      key,
      TimeseriesReply.labels(TimeseriesReply.selectLabels(series, labels)),
      TimeseriesReply.samples(samples),
    ]);
    if (!TimeseriesReply.resp3(ctx)) return out;
    return new RespMap(out.map(([key, l, samples]) => [key, [l, new RespMap([['aggregators', aggregators]]), samples]]));
  }
}
