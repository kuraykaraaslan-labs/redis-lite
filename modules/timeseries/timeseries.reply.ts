/**
 * Reply shapes shared by the time series sub-services: samples, label lists and the RESP2 / RESP3 choice.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * A sample is `[timestamp, value]`: an integer and a double (a bulk string in RESP2). Labels are `[[label, value], …]`
 * in RESP2 and a map in RESP3. Replies whose RESP3 form is not just a re-typed RESP2 form (TS.MGET, TS.MRANGE, TS.INFO
 * rules) are built for the caller's protocol; scripts always get the RESP2 shape.
 */
import { RespDouble, RespMap } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { TimeSeries } from './timeseries.structure';
import type { LabelSelection, Sample } from './timeseries.types';

export default class TimeseriesReply {
  /** Whether the reply is built in its RESP3 shape. */
  static resp3(ctx: CommandContext): boolean {
    return ctx.client.resp === 3 && !ctx.inScript;
  }

  /** `[timestamp, value]`, or an empty array for no sample. */
  static sample(sample: Sample | null | undefined): Reply {
    return sample ? [sample.timestamp, new RespDouble(sample.value)] : [];
  }

  static samples(samples: Sample[]): Reply[] {
    return samples.map((s) => [s.timestamp, new RespDouble(s.value)]);
  }

  /** Label pairs: nested pairs in RESP2, a map in RESP3 (null values for SELECTED_LABELS a series lacks). */
  static labels(pairs: Array<[string, string | null]>): RespMap {
    return new RespMap(pairs, true);
  }

  /** The labels a multi-key reply carries for one series. */
  static selectLabels(series: TimeSeries, selection: LabelSelection): Array<[string, string | null]> {
    if (selection.kind === 'none') return [];
    if (selection.kind === 'all') return [...series.labels];
    return selection.labels.map((l) => [l, series.labels.get(l) ?? null]);
  }
}
