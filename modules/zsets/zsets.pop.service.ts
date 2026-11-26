import { AppError } from '@/libs/app-error';
import { NULL_ARRAY, RespDouble, RespError, RespPairs } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
import type { CommandContext, HandlerResult } from '@/modules/command/command.types';

import type { BZMPopInput, BZPopInput, ZMPopInput, ZPopInput } from './zsets.dto';
import type { ZEntry } from './zsets.types';

/** Pops from either end: ZPOPMIN, ZPOPMAX, ZMPOP and their blocking forms BZPOPMIN, BZPOPMAX, BZMPOP. */
export default class ZSetsPopService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /**
   * Removes and returns up to `count` entries from the low (or high, `max`) end; the key goes when it empties. When
   * `serving` a blocked client, a key of another type counts as empty instead of WRONGTYPE: Redis leaves the client
   * blocked until the key holds a sorted set again (or another of its keys does).
   */
  private static popEntries(ctx: CommandContext, key: string, count: number, max: boolean, serving = false): ZEntry[] {
    let zset;
    if (serving) {
      const value = ctx.db.lookup(key);
      zset = value?.type === 'zset' ? value.value : undefined;
    } else zset = ctx.db.get(key, 'zset');
    if (!zset) return [];
    const picked = max ? zset.entries.slice(-count).reverse() : zset.entries.slice(0, count);
    for (const entry of picked) zset.remove(entry.member);
    ctx.db.removeIfEmpty(key);
    return picked;
  }

  /** One ZMPOP attempt: the first non-empty key, as [key, [[member, score] …]]; undefined when all are empty. */
  private static mPopAttempt(ctx: CommandContext, keys: string[], max: boolean, count: number, serving = false): Reply | undefined {
    for (const key of keys) {
      const popped = ZSetsPopService.popEntries(ctx, key, count, max, serving);
      if (!popped.length) continue;
      ctx.server.touch(ctx.client.dbIndex, key);
      return [key, popped.map((e) => [e.member, new RespDouble(e.score)])];
    }
    return undefined;
  }

  /**
   * The attempt of a blocking pop: `attempt(false)` runs as the command itself (errors are thrown as usual); every later
   * call serves the blocked client (`attempt(true)`), where an error becomes the client's reply instead of being thrown
   * out of the server's wake-up loop.
   */
  private static blockingAttempt(attempt: (serving: boolean) => Reply | undefined): () => Reply | undefined {
    let serving = false;
    return () => {
      if (!serving) {
        serving = true;
        return attempt(false);
      }
      try {
        return attempt(true);
      } catch (err) {
        if (err instanceof AppError) return new RespError(err.message);
        throw err;
      }
    };
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** ZPOPMIN / ZPOPMAX. Without COUNT, RESP3 gets a flat [member, score]; with COUNT, [member, score] pairs. */
  static pop(ctx: CommandContext, { key, count, withCount, max }: ZPopInput): Reply {
    const popped = ZSetsPopService.popEntries(ctx, key, count, max);
    if (!withCount) return popped.flatMap((e) => [e.member, new RespDouble(e.score)]);
    return new RespPairs(popped.map((e) => [e.member, new RespDouble(e.score)]));
  }

  /** BZPOPMIN / BZPOPMAX: [key, member, score] from the first non-empty key, or block. */
  static blockingPop(ctx: CommandContext, { keys, timeoutMs, max }: BZPopInput): HandlerResult {
    const attempt = ZSetsPopService.blockingAttempt((serving) => {
      for (const key of keys) {
        const [entry] = ZSetsPopService.popEntries(ctx, key, 1, max, serving);
        if (!entry) continue;
        ctx.server.touch(ctx.client.dbIndex, key);
        return [key, entry.member, new RespDouble(entry.score)];
      }
      return undefined;
    });
    return CommandService.blockingCommand(ctx, keys, timeoutMs, attempt);
  }

  static mPop(ctx: CommandContext, { keys, max, count }: ZMPopInput): Reply {
    return ZSetsPopService.mPopAttempt(ctx, keys, max, count) ?? NULL_ARRAY;
  }

  static blockingMPop(ctx: CommandContext, { timeoutMs, keys, max, count }: BZMPopInput): HandlerResult {
    const attempt = ZSetsPopService.blockingAttempt((serving) => ZSetsPopService.mPopAttempt(ctx, keys, max, count, serving));
    return CommandService.blockingCommand(ctx, keys, timeoutMs, attempt);
  }
}
