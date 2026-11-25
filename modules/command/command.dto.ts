import { z } from 'zod';

import { reject } from '@/libs/schemas';

import CommandMessages from './command.messages';

/**
 * Argument primitives of the command layer, shared by the modules whose commands block (BLPOP, BZPOPMIN, XREAD…) and by
 * container commands (CLIENT, CONFIG…). Stateless: no context, no database.
 */

// ============================================================================
// Shared Schemas
// ============================================================================

/** The subcommand token of a container command, as typed (error texts quote it as sent). */
export const SubcommandSchema = z.string();

/** Blocking timeout in seconds (float allowed) → ms; 0 = forever. Not a number → not a float; below zero → negative. */
export const BlockTimeoutSchema = z.string().transform((raw, ctx) => {
  const n = Number(raw);
  if (raw.trim() === '' || Number.isNaN(n) || !Number.isFinite(n)) return reject(ctx, CommandMessages.TIMEOUT_NOT_FLOAT);
  if (n < 0) return reject(ctx, CommandMessages.TIMEOUT_NEGATIVE);
  return n === 0 ? 0 : Math.max(1, Math.round(n * 1000));
});

// ============================================================================
// Type Exports
// ============================================================================

export type BlockTimeoutInput = z.infer<typeof BlockTimeoutSchema>;
