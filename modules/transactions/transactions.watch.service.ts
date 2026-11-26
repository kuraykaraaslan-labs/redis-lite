import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { WatchInput } from './transactions.dto';
import TransactionsMessages from './transactions.messages';

/** Optimistic locking: WATCH registers each key, a change marks the client dirty and EXEC then fails; UNWATCH forgets them. */
export default class TransactionsWatchService {
  static watch(ctx: CommandContext, { keys }: WatchInput): Reply {
    if (ctx.client.multi) throw new AppError(TransactionsMessages.WATCH_IN_MULTI);
    for (const key of keys) {
      // expire first, so an already-expired key does not count as a change later (no LRU/LFU touch)
      const alive = ctx.db.peek(key) !== undefined;
      ctx.server.watchKey(ctx.client, ctx.client.dbIndex, key, alive);
    }
    return OK;
  }

  static unwatch(ctx: CommandContext): Reply {
    ctx.client.watched.clear();
    return OK;
  }
}
