import { NULL_ARRAY } from '@/libs/resp';

import { blockingCommand } from '@/modules/command/command.blocking';
import type { CommandContext, HandlerResult } from '@/modules/command/command.types';

import type { BLMoveInput, BLMPopInput, BPopInput, MoveInput } from './lists.dto';
import ListStore from './lists.structure';

/**
 * Moves between lists and the blocking commands: LMOVE, RPOPLPUSH, BLPOP, BRPOP, BLMPOP, BLMOVE, BRPOPLPUSH.
 * A blocking command tries at once and otherwise parks the client until one of its keys changes or it times out.
 */
export default class ListsMoveService {
  /** LMOVE / RPOPLPUSH: the moved element, or nil when the source is empty. */
  static lMove(ctx: CommandContext, { source, destination, from, to }: MoveInput): string | null {
    return ListStore.move(ctx, source, destination, from, to) ?? null;
  }

  /** BLPOP / BRPOP: `[key, element]` from the first non-empty key. */
  static bPop(ctx: CommandContext, { keys, timeoutMs, left }: BPopInput): HandlerResult {
    return blockingCommand(ctx, keys, timeoutMs, () => ListStore.popFirst(ctx, keys, left));
  }

  static bLMPop(ctx: CommandContext, { keys, left, count, timeoutMs }: BLMPopInput): HandlerResult {
    return blockingCommand(ctx, keys, timeoutMs, () => ListStore.mPop(ctx, keys, left, count));
  }

  /** BLMOVE / BRPOPLPUSH: timing out answers a null array, but inside MULTI / scripts a null bulk (Redis quirk). */
  static bLMove(ctx: CommandContext, { source, destination, from, to, timeoutMs }: BLMoveInput): HandlerResult {
    return blockingCommand(ctx, [source], timeoutMs, () => ListStore.move(ctx, source, destination, from, to), NULL_ARRAY, null);
  }
}
