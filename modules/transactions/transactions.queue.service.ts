import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import TransactionsMessages from './transactions.messages';

/** The transaction queue: MULTI opens it (the dispatcher then queues commands), DISCARD drops it. */
export default class TransactionsQueueService {
  static multi(ctx: CommandContext): Reply {
    if (ctx.client.multi) throw new AppError(TransactionsMessages.MULTI_NESTED);
    ctx.client.multi = [];
    ctx.client.multiError = false;
    return OK;
  }

  /** DISCARD: drops the queue and the WATCHes. */
  static discard(ctx: CommandContext): Reply {
    if (!ctx.client.multi) throw new AppError(TransactionsMessages.DISCARD_WITHOUT_MULTI);
    ctx.client.multi = null;
    ctx.client.multiError = false;
    ctx.client.watched.clear();
    return OK;
  }
}
