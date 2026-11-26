import { NULL_ARRAY } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
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
    const attempt = ListStore.blockingAttempt((serving) => ListStore.popFirst(ctx, keys, left, serving));
    return CommandService.blockingCommand(ctx, keys, timeoutMs, attempt);
  }

  static bLMPop(ctx: CommandContext, { keys, left, count, timeoutMs }: BLMPopInput): HandlerResult {
    const attempt = ListStore.blockingAttempt((serving) => ListStore.mPop(ctx, keys, left, count, serving));
    return CommandService.blockingCommand(ctx, keys, timeoutMs, attempt);
  }

  /** BLMOVE / BRPOPLPUSH: timing out answers a null array, but inside MULTI / scripts a null bulk (Redis quirk). */
  static bLMove(ctx: CommandContext, { source, destination, from, to, timeoutMs }: BLMoveInput): HandlerResult {
    const attempt = ListStore.blockingAttempt((serving) =>
      serving ? ListStore.serveMove(ctx, source, destination, from, to) : ListStore.move(ctx, source, destination, from, to),
    );
    return CommandService.blockingCommand(ctx, [source], timeoutMs, attempt, NULL_ARRAY, null);
  }
}
