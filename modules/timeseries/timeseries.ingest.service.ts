/**
 * Writes of samples: TS.CREATE, TS.ADD, TS.MADD, TS.INCRBY / TS.DECRBY, TS.DEL.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { AppError } from '@/libs/app-error';
import { OK, RespError } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { AddInput, CreateInput, DelInput, IncrByInput, MAddInput } from './timeseries.dto';
import TimeseriesMessages from './timeseries.messages';
import TimeseriesStore from './timeseries.store';

export default class TimeseriesIngestService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** `*` is the server's clock, in ms. */
  private static resolve(timestamp: number | '*'): number {
    return timestamp === '*' ? Date.now() : timestamp;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** TS.CREATE: a new, empty series; any existing key (of any type) is refused. */
  static create(ctx: CommandContext, { key, options }: CreateInput): Reply {
    if (ctx.db.has(key)) throw new AppError(TimeseriesMessages.KEY_EXISTS);
    TimeseriesStore.create(ctx, key, options);
    return OK;
  }

  /**
   * TS.ADD: creates the series with the given options when missing (they are ignored for an existing series, except
   * ON_DUPLICATE). The reply is the sample's timestamp, or the newest one when IGNORE dropped the sample.
   */
  static add(ctx: CommandContext, { key, timestamp, value, options, onDuplicate }: AddInput): number {
    const ts = TimeseriesIngestService.resolve(timestamp);
    const series = TimeseriesStore.find(ctx.db, key) ?? TimeseriesStore.create(ctx, key, options);
    const result = TimeseriesStore.ingest(ctx, key, series, ts, value, TimeseriesStore.effectivePolicy(ctx, series, onDuplicate));
    if (!result.written) ctx.noop = true;
    return result.timestamp;
  }

  /** TS.MADD: one reply per sample, a timestamp or an error (missing key, WRONGTYPE, BLOCK, retention). */
  static mAdd(ctx: CommandContext, { samples }: MAddInput): Reply[] {
    const out: Reply[] = [];
    let written = false;
    for (const { key, timestamp, value } of samples) {
      try {
        const series = TimeseriesStore.require(ctx.db, key);
        const ts = TimeseriesIngestService.resolve(timestamp);
        const result = TimeseriesStore.ingest(ctx, key, series, ts, value, TimeseriesStore.effectivePolicy(ctx, series, null));
        written ||= result.written;
        out.push(result.timestamp);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        out.push(new RespError(error.message));
      }
    }
    if (!written) ctx.noop = true;
    return out;
  }

  /**
   * TS.INCRBY / TS.DECRBY (the DTO signs the delta): the newest value plus the delta, at TIMESTAMP (default: now), which
   * may not be older than the newest sample. A missing series is created (starting from 0) with the given options.
   */
  static incrBy(ctx: CommandContext, { key, delta, timestamp, options }: IncrByInput): number {
    const series = TimeseriesStore.find(ctx.db, key) ?? TimeseriesStore.create(ctx, key, options);
    const ts = TimeseriesIngestService.resolve(timestamp);
    const last = series.lastSample();
    if (last && ts < last.timestamp) throw new AppError(TimeseriesMessages.INCRBY_TOO_OLD);
    const result = TimeseriesStore.ingest(ctx, key, series, ts, (last?.value ?? 0) + delta, 'last');
    if (!result.written) ctx.noop = true;
    return result.timestamp;
  }

  /** TS.DEL: deletes [from, to] (inclusive) and re-aggregates the compacted buckets it touched; the number deleted. */
  static del(ctx: CommandContext, { key, from, to }: DelInput): number {
    const series = TimeseriesStore.require(ctx.db, key);
    const deleted = series.deleteRange(from, to);
    if (deleted) TimeseriesStore.afterDelete(ctx, key, series, from, to);
    else ctx.noop = true;
    return deleted;
  }
}
