import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { WatchInput } from './transactions.dto';
import TransactionsMessages from './transactions.messages';

/** Optimistic locking: WATCH remembers each key's version, EXEC fails when one changed; UNWATCH forgets them. */
export default class TransactionsWatchService {
  static watch(ctx: CommandContext, { keys }: WatchInput): Reply {
    if (ctx.client.multi) throw new AppError(TransactionsMessages.WATCH_IN_MULTI);
    for (const key of keys) {
      ctx.db.peek(key); // expire first, so an already-expired key does not count as a change later (no LRU/LFU touch)
      const k = `${ctx.client.dbIndex}:${key}`;
      if (!ctx.client.watched.has(k)) ctx.client.watched.set(k, ctx.server.keyVersion(ctx.client.dbIndex, key));
    }
    return OK;
  }

  static unwatch(ctx: CommandContext): Reply {
    ctx.client.watched.clear();
    return OK;
  }
}
