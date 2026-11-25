import { z } from 'zod';

/** SET's existence condition: only set when the key does not exist (NX) or already exists (XX). */
export const SetConditionEnum = z.enum(['NX', 'XX']);

/** LCS's flag options (MINMATCHLEN takes a value and is parsed on its own). */
export const LcsFlagEnum = z.enum(['LEN', 'IDX', 'WITHMATCHLEN']);

export type SetCondition = z.infer<typeof SetConditionEnum>;
export type LcsFlag = z.infer<typeof LcsFlagEnum>;
