/**
 * Keyspace side of the time series module, shared by its sub-services (which never import each other): series lookup
 * and creation with the ts-* config defaults, ts-compaction-policy, sample ingestion (retention, IGNORE, duplicate
 * policies) and the compaction rules that follow every write, LATEST, and range evaluation.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * Compaction rules are validated on use instead of being rewired on every DEL / FLUSHDB: a rule is live while its
 * destination is a series whose `srcKey` names the source, and a destination's source is live while that source has a
 * rule to it. Deleting either side therefore ends the relation, as in Redis; RENAME rewires both sides explicitly.
 * A rule aggregates a bucket when the bucket closes (a newer sample lands in a later bucket); late samples and TS.DEL
 * re-aggregate the closed buckets they touch from the source samples.
 */
import { AppError } from '@/libs/app-error';
import Logger from '@/libs/logger';

import type { CommandContext } from '@/modules/command/command.types';
import type { Database } from '@/modules/database/database.service';

import TimeseriesAggregator from './timeseries.aggregator';
import { CompactionPolicySchema } from './timeseries.dto';
import { ChunkEncodingEnum, DuplicatePolicyEnum } from './timeseries.enums';
import type { DuplicatePolicy } from './timeseries.enums';
import TimeseriesMessages from './timeseries.messages';
import { TimeSeries } from './timeseries.structure';
import type { CompactionRule, RangeQuery, Sample, SeriesOptions, SeriesSettings } from './timeseries.types';

/** A live source → destination relation, seen from the destination. */
export type SourceLink = { key: string; series: TimeSeries; rule: CompactionRule };

/** What an ingested sample did: the timestamp to reply, and whether the series changed. */
export type IngestResult = { timestamp: number; written: boolean };

export default class TimeseriesStore {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static touch(ctx: CommandContext, key: string): void {
    ctx.server.touch(ctx.client.dbIndex, key);
  }

  /** The aggregate of a rule's bucket from the source samples (those since the rule started), null when empty. */
  private static aggregateBucket(series: TimeSeries, rule: CompactionRule, start: number): number | null {
    const end = start + rule.bucketDuration;
    const samples = series.range(Math.max(start, rule.since ?? start), end - 1);
    if (!samples.length) return null;
    const ctx = { start, end, prev: series.before(start), next: series.after(end - 1) };
    return TimeseriesAggregator.compute(rule.aggregator, samples, ctx);
  }

  /** Writes (or, for null, removes) one compacted bucket in a destination. */
  private static writeBucket(ctx: CommandContext, rule: CompactionRule, dest: TimeSeries, start: number, value: number | null): void {
    if (value === null) dest.deleteRange(start, start);
    else {
      dest.upsert(start, value, 'last');
      dest.trim();
    }
    TimeseriesStore.touch(ctx, rule.destKey);
  }

  private static bucketOf(rule: CompactionRule, ts: number): number {
    return TimeseriesAggregator.bucketStart(ts, rule.bucketDuration, rule.alignTimestamp);
  }

  /** The compactions after a sample at `ts` was written; `prevMax` is the newest timestamp before the write. */
  private static compact(ctx: CommandContext, key: string, series: TimeSeries, ts: number, prevMax: number | null): void {
    const S = TimeseriesStore;
    for (const rule of S.pruneRules(ctx.db, key, series)) {
      const dest = S.peekSeries(ctx.db, rule.destKey) as TimeSeries;
      if (rule.since === null) {
        rule.since = ts;
        continue;
      }
      if (prevMax === null) continue;
      const bucket = S.bucketOf(rule, ts);
      const open = S.bucketOf(rule, prevMax);
      if (ts > prevMax) {
        if (bucket > open) S.writeBucket(ctx, rule, dest, open, S.aggregateBucket(series, rule, open));
      } else if (bucket < open) S.writeBucket(ctx, rule, dest, bucket, S.aggregateBucket(series, rule, bucket));
    }
  }

  /** IGNORE: an in-order sample close enough to the newest one is dropped (LAST policy, not a compaction). */
  private static ignored(db: Database, key: string, series: TimeSeries, ts: number, value: number, policy: DuplicatePolicy, last: Sample): boolean {
    const { ignoreMaxTimeDiff, ignoreMaxValDiff } = series.settings;
    if (policy !== 'last' || ts < last.timestamp) return false;
    if (ts - last.timestamp > ignoreMaxTimeDiff || !(Math.abs(value - last.value) <= ignoreMaxValDiff)) return false;
    return TimeseriesStore.source(db, key, series) === null;
  }

  // ──────────────────────────────────────────────
  // Public Methods: lookup
  // ──────────────────────────────────────────────

  /** The series at `key`; undefined when missing, WRONGTYPE for other types. */
  static find(db: Database, key: string): TimeSeries | undefined {
    return db.get(key, 'timeseries');
  }

  /** The series at `key`; `ERR TSDB: the key does not exist` when missing. */
  static require(db: Database, key: string): TimeSeries {
    const series = db.get(key, 'timeseries');
    if (!series) throw new AppError(TimeseriesMessages.KEY_NOT_EXIST);
    return series;
  }

  /** The series at `key` without touching LRU or raising WRONGTYPE. */
  static peekSeries(db: Database, key: string): TimeSeries | undefined {
    const v = db.peek(key);
    return v?.type === 'timeseries' ? v.value : undefined;
  }

  /** The live compaction rules of a source. */
  static validRules(db: Database, key: string, series: TimeSeries): CompactionRule[] {
    return series.rules.filter((r) => TimeseriesStore.peekSeries(db, r.destKey)?.srcKey === key);
  }

  /** Drops the rules whose destination is gone (write paths) and returns the live ones. */
  static pruneRules(db: Database, key: string, series: TimeSeries): CompactionRule[] {
    const live = TimeseriesStore.validRules(db, key, series);
    if (live.length !== series.rules.length) series.rules = live;
    return live;
  }

  /** The live source of a compaction series, null when it is not one. */
  static source(db: Database, key: string, series: TimeSeries): SourceLink | null {
    if (series.srcKey === null) return null;
    const src = TimeseriesStore.peekSeries(db, series.srcKey);
    const rule = src?.rules.find((r) => r.destKey === key);
    return src && rule ? { key: series.srcKey, series: src, rule } : null;
  }

  /** The duplicate policy that applies: ON_DUPLICATE, else the series' own, else ts-duplicate-policy. */
  static effectivePolicy(ctx: CommandContext, series: TimeSeries, override: DuplicatePolicy | null): DuplicatePolicy {
    if (override) return override;
    if (series.settings.duplicatePolicy) return series.settings.duplicatePolicy;
    const configured = DuplicatePolicyEnum.safeParse(ctx.server.config.get('ts-duplicate-policy'));
    return configured.success ? configured.data : 'block';
  }

  // ──────────────────────────────────────────────
  // Public Methods: creation
  // ──────────────────────────────────────────────

  /** Settings of a new series: the given options over the ts-* config defaults (DUPLICATE_POLICY stays unset). */
  static settings(ctx: CommandContext, options: SeriesOptions): SeriesSettings {
    const config = ctx.server.config;
    const encoding = ChunkEncodingEnum.safeParse(config.get('ts-encoding'));
    return {
      retention: options.retention ?? config.num('ts-retention-policy'),
      chunkSize: options.chunkSize ?? config.num('ts-chunk-size-bytes'),
      encoding: options.encoding ?? (encoding.success ? encoding.data : 'compressed'),
      duplicatePolicy: options.duplicatePolicy ?? null,
      ignoreMaxTimeDiff: options.ignore?.maxTimeDiff ?? config.num('ts-ignore-max-time-diff'),
      ignoreMaxValDiff: options.ignore?.maxValDiff ?? config.num('ts-ignore-max-val-diff'),
    };
  }

  /** Creates the series at `key`, then the compactions ts-compaction-policy asks for (`<key>_<AGG>_<bucket>[_<align>]`). */
  static create(ctx: CommandContext, key: string, options: SeriesOptions): TimeSeries {
    const S = TimeseriesStore;
    const series = new TimeSeries(S.settings(ctx, options));
    for (const [label, value] of options.labels ?? []) series.labels.set(label, value);
    ctx.db.set(key, { type: 'timeseries', value: series });
    const raw = ctx.server.config.get('ts-compaction-policy') ?? '';
    const policy = CompactionPolicySchema.safeParse(raw);
    // CONFIG SET validates the policy; a value given at startup is not, so a bad one is reported and skipped here
    if (!policy.success) Logger.warn('[TimeseriesStore.create] Invalid ts-compaction-policy ignored', { policy: raw });
    for (const rule of policy.success ? policy.data : []) {
      const suffix = rule.alignTimestamp ? `_${rule.alignTimestamp}` : '';
      const destKey = `${key}_${rule.aggregator.toUpperCase()}_${rule.bucketDuration}${suffix}`;
      if (destKey === key || ctx.db.peek(destKey)) continue;
      const dest = new TimeSeries(S.settings(ctx, { labels: null, retention: rule.retention }));
      dest.labels = new Map(series.labels);
      dest.srcKey = key;
      ctx.db.set(destKey, { type: 'timeseries', value: dest });
      S.touch(ctx, destKey);
      series.rules.push({ destKey, aggregator: rule.aggregator, bucketDuration: rule.bucketDuration, alignTimestamp: rule.alignTimestamp, since: null });
    }
    return series;
  }

  // ──────────────────────────────────────────────
  // Public Methods: writes
  // ──────────────────────────────────────────────

  /**
   * Ingests one sample: retention check, IGNORE, the duplicate policy, retention trimming and the compactions. Throws
   * the TS.ADD errors (older than retention, BLOCK).
   */
  static ingest(ctx: CommandContext, key: string, series: TimeSeries, ts: number, value: number, policy: DuplicatePolicy): IngestResult {
    const S = TimeseriesStore;
    const last = series.lastSample();
    const retention = series.settings.retention;
    if (last && retention && ts < last.timestamp - retention) throw new AppError(TimeseriesMessages.TIMESTAMP_TOO_OLD);
    if (last && S.ignored(ctx.db, key, series, ts, value, policy, last)) return { timestamp: last.timestamp, written: false };
    const status = series.upsert(ts, value, policy);
    if (status === 'blocked') throw new AppError(TimeseriesMessages.DUPLICATE_BLOCKED);
    if (status !== 'unchanged') {
      series.trim();
      S.compact(ctx, key, series, ts, last ? last.timestamp : null);
    }
    return { timestamp: ts, written: true };
  }

  /** Re-aggregates (or removes) the compacted buckets a TS.DEL of [from, to] touched. */
  static afterDelete(ctx: CommandContext, key: string, series: TimeSeries, from: number, to: number): void {
    const S = TimeseriesStore;
    for (const rule of S.pruneRules(ctx.db, key, series)) {
      if (rule.since === null) continue;
      const dest = S.peekSeries(ctx.db, rule.destKey) as TimeSeries;
      // buckets at or after the (new) open bucket are open again: their compacted samples go
      const open = series.isEmpty ? null : S.bucketOf(rule, series.lastTimestamp);
      const first = S.bucketOf(rule, from);
      for (const { timestamp: bucket } of dest.range(open === null ? first : Math.min(first, open), Number.MAX_SAFE_INTEGER)) {
        if (open === null || bucket >= open) S.writeBucket(ctx, rule, dest, bucket, null);
        else if (bucket <= to) S.writeBucket(ctx, rule, dest, bucket, S.aggregateBucket(series, rule, bucket));
      }
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods: reads
  // ──────────────────────────────────────────────

  /** LATEST: the still-open bucket of a compaction series, aggregated from its source; null when there is none. */
  static latest(db: Database, key: string, series: TimeSeries): Sample | null {
    const S = TimeseriesStore;
    const link = S.source(db, key, series);
    if (!link || link.rule.since === null || link.series.isEmpty) return null;
    const start = S.bucketOf(link.rule, link.series.lastTimestamp);
    const value = S.aggregateBucket(link.series, link.rule, start);
    return value === null ? null : { timestamp: start, value };
  }

  /** The reply samples of a range query on one series. */
  static evaluate(db: Database, key: string, series: TimeSeries, query: RangeQuery, reverse: boolean): Sample[] {
    const latest = query.latest ? TimeseriesStore.latest(db, key, series) : null;
    const samples = series.range(query.from, query.to);
    const outer = { prev: series.before(query.from), next: series.after(query.to) };
    return TimeseriesAggregator.evaluate(samples, query, reverse, latest, outer);
  }
}
