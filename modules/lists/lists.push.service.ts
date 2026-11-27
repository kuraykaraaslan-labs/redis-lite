import { NULL_ARRAY } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { MPopInput, PopInput, PushInput } from './lists.dto';
import ListStore from './lists.structure';

/** Both ends of a list: LPUSH, RPUSH, LPUSHX, RPUSHX, LPOP, RPOP, LMPOP. */
export default class ListsPushService {
  /** The *PUSH family: the new length; the X forms push only onto an existing list (0 otherwise). */
  static push(ctx: CommandContext, { key, values, left, onlyIfExists }: PushInput): number {
    if (onlyIfExists && !ListStore.read(ctx, key)) return 0;
    const l = ctx.db.getOrCreate(key, 'list', ListStore.creator(ctx));
    if (left) for (let i = 0; i < values.length; i++) l.unshift(values[i]);
    else for (let i = 0; i < values.length; i++) l.push(values[i]);
    return l.length;
  }

  /** LPOP / RPOP: one element (no count) or an array of up to `count`; a missing key is nil / a null array. */
  static pop(ctx: CommandContext, { key, left, count }: PopInput): Reply {
    const hasCount = count !== null;
    const out = ListStore.pop(ctx, key, left, count ?? 1);
    if (!out) return hasCount ? NULL_ARRAY : null;
    return hasCount ? out : (out[0] ?? null);
  }

  /** LMPOP: `[key, elements]` from the first non-empty key, or a null array. */
  static mPop(ctx: CommandContext, { keys, left, count }: MPopInput): Reply {
    return ListStore.mPop(ctx, keys, left, count) ?? NULL_ARRAY;
  }
}
