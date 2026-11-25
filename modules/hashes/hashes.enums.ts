import { z } from 'zod';

/** HEXPIRE's optional condition (lowercase: options are matched case-insensitively). */
export const FieldExpireConditionEnum = z.enum(['nx', 'xx', 'gt', 'lt']);

/** The expiry options of HGETEX / HSETEX (lowercase). */
export const FieldExpireOptionEnum = z.enum(['ex', 'px', 'exat', 'pxat']);

export type FieldExpireCondition = z.infer<typeof FieldExpireConditionEnum>;
export type FieldExpireOption = z.infer<typeof FieldExpireOptionEnum>;
