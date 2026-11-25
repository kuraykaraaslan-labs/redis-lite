import { z } from 'zod';

/** The end of a list an element leaves or enters (LMOVE, BLMOVE, LMPOP; lowercase, matched case-insensitively). */
export const ListSideEnum = z.enum(['left', 'right']);

/** Where LINSERT puts the element relative to the pivot (lowercase). */
export const InsertPositionEnum = z.enum(['before', 'after']);

/** LPOS options that take a value (lowercase). */
export const LPosOptionEnum = z.enum(['rank', 'count', 'maxlen']);

export type ListSide = z.infer<typeof ListSideEnum>;
export type InsertPosition = z.infer<typeof InsertPositionEnum>;
export type LPosOption = z.infer<typeof LPosOptionEnum>;
