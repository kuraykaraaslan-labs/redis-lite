/**
 * The time series data structure (TSDB-TYPE): samples kept in time order inside chunks, labels, compaction rules.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * Chunks hold parallel timestamp / value arrays. An uncompressed chunk holds CHUNK_SIZE / 16 samples (8-byte timestamp
 * + 8-byte double); a compressed chunk holds as many samples as fit in CHUNK_SIZE bytes of a Gorilla-style encoding
 * (delta-of-delta timestamps, XOR values), whose size is estimated bit by bit (no bytes are actually produced). A chunk
 * that overflows on an out-of-order insert is split in two halves.
 */
import type { ChunkEncoding, DuplicatePolicy } from './timeseries.enums';
import type { ChunkInfo, CompactionRule, Sample, SeriesSettings, UpsertStatus } from './timeseries.types';

/** The module type name: what TYPE and SCAN … TYPE report, and the name in the RDB module type id. */
export const TSDB_TYPE_NAME = 'TSDB-TYPE';

// ============================================================================
// Gorilla size estimate
// ============================================================================

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

/** Bits of a delta-of-delta timestamp in the Gorilla encoding. */
function dodBits(dod: number): number {
  if (dod === 0) return 1;
  if (dod >= -63 && dod <= 64) return 9;
  if (dod >= -255 && dod <= 256) return 12;
  if (dod >= -2047 && dod <= 2048) return 16;
  return 68;
}

function ctz32(x: number): number {
  return 31 - Math.clz32(x & -x);
}

/** Incremental bit count of a compressed chunk; `cost()` previews a sample, `push()` commits it. */
class GorillaSize {
  bits = 0;
  private count = 0;
  private prevTs = 0;
  private prevDelta = 0;
  private prevHi = 0;
  private prevLo = 0;
  private prevLead = -1;
  private prevTrail = -1;

  private measure(ts: number, value: number): { bits: number; lead: number; trail: number; hi: number; lo: number } {
    F64[0] = value;
    const hi = U32[1];
    const lo = U32[0];
    if (this.count === 0) return { bits: 128, lead: -1, trail: -1, hi, lo };
    let bits = dodBits(ts - this.prevTs - this.prevDelta);
    const xhi = (hi ^ this.prevHi) >>> 0;
    const xlo = (lo ^ this.prevLo) >>> 0;
    if (xhi === 0 && xlo === 0) return { bits: bits + 1, lead: this.prevLead, trail: this.prevTrail, hi, lo };
    const lead = xhi ? Math.clz32(xhi) : 32 + Math.clz32(xlo);
    const trail = xlo ? ctz32(xlo) : 32 + ctz32(xhi);
    if (this.prevLead >= 0 && lead >= this.prevLead && trail >= this.prevTrail) {
      bits += 2 + (64 - this.prevLead - this.prevTrail);
      return { bits, lead: this.prevLead, trail: this.prevTrail, hi, lo };
    }
    return { bits: bits + 13 + (64 - lead - trail), lead, trail, hi, lo };
  }

  cost(ts: number, value: number): number {
    return this.measure(ts, value).bits;
  }

  push(ts: number, value: number): void {
    const m = this.measure(ts, value);
    this.bits += m.bits;
    if (this.count > 0) this.prevDelta = ts - this.prevTs;
    this.prevTs = ts;
    this.prevHi = m.hi;
    this.prevLo = m.lo;
    this.prevLead = m.lead;
    this.prevTrail = m.trail;
    this.count++;
  }
}

// ============================================================================
// Chunk
// ============================================================================

/** A run of samples in time order. */
export class SeriesChunk {
  readonly timestamps: number[] = [];
  readonly values: number[] = [];
  private gorilla = new GorillaSize();

  constructor(readonly encoding: ChunkEncoding) {}

  get length(): number {
    return this.timestamps.length;
  }

  get first(): number {
    return this.timestamps[0];
  }

  get last(): number {
    return this.timestamps[this.timestamps.length - 1];
  }

  /** Encoded payload bytes. */
  get bytes(): number {
    return this.encoding === 'compressed' ? Math.ceil(this.gorilla.bits / 8) : this.length * 16;
  }

  /** Index of the first sample with timestamp >= ts. */
  lowerBound(ts: number): number {
    let lo = 0;
    let hi = this.timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.timestamps[mid] < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Whether one more sample at the end still fits in `chunkSize` bytes. */
  fits(ts: number, value: number, chunkSize: number): boolean {
    if (this.encoding === 'uncompressed') return (this.length + 1) * 16 <= chunkSize;
    return Math.ceil((this.gorilla.bits + this.gorilla.cost(ts, value)) / 8) <= chunkSize;
  }

  append(ts: number, value: number): void {
    this.timestamps.push(ts);
    this.values.push(value);
    if (this.encoding === 'compressed') this.gorilla.push(ts, value);
  }

  /** Recomputes the size estimate after a change that was not an append. */
  rebuild(): void {
    if (this.encoding === 'uncompressed') return;
    this.gorilla = new GorillaSize();
    for (let i = 0; i < this.timestamps.length; i++) this.gorilla.push(this.timestamps[i], this.values[i]);
  }

  /** A chunk holding samples [from, to) of this one. */
  slice(from: number, to = this.length): SeriesChunk {
    const out = new SeriesChunk(this.encoding);
    for (let i = from; i < to; i++) out.append(this.timestamps[i], this.values[i]);
    return out;
  }
}

// ============================================================================
// Time series
// ============================================================================

/** One TSDB-TYPE value. */
export class TimeSeries {
  chunks: SeriesChunk[] = [];
  labels = new Map<string, string>();
  /** Compaction rules of this series as a source, in creation order. */
  rules: CompactionRule[] = [];
  /** The series this one is a compaction of (validated against the source's rules on use). */
  srcKey: string | null = null;
  private count = 0;

  constructor(public settings: SeriesSettings) {}

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Index of the chunk that holds (or would hold) `ts`: the last chunk starting at or before it, 0 if none. */
  private chunkIndex(ts: number): number {
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.chunks[mid].first <= ts) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private overflows(chunk: SeriesChunk): boolean {
    return chunk.length > 1 && chunk.bytes > this.settings.chunkSize;
  }

  private appendSample(ts: number, value: number): void {
    const last = this.chunks[this.chunks.length - 1];
    if (last && last.fits(ts, value, this.settings.chunkSize)) last.append(ts, value);
    else {
      const chunk = new SeriesChunk(this.settings.encoding);
      chunk.append(ts, value);
      this.chunks.push(chunk);
    }
    this.count++;
  }

  // ──────────────────────────────────────────────
  // Public Methods: reads
  // ──────────────────────────────────────────────

  get totalSamples(): number {
    return this.count;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  /** Oldest timestamp (0 when empty, as TS.INFO reports). */
  get firstTimestamp(): number {
    return this.count ? this.chunks[0].first : 0;
  }

  /** Newest timestamp (0 when empty, as TS.INFO reports). */
  get lastTimestamp(): number {
    return this.count ? this.chunks[this.chunks.length - 1].last : 0;
  }

  /** The newest sample, undefined when empty. */
  lastSample(): Sample | undefined {
    if (!this.count) return undefined;
    const c = this.chunks[this.chunks.length - 1];
    return { timestamp: c.last, value: c.values[c.length - 1] };
  }

  /** Samples with from <= timestamp <= to, oldest first. */
  range(from: number, to: number): Sample[] {
    const out: Sample[] = [];
    if (!this.count || from > to) return out;
    for (let ci = this.chunkIndex(from); ci < this.chunks.length; ci++) {
      const c = this.chunks[ci];
      if (c.first > to) break;
      for (let i = c.lowerBound(from); i < c.length && c.timestamps[i] <= to; i++) out.push({ timestamp: c.timestamps[i], value: c.values[i] });
    }
    return out;
  }

  /** The newest sample older than `ts`. */
  before(ts: number): Sample | undefined {
    if (!this.count) return undefined;
    for (let ci = this.chunkIndex(ts); ci >= 0; ci--) {
      const c = this.chunks[ci];
      const i = c.lowerBound(ts) - 1;
      if (i >= 0) return { timestamp: c.timestamps[i], value: c.values[i] };
    }
    return undefined;
  }

  /** The oldest sample newer than `ts`. */
  after(ts: number): Sample | undefined {
    if (!this.count) return undefined;
    for (let ci = this.chunkIndex(ts); ci < this.chunks.length; ci++) {
      const c = this.chunks[ci];
      const i = c.lowerBound(ts + 1);
      if (i < c.length) return { timestamp: c.timestamps[i], value: c.values[i] };
    }
    return undefined;
  }

  /** TS.INFO DEBUG: one entry per chunk. */
  chunkInfo(): ChunkInfo[] {
    return this.chunks.map((c) => ({ startTimestamp: c.first, endTimestamp: c.last, samples: c.length, size: this.settings.chunkSize }));
  }

  /** Bytes the series takes (TS.INFO memoryUsage, MEMORY USAGE): header, labels, rules and allocated chunks. */
  memoryUsage(): number {
    let bytes = 128;
    for (const [k, v] of this.labels) bytes += k.length + v.length + 32;
    for (const r of this.rules) bytes += r.destKey.length + 64;
    if (this.srcKey !== null) bytes += this.srcKey.length + 16;
    for (const c of this.chunks) bytes += 48 + Math.max(this.settings.chunkSize, c.bytes);
    if (!this.chunks.length) bytes += 48 + this.settings.chunkSize;
    return bytes;
  }

  /** Chunks as TS.INFO counts them: a new series already has its first (empty) chunk allocated. */
  get chunkCount(): number {
    return Math.max(1, this.chunks.length);
  }

  // ──────────────────────────────────────────────
  // Public Methods: writes
  // ──────────────────────────────────────────────

  /** Adds or updates the sample at `ts`; an existing sample is resolved by `policy`. */
  upsert(ts: number, value: number, policy: DuplicatePolicy): UpsertStatus {
    if (!this.count || ts > this.lastTimestamp) {
      this.appendSample(ts, value);
      return 'added';
    }
    const ci = this.chunkIndex(ts);
    const c = this.chunks[ci];
    const i = c.lowerBound(ts);
    if (i < c.length && c.timestamps[i] === ts) {
      const old = c.values[i];
      let next: number;
      switch (policy) {
        case 'block':
          return 'blocked';
        case 'first':
          return 'unchanged';
        case 'last':
          next = value;
          break;
        case 'min':
          next = Math.min(old, value);
          break;
        case 'max':
          next = Math.max(old, value);
          break;
        case 'sum':
          next = old + value;
          break;
      }
      if (Object.is(next, old)) return 'unchanged';
      c.values[i] = next;
      c.rebuild();
      return 'updated';
    }
    c.timestamps.splice(i, 0, ts);
    c.values.splice(i, 0, value);
    c.rebuild();
    this.count++;
    if (this.overflows(c)) {
      const half = c.length >>> 1;
      this.chunks.splice(ci, 1, c.slice(0, half), c.slice(half));
    }
    return 'added';
  }

  /** Deletes the samples with from <= timestamp <= to; the number deleted. */
  deleteRange(from: number, to: number): number {
    if (!this.count || from > to) return 0;
    let deleted = 0;
    const kept: SeriesChunk[] = [];
    for (const c of this.chunks) {
      if (c.last < from || c.first > to) {
        kept.push(c);
        continue;
      }
      const start = c.lowerBound(from);
      const end = c.lowerBound(to + 1);
      deleted += end - start;
      c.timestamps.splice(start, end - start);
      c.values.splice(start, end - start);
      if (c.length) {
        c.rebuild();
        kept.push(c);
      }
    }
    this.chunks = kept;
    this.count -= deleted;
    return deleted;
  }

  /** Drops the samples older than the retention window (newest timestamp - retention). */
  trim(): void {
    const retention = this.settings.retention;
    if (!retention || !this.count) return;
    const min = this.lastTimestamp - retention;
    if (this.chunks[0].first >= min) return;
    this.deleteRange(0, min - 1);
  }

  /** A deep copy; `withRelations` keeps the compaction rules and the source key. */
  clone(withRelations: boolean): TimeSeries {
    const out = new TimeSeries({ ...this.settings });
    out.labels = new Map(this.labels);
    for (const c of this.chunks) {
      out.chunks.push(c.slice(0));
    }
    out.count = this.count;
    if (withRelations) {
      out.rules = this.rules.map((r) => ({ ...r }));
      out.srcKey = this.srcKey;
    }
    return out;
  }

  /** Rebuilds a series from saved chunks (RDB / DUMP payloads): sample order is trusted, chunk sizes are recomputed. */
  loadChunk(timestamps: number[], values: number[]): void {
    if (!timestamps.length) return;
    const c = new SeriesChunk(this.settings.encoding);
    for (let i = 0; i < timestamps.length; i++) c.append(timestamps[i], values[i]);
    this.chunks.push(c);
    this.count += timestamps.length;
  }
}
