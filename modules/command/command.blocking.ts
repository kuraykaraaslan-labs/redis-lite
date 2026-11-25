import { AppError } from '@/libs/app-error';
import { RespMessages } from '@/libs/resp/messages';
import type { Reply } from '@/libs/resp';
import { NULL_ARRAY } from '@/libs/resp';

import type { CommandContext, HandlerResult } from './command.types';
import { Block } from './command.handler';

/** Blocking timeout in seconds (float allowed) → ms; 0 = forever. */
export function parseTimeoutSeconds(raw: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || Number.isNaN(n) || !Number.isFinite(n)) throw new AppError(RespMessages.TIMEOUT_NOT_FLOAT);
  if (n < 0) throw new AppError(RespMessages.TIMEOUT_NEGATIVE);
  return n === 0 ? 0 : Math.max(1, Math.round(n * 1000));
}

/**
 * Shared shape of every blocking command: try now; if nothing, answer `timeoutReply` at once in MULTI/scripts,
 * otherwise park the client until `attempt` succeeds (re-run whenever one of `keys` changes) or the timeout fires.
 * `attempt` must touch the keys it modifies (via ctx.server.touch) since it may run outside the normal dispatch path.
 */
export function blockingCommand(
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
