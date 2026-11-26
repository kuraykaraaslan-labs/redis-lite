import type { LexBound, ScoreBound, ZEntry } from './zsets.types';

function compare(a: ZEntry, score: number, member: string): number {
  if (a.score !== score) return a.score < score ? -1 : 1;
  if (a.member === member) return 0;
  return a.member < member ? -1 : 1;
}

/** Sorted set: a member→score map plus an array kept sorted by (score, member). Simple, not fast. */
export class ZSet {
  readonly scores = new Map<string, number>();
  readonly entries: ZEntry[] = [];

  get size(): number {
    return this.scores.size;
  }

  /** Index of the first entry >= (score, member). */
  private lowerBound(score: number, member: string): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(this.entries[mid], score, member) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  add(member: string, score: number): void {
    this.remove(member);
    this.scores.set(member, score);
    this.entries.splice(this.lowerBound(score, member), 0, { member, score });
  }

  /**
   * A listpack-encoded sorted set cannot hold a -0 score: Redis reads it back as 0 (a skiplist keeps -0). Called by the
   * writers once they know the set is compact; the order is unchanged (-0 and 0 compare equal).
   */
  clearNegativeZeros(): void {
    for (const entry of this.entries) {
      if (!Object.is(entry.score, -0)) continue;
      entry.score = 0;
      this.scores.set(entry.member, 0);
    }
  }

  remove(member: string): boolean {
    const score = this.scores.get(member);
    if (score === undefined) return false;
    this.entries.splice(this.lowerBound(score, member), 1);
    this.scores.delete(member);
    return true;
  }

  rank(member: string): number | null {
    const score = this.scores.get(member);
    if (score === undefined) return null;
    return this.lowerBound(score, member);
  }

  /** [from, to) index window of entries whose score is inside the bounds. */
  scoreWindow(min: ScoreBound, max: ScoreBound): [number, number] {
    let lo = 0;
    let hi = this.entries.length;
    // first index satisfying min
    let a = lo;
    let b = hi;
    while (a < b) {
      const mid = (a + b) >>> 1;
      const s = this.entries[mid].score;
      if (s < min.value || (min.exclusive && s === min.value)) a = mid + 1;
      else b = mid;
    }
    lo = a;
    a = lo;
    b = hi;
    while (a < b) {
      const mid = (a + b) >>> 1;
      const s = this.entries[mid].score;
      if (s < max.value || (!max.exclusive && s === max.value)) a = mid + 1;
      else b = mid;
    }
    hi = a;
    return [lo, Math.max(lo, hi)];
  }

  /** [from, to) index window for lexicographic bounds (all scores assumed equal, as Redis requires). */
  lexWindow(min: LexBound, max: LexBound): [number, number] {
    let lo = 0;
    while (lo < this.entries.length && !lexAboveMin(this.entries[lo].member, min)) lo++;
    let hi = lo;
    while (hi < this.entries.length && lexBelowMax(this.entries[hi].member, max)) hi++;
    return [lo, hi];
  }
}

function lexAboveMin(member: string, min: LexBound): boolean {
  if (min.kind === 'min') return true;
  if (min.kind === 'max') return false;
  return min.exclusive ? member > min.value : member >= min.value;
}

function lexBelowMax(member: string, max: LexBound): boolean {
  if (max.kind === 'max') return true;
  if (max.kind === 'min') return false;
  return max.exclusive ? member < max.value : member <= max.value;
}
