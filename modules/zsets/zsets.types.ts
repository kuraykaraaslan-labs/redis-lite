import type { RangeBy } from './zsets.enums';

/** One sorted-set element. */
export type ZEntry = {
  member: string;
  score: number;
};

/** A score bound: `5` (inclusive) or `(5` (exclusive); `-inf` / `+inf` are plain infinities. */
export type ScoreBound = {
  value: number;
  exclusive: boolean;
};

/** A lexicographic bound: `-` (min), `+` (max), `[a` (inclusive) or `(a` (exclusive). */
export type LexBound = { kind: 'min' } | { kind: 'max' } | { kind: 'value'; value: string; exclusive: boolean };

/** The options of a ZRANGE-family command, once the command's fixed parts (BYSCORE, REV…) are folded in. */
export type RangeOptions = {
  by: RangeBy;
  rev: boolean;
  limit: [offset: number, count: number] | null;
  scores: boolean;
};

/** What a range command fixes by itself (ZREVRANGEBYSCORE = score + rev); ZRANGE fixes nothing. */
export type FixedRange = {
  by?: RangeBy;
  rev?: boolean;
};

/** A range already parsed from its two arguments (bounds as min/max, i.e. already un-swapped for REV). */
export type ParsedRange =
  | { by: 'rank'; start: number; stop: number }
  | { by: 'score'; min: ScoreBound; max: ScoreBound }
  | { by: 'lex'; min: LexBound; max: LexBound };

/** Which options a ZUNION / ZINTER / ZDIFF variant accepts. */
export type CombineMode = {
  /** WITHSCORES (the non-STORE forms). */
  withScores: boolean;
  /** ZINTERCARD: only LIMIT, no WEIGHTS / AGGREGATE / WITHSCORES. */
  cardinality: boolean;
};

/** A ZUNION / ZINTER / ZDIFF input: a member → score map (plain sets count as score 1). */
export type ScoreSource = Map<string, number>;
