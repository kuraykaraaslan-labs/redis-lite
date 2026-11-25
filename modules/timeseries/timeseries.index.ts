/**
 * The label index in the keyspace: which series a FILTER selects (TS.MGET, TS.MRANGE / TS.MREVRANGE, TS.QUERYINDEX),
 * and the upkeep the module's own writes do (TS.CREATE / ADD / INCRBY auto-create, compaction series, TS.ALTER LABELS,
 * RENAME). Shared by the sub-services like the store.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * One LabelIndex serves all databases of a server and is checked against them on use, so it stays correct without
 * being told about every keyspace change:
 * - an entry is reported only while the queried database holds that very series object at that key, unexpired
 *   (DEL, UNLINK, expiry, eviction, FLUSHDB / FLUSHALL, overwrites; MOVE and SWAPDB keep the key and the object, so the
 *   entry stays valid in whichever database now holds it);
 * - entries no database holds any more are dropped when met, and the index is rebuilt once stale entries could
 *   outnumber twice the stored keys (amortised O(1) per deletion);
 * - series built outside the module's creation path (RESTORE, COPY, loading at startup, DEBUG RELOAD) bump
 *   TimeSeries.created without being filed, so the next query rebuilds the index from the keyspace;
 * - RENAME files the series under its new name through the rules service's rename hook.
 * Matches are then checked against the live labels and sorted by key name, so replies equal a scan of every key.
 */
import type { CommandContext } from '@/modules/command/command.types';
import type { Database } from '@/modules/database/database.service';

import { LabelIndex } from './timeseries.index.structure';
import type { IndexEntry } from './timeseries.index.structure';
import { TimeSeries } from './timeseries.structure';
import type { LabelMatcher } from './timeseries.types';

/** The index of one server and the databases it covers. */
type ServerIndex = { index: LabelIndex; databases: readonly Database[] };

export default class TimeseriesIndex {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Per server, reached from any of its databases (weak: a closed server's index goes with it). */
  private static readonly byDatabase = new WeakMap<Database, ServerIndex>();

  /** Stale entries tolerated beyond twice the stored keys before a rebuild. */
  private static readonly STALE_SLACK = 1024;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static of(ctx: CommandContext): ServerIndex {
    const found = TimeseriesIndex.byDatabase.get(ctx.db);
    if (found) return found;
    // a database that is not one of the server's (a bare Database in a test) gets an index of its own
    const databases = ctx.server.databases.includes(ctx.db) ? ctx.server.databases : [ctx.db];
    const created: ServerIndex = { index: new LabelIndex(), databases };
    for (const db of databases) TimeseriesIndex.byDatabase.set(db, created);
    return created;
  }

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

  /** Rebuilds from every database when series appeared unannounced or stale entries piled up. */
  private static sync(s: ServerIndex): void {
    const stored = s.databases.reduce((n, db) => n + db.storedKeys, 0);
    const piledUp = s.index.size > 2 * stored + TimeseriesIndex.STALE_SLACK;
    if (s.index.synced === TimeSeries.created && !piledUp) return;
    s.index.clear();
    for (const db of s.databases) {
      for (const key of db.rawKeys()) {
        const v = db.raw(key);
        if (v?.type === 'timeseries') s.index.add(key, v.value);
      }
    }
    s.index.synced = TimeSeries.created;
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
    const s = S.of(ctx);
    S.sync(s);
    const now = Date.now();
    const out: Array<[string, TimeSeries]> = [];
    const stale: IndexEntry[] = [];
    const candidates = s.index.candidates(matchers);
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
        if (entry.labels !== series.labels) s.index.relabel(entry, series);
        if (S.matches(series, matchers)) out.push([entry.key, series]);
      } else if (!series || !S.stored(s.databases, entry.key, series)) stale.push(entry);
    }
    for (const entry of stale) s.index.remove(entry);
    return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // ──────────────────────────────────────────────
  // Public Methods: upkeep
  // ──────────────────────────────────────────────

  /** A series this module just constructed and stored at `key` (it is the newest TimeSeries built). */
  static added(db: Database, key: string, series: TimeSeries): void {
    const s = TimeseriesIndex.byDatabase.get(db);
    if (!s) return;
    const upToDate = s.index.synced === TimeSeries.created - 1;
    s.index.add(key, series);
    if (upToDate) s.index.synced = TimeSeries.created;
  }

  /** TS.ALTER replaced the labels of the series at `key`. */
  static relabeled(db: Database, key: string, series: TimeSeries): void {
    const s = TimeseriesIndex.byDatabase.get(db);
    if (!s) return;
    const entry = s.index.find(key, series);
    if (entry) s.index.relabel(entry, series);
    else s.index.add(key, series);
  }

  /** RENAME / RENAMENX moved `series` from `from` to `to`. */
  static renamed(db: Database, from: string, to: string, series: TimeSeries): void {
    const s = TimeseriesIndex.byDatabase.get(db);
    if (!s) return;
    const entry = s.index.find(from, series);
    if (entry) s.index.remove(entry);
    s.index.add(to, series);
  }
}
