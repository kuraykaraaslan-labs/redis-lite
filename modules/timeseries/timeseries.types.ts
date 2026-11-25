/**
 * Domain types of the time series module.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import type { Aggregator, BucketTimestamp, ChunkEncoding, DuplicatePolicy, Reducer } from './timeseries.enums';

/** One sample: a millisecond timestamp and a double value (NaN allowed). */
export type Sample = {
  timestamp: number;
  value: number;
};

/** The per-series settings (TS.CREATE options once the config defaults are applied). */
export type SeriesSettings = {
  retention: number;
  chunkSize: number;
  encoding: ChunkEncoding;
  /** null: not set on the series, the ts-duplicate-policy config applies (TS.INFO reports nil). */
  duplicatePolicy: DuplicatePolicy | null;
  ignoreMaxTimeDiff: number;
  ignoreMaxValDiff: number;
};

/** A compaction rule of a source series: samples are aggregated per bucket into `destKey`. */
export type CompactionRule = {
  destKey: string;
  aggregator: Aggregator;
  bucketDuration: number;
  alignTimestamp: number;
  /** Timestamp of the first sample written after the rule was created (null: none yet). Older samples are not compacted. */
  since: number | null;
};

/** Options of the commands that create or alter a series; undefined = not given. */
export type SeriesOptions = {
  retention?: number;
  chunkSize?: number;
  encoding?: ChunkEncoding;
  duplicatePolicy?: DuplicatePolicy;
  ignore?: { maxTimeDiff: number; maxValDiff: number };
  /** null: no LABELS keyword; [] : LABELS with no pairs (TS.ALTER removes every label). */
  labels: Array<[string, string]> | null;
};

/** ALIGN: the query's start, its end, or an explicit timestamp. */
export type Align = { kind: 'start' } | { kind: 'end' } | { kind: 'timestamp'; value: number };

/** AGGREGATION of a range query, with its ALIGN / BUCKETTIMESTAMP / EMPTY modifiers. */
export type AggregationSpec = {
  aggregator: Aggregator;
  bucketDuration: number;
  align: Align;
  bucketTimestamp: BucketTimestamp;
  empty: boolean;
};

/** A range query: TS.RANGE / TS.REVRANGE / TS.MRANGE / TS.MREVRANGE options. */
export type RangeQuery = {
  from: number;
  to: number;
  latest: boolean;
  filterByTs: number[] | null;
  filterByValue: [min: number, max: number] | null;
  count: number | null;
  aggregation: AggregationSpec | null;
};

/** One FILTER expression: `label=v`, `label!=v`, `label=`, `label!=`, `label=(a,b)`, `label!=(a,b)`. */
export type LabelMatcher = {
  label: string;
  negate: boolean;
  /** Empty: the bare `label=` (label absent) / `label!=` (label present) forms. */
  values: string[];
};

/** Which labels a multi-key reply carries: none, all (WITHLABELS) or a selection (SELECTED_LABELS). */
export type LabelSelection = { kind: 'none' } | { kind: 'all' } | { kind: 'selected'; labels: string[] };

/** GROUPBY label REDUCE reducer. */
export type GroupBy = {
  label: string;
  reducer: Reducer;
};

/** What an upsert did to a series. `blocked`: the BLOCK duplicate policy refused it. */
export type UpsertStatus = 'added' | 'updated' | 'unchanged' | 'blocked';

/** One chunk as TS.INFO DEBUG reports it. */
export type ChunkInfo = {
  startTimestamp: number;
  endTimestamp: number;
  samples: number;
  size: number;
};

/** A parsed ts-compaction-policy rule: `aggregator:bucket:retention[:align]` with durations in ms. */
export type PolicyRule = {
  aggregator: Aggregator;
  bucketDuration: number;
  retention: number;
  alignTimestamp: number;
};
