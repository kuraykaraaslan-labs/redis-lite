import { z } from 'zod';

/** A key name: any binary-safe string (latin1, one char per byte). */
export const KeySchema = z.string();

/** A value argument: any binary-safe string. */
export const ValueSchema = z.string();

export type Key = z.infer<typeof KeySchema>;
