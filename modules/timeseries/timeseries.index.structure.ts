/**
 * The label index of the time series module (a data structure, no keyspace knowledge): postings label → value →
 * entries and label → entries, plus key → entries, so a FILTER is answered from the series that carry its labels
 * instead of a scan of every key.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * An entry is a (key, series) pair as it was last seen, with the labels it is filed under. The series is held weakly:
 * an entry left behind by a deleted series never keeps the series alive, and the caller (TimeseriesIndex) drops such
 * entries when it meets them. The server owns one instance (a stateful component, see docs/STRUCTURE.md). Several entries may share a key (the same name in two databases, or a stale entry).
 */
import type { TimeSeries } from './timeseries.structure';
import type { LabelMatcher } from './timeseries.types';

/** One indexed series: its key, the series (weakly) and the label map it is filed under. */
export type IndexEntry = {
  key: string;
  ref: WeakRef<TimeSeries>;
  labels: Map<string, string>;
};

export class LabelIndex {
  /** label → value → entries with that value. */
  private readonly byValue = new Map<string, Map<string, Set<IndexEntry>>>();
  /** label → entries that have the label. */
  private readonly byLabel = new Map<string, Set<IndexEntry>>();
  private readonly byKey = new Map<string, Set<IndexEntry>>();
  private count = 0;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static addTo<K>(map: Map<K, Set<IndexEntry>>, k: K, entry: IndexEntry): void {
    const set = map.get(k);
    if (set) set.add(entry);
    else map.set(k, new Set([entry]));
  }

  private static removeFrom<K>(map: Map<K, Set<IndexEntry>>, k: K, entry: IndexEntry): void {
    const set = map.get(k);
    if (!set) return;
    set.delete(entry);
    if (!set.size) map.delete(k);
  }

  private file(entry: IndexEntry): void {
    for (const [label, value] of entry.labels) {
      let values = this.byValue.get(label);
      if (!values) this.byValue.set(label, (values = new Map()));
      LabelIndex.addTo(values, value, entry);
      LabelIndex.addTo(this.byLabel, label, entry);
    }
  }

  private unfile(entry: IndexEntry): void {
    for (const [label, value] of entry.labels) {
      const values = this.byValue.get(label);
      if (values) {
        LabelIndex.removeFrom(values, value, entry);
        if (!values.size) this.byValue.delete(label);
      }
      LabelIndex.removeFrom(this.byLabel, label, entry);
    }
  }

  /**
   * The entries a matcher can select from (a union of disjoint sets), or null when it cannot generate candidates
   * (`label=`, `label!=value`, `label!=(…)`). `label!=` (label present) generates from label → entries.
   */
  private postings({ label, negate, values }: LabelMatcher): Array<Set<IndexEntry>> | null {
    if (negate) return values.length ? null : [this.byLabel.get(label) ?? new Set()];
    if (!values.length) return null;
    const byValue = this.byValue.get(label);
    const out: Array<Set<IndexEntry>> = [];
    for (const value of new Set(values)) {
      const set = byValue?.get(value);
      if (set) out.push(set);
    }
    return out;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Number of entries (stale ones included). */
  get size(): number {
    return this.count;
  }

  /** The entry of `series` at `key`, if any. */
  find(key: string, series: TimeSeries): IndexEntry | undefined {
    const set = this.byKey.get(key);
    if (!set) return undefined;
    for (const entry of set) if (entry.ref.deref() === series) return entry;
    return undefined;
  }

  /** The entries filed at `key` (live; copy before removing while iterating). */
  entriesAt(key: string): ReadonlySet<IndexEntry> | undefined {
    return this.byKey.get(key);
  }

  /** Files `series` at `key` under its current labels (refiles an existing entry whose labels were replaced). */
  add(key: string, series: TimeSeries): IndexEntry {
    const existing = this.find(key, series);
    if (existing) {
      if (existing.labels !== series.labels) this.relabel(existing, series);
      return existing;
    }
    const entry: IndexEntry = { key, ref: new WeakRef(series), labels: series.labels };
    this.file(entry);
    LabelIndex.addTo(this.byKey, key, entry);
    this.count++;
    return entry;
  }

  /** Refiles an entry under the current labels of its series. */
  relabel(entry: IndexEntry, series: TimeSeries): void {
    this.unfile(entry);
    entry.labels = series.labels;
    this.file(entry);
  }

  remove(entry: IndexEntry): void {
    if (!this.byKey.get(entry.key)?.has(entry)) return;
    this.unfile(entry);
    LabelIndex.removeFrom(this.byKey, entry.key, entry);
    this.count--;
  }

  clear(): void {
    this.byValue.clear();
    this.byLabel.clear();
    this.byKey.clear();
    this.count = 0;
  }

  /**
   * The entries filed under labels that satisfy every generating matcher (`label=v`, `label=(…)`, `label!=`): the
   * smallest posting group drives, the others are checked by membership. The other matchers, and whether an entry is
   * still live, are the caller's to check. Null when no matcher generates (the DTO never lets that through).
   */
  candidates(matchers: LabelMatcher[]): IndexEntry[] | null {
    const groups: Array<{ sets: Array<Set<IndexEntry>>; size: number }> = [];
    for (const m of matchers) {
      const sets = this.postings(m);
      if (sets) groups.push({ sets, size: sets.reduce((n, s) => n + s.size, 0) });
    }
    if (!groups.length) return null;
    groups.sort((a, b) => a.size - b.size);
    const [driver, ...rest] = groups;
    const out: IndexEntry[] = [];
    for (const set of driver.sets) {
      for (const entry of set) {
        if (rest.every((g) => g.sets.some((s) => s.has(entry)))) out.push(entry);
      }
    }
    return out;
  }
}
