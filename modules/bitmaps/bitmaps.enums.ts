import { z } from 'zod';

/** BITOP operations (lowercase: matched case-insensitively). */
export const BitOpEnum = z.enum(['and', 'or', 'xor', 'not']);

/** The unit of a BITCOUNT / BITPOS range. */
export const RangeUnitEnum = z.enum(['byte', 'bit']);

/** BITFIELD subcommands that read or write a field. */
export const BitfieldOpEnum = z.enum(['get', 'set', 'incrby']);

/** BITFIELD OVERFLOW policies. */
export const OverflowPolicyEnum = z.enum(['wrap', 'sat', 'fail']);

export type BitOp = z.infer<typeof BitOpEnum>;
export type RangeUnit = z.infer<typeof RangeUnitEnum>;
export type BitfieldOp = z.infer<typeof BitfieldOpEnum>;
export type OverflowPolicy = z.infer<typeof OverflowPolicyEnum>;
