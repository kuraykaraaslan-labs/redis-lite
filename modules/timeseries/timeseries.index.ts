/**
 * The label index in the keyspace: which series a FILTER selects (TS.MGET, TS.MRANGE / TS.MREVRANGE, TS.QUERYINDEX),
 * and its upkeep. Shared by the sub-services like the store.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * The server owns one LabelIndex (`server.labelIndex`) for all of its databases. Every Database reports its key changes
 * through the change listener server.core builds, which calls TimeseriesService.keyChanged: a series stored at a key
 * (TS.CREATE, auto-create, compactions, RESTORE, COPY, RENAME, MOVE, loading an RDB / AOF, a replica's full sync) is
 * filed there, and the entries of a key that no database holds any more are dropped. TS.ALTER LABELS changes labels in
 * place and refiles the series itself (`relabeled`). What the hook does not report one key at a time (FLUSHDB /
 * FLUSHALL, SWAPDB) is covered on use:
 * - an entry is reported only while the queried database holds that very series object at that key, unexpired
 *   (MOVE and SWAPDB keep the key and the object, so the entry stays valid in whichever database now holds it);
 * - entries no database holds any more are dropped when met, and the index is rebuilt once stale entries could
 *   outnumber twice the stored keys (amortised O(1) per deletion).
 * Matches are then checked against the live labels and sorted by key name, so replies equal a scan of every key.
 */
import type { CommandContext } from '@/modules/command/command.types';
import type { Database } from '@/modules/database/database.service';

import type { IndexEntry, LabelIndex } from './timeseries.index.structure';
import type { TimeSeries } from './timeseries.structure';
import type { LabelIndexHost, LabelMatcher } from './timeseries.types';

export default class TimeseriesIndex {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Stale entries tolerated beyond twice the stored keys before a rebuild. */
  private static readonly STALE_SLACK = 1024;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** The series object held at `key` by `db`, unexpired (what KEYS would list), without touching or expiring it. */
  private static holds(db: Database, key: string, series: TimeSeries, now: number): boolean {
    const v = db.raw(key);
    if (v?.type !== 'timeseries' || v.value !== series) return false;
    const at = db.getExpireRaw(key);
    return at === undefined || at > now;
  }

  /** True when some database still stores the series at the key (an expired, unreclaimed one counts). */
  private static stored(databases: readonly Database[], key: string, series: TimeSeries): boolean {
    return databases.some((db) => db.raw(key)?.value === series);
  }

  /** Rebuilds from every database once stale entries (left by FLUSHDB / FLUSHALL) piled up. */
  private static compact(host: LabelIndexHost): void {
    const index = host.labelIndex;
    const stored = host.databases.reduce((n, db) => n + db.storedKeys, 0);
    if (index.size <= 2 * stored + TimeseriesIndex.STALE_SLACK) return;
    index.clear();
    for (const db of host.databases) {
      for (const key of db.rawKeys()) {
        const v = db.raw(key);
        if (v?.type === 'timeseries') index.add(key, v.value);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods: matching
  // ──────────────────────────────────────────────

  /** Whether the series' labels satisfy every FILTER matcher. */
  static matches(series: TimeSeries, matchers: LabelMatcher[]): boolean {
    return matchers.every(({ label, negate, values }) => {
      const value = series.labels.get(label);
      if (!values.length) return negate ? value !== undefined : value === undefined;
      const hit = value !== undefined && values.includes(value);
      return negate ? !hit : hit;
    });
  }

  /** The series of the current database the matchers select, by key name. */
  static select(ctx: CommandContext, matchers: LabelMatcher[]): Array<[string, TimeSeries]> {
    const S = TimeseriesIndex;
    const host: LabelIndexHost = ctx.server;
    S.compact(host);
    const index = host.labelIndex;
    const now = Date.now();
    const out: Array<[string, TimeSeries]> = [];
    const stale: IndexEntry[] = [];
    const candidates = index.candidates(matchers);
    if (candidates === null) {
      // no generating matcher (the DTO refuses that): scan the database
      for (const key of ctx.db.keys()) {
        const v = ctx.db.raw(key);
        if (v?.type === 'timeseries' && S.matches(v.value, matchers)) out.push([key, v.value]);
      }
    }
    for (const entry of candidates ?? []) {
      const series = entry.ref.deref();
      if (series && S.holds(ctx.db, entry.key, series, now)) {
        if (entry.labels !== series.labels) index.relabel(entry, series);
        if (S.matches(series, matchers)) out.push([entry.key, series]);
      } else if (!series || !S.stored(host.databases, entry.key, series)) stale.push(entry);
    }
    for (const entry of stale) index.remove(entry);
    return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // ──────────────────────────────────────────────
  // Public Methods: upkeep
  // ──────────────────────────────────────────────

  /**
   * The Database change hook: `key` of `db` was written, deleted or got a new TTL (null: the whole database was
   * flushed or swapped). A series now stored there is filed; entries of the key no database stores any more go.
   */
  static keyChanged(host: LabelIndexHost, db: Database, key: string | null): void {
    if (key === null) return;
    const index = host.labelIndex;
    const v = db.raw(key);
    if (v?.type === 'timeseries') index.add(key, v.value);
    const entries = index.entriesAt(key);
    if (!entries) return;
    for (const entry of [...entries]) {
      const series = entry.ref.deref();
      if (!series || !TimeseriesIndex.stored(host.databases, key, series)) index.remove(entry);
    }
  }

  /** TS.ALTER replaced the labels of the series at `key`. */
  static relabeled(index: LabelIndex, key: string, series: TimeSeries): void {
    const entry = index.find(key, series);
    if (entry) index.relabel(entry, series);
    else index.add(key, series);
  }
}
