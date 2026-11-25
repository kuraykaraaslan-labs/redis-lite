import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Status } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { MoveInput, SwapDbInput } from './keys.dto';
import KeysMessages from './keys.messages';

/** Keys across databases: MOVE, SWAPDB. */
export default class KeysDatabaseService {
  /** MOVE: 1 when moved (with its TTL); 0 when the source is missing or the destination already has the key. */
  static move(ctx: CommandContext, { key, db }: MoveInput): number {
    const target = ctx.server.databases[db];
    if (!target) throw new AppError(KeysMessages.DB_INDEX);
    if (db === ctx.client.dbIndex) throw new AppError(KeysMessages.SAME_OBJECT);
    const v = ctx.db.lookup(key);
    if (!v || target.has(key)) return 0;
    const at = ctx.db.getExpire(key);
    ctx.db.remove(key);
    target.set(key, v);
    if (at !== undefined) target.setExpire(key, at);
    ctx.server.touch(db, key);
    return 1;
  }

  static swapDb(ctx: CommandContext, { first, second }: SwapDbInput): Status {
    if (!ctx.server.databases[first] || !ctx.server.databases[second]) throw new AppError(KeysMessages.DB_INDEX);
    if (first !== second) ctx.server.swapDatabases(first, second);
    return OK;
  }
}
