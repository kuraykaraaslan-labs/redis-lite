import { z } from 'zod';

/** SHUTDOWN options. */
export const ShutdownFlagEnum = z.enum(['save', 'nosave', 'now', 'force', 'abort']);

/** COMMAND LIST FILTERBY kinds. */
export const CommandFilterEnum = z.enum(['module', 'aclcat', 'pattern']);

export type ShutdownFlag = z.infer<typeof ShutdownFlagEnum>;
export type CommandFilter = z.infer<typeof CommandFilterEnum>;
