import { z } from 'zod';

/** OBJECT's subcommands that take a key (HELP is answered on its own). */
export const ObjectSubcommandEnum = z.enum(['encoding', 'refcount', 'idletime', 'freq']);

/** Conditions of the EXPIRE family (lowercase: options are matched case-insensitively). */
export const ExpireConditionEnum = z.enum(['nx', 'xx', 'gt', 'lt']);

export type ObjectSubcommand = z.infer<typeof ObjectSubcommandEnum>;
export type ExpireCondition = z.infer<typeof ExpireConditionEnum>;
