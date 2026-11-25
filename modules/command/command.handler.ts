import type { z } from 'zod';

import { NULL_ARRAY } from '@/libs/resp';
import type { Reply } from '@/libs/resp';
import { validationErrorReply } from '@/libs/schemas';

import type { CommandContext, CommandSpec, HandlerResult } from './command.types';

// ============================================================================
// Handler results
// ============================================================================

/** Returned by a blocking command that found nothing: the server parks the client until `retry` yields a reply or the timeout fires. */
export class Block {
  constructor(
    readonly keys: string[],
    /** 0 = wait forever. */
    readonly timeoutMs: number,
    /** Tries again; undefined = still nothing to serve. */
    readonly retry: () => Reply | undefined,
    readonly timeoutReply: Reply = NULL_ARRAY,
  ) {}
}

/** The handler already wrote its replies (SUBSCRIBE family). */
export const NO_REPLY = Symbol('NO_REPLY');

// ============================================================================
// Handler builders
// ============================================================================

/** Key extractor for keys at fixed positions: first..last (inclusive, -1 = last arg) every `step`. */
export function keysAt(first: number, last = first, step = 1): (args: string[]) => string[] {
  return (args) => {
    const end = last < 0 ? args.length + last : last;
    const out: string[] = [];
    for (let i = first; i <= end && i < args.length; i += step) out.push(args[i]);
    return out;
  };
}

/**
 * Parses `args` with `dto` and runs `action` on the result. A failed parse is answered with its error reply: validation
 * errors are returned, never thrown.
 */
export function validated<TInput>(dto: z.ZodType<TInput>, args: string[], action: (input: TInput) => HandlerResult): HandlerResult {
  const parsed = dto.safeParse(args);
  return parsed.success ? action(parsed.data) : validationErrorReply(parsed.error);
}

/** The usual handler: validate the arguments with `dto`, then call the service with the typed input. */
export function withDTO<TInput>(
  dto: z.ZodType<TInput>,
  action: (ctx: CommandContext, input: TInput) => HandlerResult,
): CommandSpec['handler'] {
  return (ctx, args) => validated(dto, args, (input) => action(ctx, input));
}
