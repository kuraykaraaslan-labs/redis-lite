import { z } from 'zod';

/** How SUNION / SINTER / SDIFF (and their STORE / CARD forms) combine their sets. */
export const SetOperationEnum = z.enum(['union', 'inter', 'diff']);

export type SetOperation = z.infer<typeof SetOperationEnum>;
