/**
 * Zod enums of the time series module (TS.* commands).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { z } from 'zod';

/** DUPLICATE_POLICY / ON_DUPLICATE: what happens when a sample is added at a timestamp that already holds one. */
export const DuplicatePolicyEnum = z.enum(['block', 'first', 'last', 'min', 'max', 'sum']);

/** ENCODING: how the chunks of a series store their samples. */
export const ChunkEncodingEnum = z.enum(['compressed', 'uncompressed']);

/** AGGREGATION aggregators (TS.RANGE family, TS.CREATERULE, ts-compaction-policy), lowercase. */
export const AggregatorEnum = z.enum([
  'avg', 'sum', 'min', 'max', 'range', 'count', 'first', 'last', 'std.p', 'std.s', 'var.p', 'var.s', 'twa', 'countnan', 'countall',
]);

/** GROUPBY … REDUCE reducers (TS.MRANGE / TS.MREVRANGE), lowercase. */
export const ReducerEnum = z.enum(['avg', 'sum', 'min', 'max', 'range', 'count', 'std.p', 'std.s', 'var.p', 'var.s', 'countnan', 'countall']);

/** BUCKETTIMESTAMP: which timestamp an aggregated bucket is reported at. */
export const BucketTimestampEnum = z.enum(['start', 'end', 'mid']);

// ============================================================================
// Type Exports
// ============================================================================

export type DuplicatePolicy = z.infer<typeof DuplicatePolicyEnum>;
export type ChunkEncoding = z.infer<typeof ChunkEncodingEnum>;
export type Aggregator = z.infer<typeof AggregatorEnum>;
export type Reducer = z.infer<typeof ReducerEnum>;
export type BucketTimestamp = z.infer<typeof BucketTimestampEnum>;
