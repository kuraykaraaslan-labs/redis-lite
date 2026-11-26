/**
 * Per-command latency histogram (LATENCY HISTOGRAM, INFO latencystats): command durations in nanoseconds, bucketed like
 * an HDR histogram with two significant digits (256 sub-buckets per power of two). A value is reported as the highest
 * value of its bucket, which is how Redis prints percentiles such as `p50=7.007` for a 7 µs call.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
export class LatencyHistogram {
  /** Durations are clamped to 1024 ns .. 1 s, as Redis records them. */
  private static readonly MIN_NS = 1024;
  private static readonly MAX_NS = 1_000_000_000;
  /** Below 2^8 every nanosecond is its own bucket; above, a power-of-two range is split into 128 buckets. */
  private static readonly SUB_BUCKET_BITS = 7;

  /** Lowest value of a bucket → count. */
  private readonly counts = new Map<number, number>();
  private total = 0;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Width of the bucket holding `ns`. */
  private static width(ns: number): number {
    const magnitude = Math.floor(Math.log2(ns));
    return magnitude <= LatencyHistogram.SUB_BUCKET_BITS ? 1 : 2 ** (magnitude - LatencyHistogram.SUB_BUCKET_BITS);
  }

  private static lowest(ns: number): number {
    const w = LatencyHistogram.width(ns);
    return Math.floor(ns / w) * w;
  }

  /** The highest value that falls in the same bucket as `ns`. */
  private static highest(ns: number): number {
    return LatencyHistogram.lowest(ns) + LatencyHistogram.width(ns) - 1;
  }

  /** Recorded buckets in increasing order. */
  private sorted(): Array<[lowest: number, count: number]> {
    return [...this.counts.entries()].sort((a, b) => a[0] - b[0]);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Number of recorded calls. */
  get calls(): number {
    return this.total;
  }

  record(usec: number): void {
    const ns = Math.min(LatencyHistogram.MAX_NS, Math.max(LatencyHistogram.MIN_NS, Math.round(usec * 1000)));
    const key = LatencyHistogram.lowest(ns);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.total++;
  }

  /** The value (ns) at `percentile` (0..100): the highest value of the bucket the percentile falls in. */
  valueAt(percentile: number): number {
    if (!this.total) return 0;
    const target = Math.max(1, Math.round((Math.min(100, percentile) / 100) * this.total));
    let seen = 0;
    let last = 0;
    for (const [lowest, count] of this.sorted()) {
      seen += count;
      last = lowest;
      if (seen >= target) break;
    }
    return LatencyHistogram.highest(last);
  }

  /**
   * LATENCY HISTOGRAM `histogram_usec`: [bucket upper bound in µs, calls up to it] for the power-of-two buckets
   * (1 µs, 2 µs, 4 µs…) where the cumulative count grows.
   */
  cumulativeBuckets(): Array<[usec: number, cumulative: number]> {
    const out: Array<[number, number]> = [];
    const buckets = this.sorted();
    let i = 0;
    let cumulative = 0;
    for (let bound = 1024; i < buckets.length; bound *= 2) {
      const top = LatencyHistogram.highest(bound);
      const before = cumulative;
      while (i < buckets.length && buckets[i][0] <= top) cumulative += buckets[i++][1];
      if (cumulative > before) out.push([Math.floor(top / 1000), cumulative]);
    }
    return out;
  }
}
