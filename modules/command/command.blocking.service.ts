import { NULL_ARRAY } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import { Block } from './command.handler';
import type { CommandContext, HandlerResult } from './command.types';

/** The shared shape of blocking commands (BLPOP, BLMOVE, BZPOPMIN, XREAD BLOCK…); their timeout is `BlockTimeoutSchema`. */
export default class CommandBlockingService {
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
