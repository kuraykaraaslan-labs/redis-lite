/**
 * Reads of one series: TS.GET, TS.RANGE, TS.REVRANGE.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { KeyFlagInput, RangeInput } from './timeseries.dto';
import TimeseriesReply from './timeseries.reply';
import TimeseriesStore from './timeseries.store';

export default class TimeseriesRangeService {
  /** TS.GET [LATEST]: the newest sample (`[]` for an empty series); LATEST reports a compaction's open bucket. */
  static get(ctx: CommandContext, { key, flag: latest }: KeyFlagInput): Reply {
    const series = TimeseriesStore.require(ctx.db, key);
    const open = latest ? TimeseriesStore.latest(ctx.db, key, series) : null;
    return TimeseriesReply.sample(open ?? series.lastSample());
  }

  /** TS.RANGE (reverse = false) / TS.REVRANGE (reverse = true). */
  static range(ctx: CommandContext, { key, query }: RangeInput, reverse: boolean): Reply {
    const series = TimeseriesStore.require(ctx.db, key);
    return TimeseriesReply.samples(TimeseriesStore.evaluate(ctx.db, key, series, query, reverse));
  }
}
