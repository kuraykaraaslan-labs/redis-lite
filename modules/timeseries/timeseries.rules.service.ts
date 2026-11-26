/**
 * Compaction rules: TS.CREATERULE, TS.DELETERULE, the RENAME hook that keeps rules pointing at renamed series, and the
 * ts-compaction-policy grammar CONFIG SET validates with.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * A destination may have one source and no rules of its own; a source may not itself be a destination. Only samples
 * written after TS.CREATERULE are aggregated.
 */
import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import type { Database } from '@/modules/database/database.service';

import { CompactionPolicySchema } from './timeseries.dto';
import type { CreateRuleInput, DeleteRuleInput } from './timeseries.dto';
import TimeseriesMessages from './timeseries.messages';
import TimeseriesStore from './timeseries.store';
import type { TimeSeries } from './timeseries.structure';
import type { PolicyRule } from './timeseries.types';

export default class TimeseriesRulesService {
  /** TS.CREATERULE sourceKey destKey AGGREGATION aggregator bucketDuration [alignTimestamp] */
  static createRule(ctx: CommandContext, { sourceKey, destKey, aggregator, bucketDuration, alignTimestamp }: CreateRuleInput): Reply {
    const S = TimeseriesStore;
    if (sourceKey === destKey) throw new AppError(TimeseriesMessages.SAME_KEYS);
    const src = S.require(ctx.db, sourceKey);
    const dest = S.require(ctx.db, destKey);
    if (S.source(ctx.db, sourceKey, src)) throw new AppError(TimeseriesMessages.SOURCE_IS_DEST);
    if (S.source(ctx.db, destKey, dest)) throw new AppError(TimeseriesMessages.DEST_HAS_SOURCE);
    if (S.validRules(ctx.db, destKey, dest).length) throw new AppError(TimeseriesMessages.DEST_HAS_RULES);
    S.pruneRules(ctx.db, sourceKey, src);
    src.rules.push({ destKey, aggregator, bucketDuration, alignTimestamp, since: null });
    dest.srcKey = sourceKey;
    return OK;
  }

  /** TS.DELETERULE sourceKey destKey: both series stay, the destination keeps the samples already compacted. */
  static deleteRule(ctx: CommandContext, { sourceKey, destKey }: DeleteRuleInput): Reply {
    const S = TimeseriesStore;
    const src = S.require(ctx.db, sourceKey);
    const dest = S.require(ctx.db, destKey);
    const live = S.pruneRules(ctx.db, sourceKey, src);
    if (!live.some((r) => r.destKey === destKey)) throw new AppError(TimeseriesMessages.RULE_NOT_FOUND);
    src.rules = live.filter((r) => r.destKey !== destKey);
    dest.srcKey = null;
    return OK;
  }

  /**
   * After RENAME / RENAMENX moved `series` from `from` to `to`: its source and destinations now name `to` (the label
   * index learns of the move through the Database change hook).
   */
  static renamed(db: Database, from: string, to: string, series: TimeSeries): void {
    if (series.srcKey !== null) {
      const rule = TimeseriesStore.peekSeries(db, series.srcKey)?.rules.find((r) => r.destKey === from);
      if (rule) rule.destKey = to;
    }
    for (const rule of series.rules) {
      const dest = TimeseriesStore.peekSeries(db, rule.destKey);
      if (dest && dest.srcKey === from) dest.srcKey = to;
    }
  }

  /** ts-compaction-policy: the parsed rules, or null when the value is not a valid policy. */
  static parseCompactionPolicy(value: string): PolicyRule[] | null {
    const parsed = CompactionPolicySchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
}
