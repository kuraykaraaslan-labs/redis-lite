import { z } from 'zod';

/** What a range's two bounds are: ranks (indexes), scores or members (lexicographic). */
export const RangeByEnum = z.enum(['rank', 'score', 'lex']);

/** ZUNION / ZINTER's AGGREGATE option (lowercased). */
export const AggregateEnum = z.enum(['sum', 'min', 'max']);

/** How ZUNION / ZINTER / ZDIFF combine their input sets. */
export const CombineOpEnum = z.enum(['union', 'inter', 'diff']);

/** ZMPOP / BZMPOP's side (lowercased). */
export const PopSideEnum = z.enum(['min', 'max']);

export type RangeBy = z.infer<typeof RangeByEnum>;
export type Aggregate = z.infer<typeof AggregateEnum>;
export type CombineOp = z.infer<typeof CombineOpEnum>;
export type PopSide = z.infer<typeof PopSideEnum>;
