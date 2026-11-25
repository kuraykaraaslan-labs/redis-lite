import { AppError } from '@/libs/app-error';
import { NULL_ARRAY } from '@/libs/resp';
import type { Reply } from '@/libs/resp';
import { firstIssue } from '@/libs/schemas';

import { BlockTimeoutSchema } from './command.dto';
import { Block } from './command.handler';
import type { CommandContext, HandlerResult } from './command.types';

/** The shared shape of blocking commands (BLPOP, BLMOVE, BZPOPMIN, XREAD BLOCK…) and their timeout argument. */
export default class CommandBlockingService {
  /**
   * Blocking timeout in seconds (float allowed) → ms; 0 = forever. Throws for modules that still parse with throwing
   * parsers; DTOs use `BlockTimeoutSchema` instead.
   */
  static parseTimeoutSeconds(raw: string): number {
    const parsed = BlockTimeoutSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(firstIssue(parsed.error));
    return parsed.data;
  }

  /**
   * Try now; if nothing, answer `timeoutReply` at once in MULTI/scripts, otherwise park the client until `attempt`
   * succeeds (re-run whenever one of `keys` changes) or the timeout fires. `attempt` must touch the keys it modifies
   * (via ctx.server.touch) since it may run outside the normal dispatch path.
   */
  static blockingCommand(
    ctx: CommandContext,
    keys: string[],
    timeoutMs: number,
    attempt: () => Reply | undefined,
    timeoutReply: Reply = NULL_ARRAY,
    /** Reply when the command cannot block (MULTI, scripts); defaults to `timeoutReply`. */
    immediateReply: Reply = timeoutReply,
  ): HandlerResult {
    const now = attempt();
    if (now !== undefined) return now;
    if (ctx.noBlock) return immediateReply;
    return new Block(keys, timeoutMs, attempt, timeoutReply);
  }
}
