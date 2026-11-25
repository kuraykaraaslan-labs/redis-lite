import { z } from 'zod';

/** Outcome of an eviction pass: under the limit, still over (continuing in the background), or nothing to evict. */
export const EvictionResultEnum = z.enum(['ok', 'running', 'fail']);

export type EvictionResult = z.infer<typeof EvictionResultEnum>;
