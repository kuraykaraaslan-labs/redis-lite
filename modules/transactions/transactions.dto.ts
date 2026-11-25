import { z } from 'zod';

import { KeySchema } from '@/libs/schemas';

/** Argument grammar of the transaction commands (MULTI, EXEC, DISCARD and UNWATCH take no arguments). */

// ============================================================================
// Watch DTOs
// ============================================================================

export const WatchDTO = z.array(KeySchema).transform((keys) => ({ keys }));

// ============================================================================
// Type Exports
// ============================================================================

export type WatchInput = z.infer<typeof WatchDTO>;
