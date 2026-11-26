/**
 * Series metadata: TS.INFO [DEBUG] and TS.ALTER.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { OK, RespDouble, RespMap } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { AlterInput, KeyFlagInput } from './timeseries.dto';
import TimeseriesIndex from './timeseries.index';
import TimeseriesReply from './timeseries.reply';
import TimeseriesStore from './timeseries.store';

export default class TimeseriesInfoService {
  /**
   * TS.INFO key [DEBUG]: a map in RESP3, a flat field / value array in RESP2. duplicatePolicy is nil while the series
   * follows ts-duplicate-policy; rules are `[destKey, bucketDuration, AGGREGATOR, alignTimestamp]`.
   */
  static info(ctx: CommandContext, { key, flag: debug }: KeyFlagInput): Reply {
    const series = TimeseriesStore.require(ctx.db, key);
    const s = series.settings;
    const source = TimeseriesStore.source(ctx.db, key, series);
    const rules = TimeseriesStore.validRules(ctx.db, key, series);
    const rulesReply = TimeseriesReply.resp3(ctx)
      ? new RespMap(rules.map((r) => [r.destKey, [r.bucketDuration, r.aggregator.toUpperCase(), r.alignTimestamp]]))
      : rules.map((r) => [r.destKey, r.bucketDuration, r.aggregator.toUpperCase(), r.alignTimestamp]);
    const entries: Array<[Reply, Reply]> = [
      ['totalSamples', series.totalSamples],
      ['memoryUsage', series.memoryUsage() + key.length],
      ['firstTimestamp', series.firstTimestamp],
      ['lastTimestamp', series.lastTimestamp],
      ['retentionTime', s.retention],
      ['chunkCount', series.chunkCount],
      ['chunkSize', s.chunkSize],
      ['chunkType', s.encoding],
      ['duplicatePolicy', s.duplicatePolicy],
      ['labels', TimeseriesReply.labels([...series.labels])],
      ['sourceKey', source ? source.key : null],
      ['rules', rulesReply],
      ['ignoreMaxTimeDiff', s.ignoreMaxTimeDiff],
      ['ignoreMaxValDiff', new RespDouble(s.ignoreMaxValDiff)],
    ];
    if (debug) {
      entries.push(['keySelfName', key]);
      const chunks = series.chunkInfo().map(
        (c) =>
          new RespMap([
            ['startTimestamp', c.startTimestamp],
            ['endTimestamp', c.endTimestamp],
            ['samples', c.samples],
            ['size', c.size],
            ['bytesPerSample', new RespDouble(c.size / c.samples)],
          ]),
      );
      entries.push(['Chunks', chunks]);
    }
    return new RespMap(entries);
  }

  /** TS.ALTER: RETENTION (applied at once), CHUNK_SIZE (new chunks), DUPLICATE_POLICY, IGNORE, LABELS (replaces all). */
  static alter(ctx: CommandContext, { key, options }: AlterInput): Reply {
    const series = TimeseriesStore.require(ctx.db, key);
    const s = series.settings;
    if (options.retention !== undefined) s.retention = options.retention;
    if (options.chunkSize !== undefined) s.chunkSize = options.chunkSize;
    if (options.duplicatePolicy !== undefined) s.duplicatePolicy = options.duplicatePolicy;
    if (options.ignore) {
      s.ignoreMaxTimeDiff = options.ignore.maxTimeDiff;
      s.ignoreMaxValDiff = options.ignore.maxValDiff;
    }
    if (options.labels !== null) {
      series.labels = new Map(options.labels);
      TimeseriesIndex.relabeled(ctx.server.labelIndex, key, series);
    }
    if (options.retention !== undefined) series.trim();
    return OK;
  }
}
