import { AppError } from '@/libs/app-error';
import { RespDouble } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import DatabaseService from '@/modules/database/database.service';

import type { KeyMembersInput, ZAddInput, ZIncrByInput } from './zsets.dto';
import ZSetsMessages from './zsets.messages';
import { ZSet } from './zsets.structure';

/** Member writes: ZADD, ZINCRBY, ZREM. */
export default class ZSetsWriteService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** After a -0 score was written: a compact (listpack) set stores it as 0, as Redis does; a skiplist keeps -0. */
  private static storeNegativeZero(ctx: CommandContext, zset: ZSet): void {
    if (DatabaseService.isCompact({ type: 'zset', value: zset }, ctx.server.config)) zset.clearNegativeZeros();
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** ZADD with its flags; the reply is the added count (CH: added + changed), or the new score with INCR. */
  static add(ctx: CommandContext, { key, flags, pairs }: ZAddInput): Reply {
    const existing = ctx.db.get(key, 'zset');
    if (!existing && flags.xx) return flags.incr ? null : 0;
    const zset = existing ?? ctx.db.getOrCreate(key, 'zset', () => new ZSet());
    let added = 0;
    let changed = 0;
    let incrResult: number | null = null;
    let negativeZero = false;
    for (const [score, member] of pairs) {
      const current = zset.scores.get(member);
      if (current === undefined) {
        if (flags.xx) continue;
        zset.add(member, score);
        added++;
        incrResult = score;
        negativeZero ||= Object.is(score, -0);
        continue;
      }
      if (flags.nx) continue;
      const next = flags.incr ? current + score : score;
      if (Number.isNaN(next)) throw new AppError(ZSetsMessages.SCORE_NAN);
      if ((flags.gt && next <= current) || (flags.lt && next >= current)) continue;
      incrResult = next;
      if (next !== current) {
        zset.add(member, next);
        changed++;
      }
    }
    if (negativeZero) ZSetsWriteService.storeNegativeZero(ctx, zset);
    ctx.db.removeIfEmpty(key);
    if (!added && !changed) ctx.noop = true;
    if (flags.incr) return incrResult === null ? null : new RespDouble(incrResult);
    return flags.ch ? added + changed : added;
  }

  /** ZINCRBY: creates the key and the member when missing (a new member's score is the increment itself, -0 kept). */
  static incrBy(ctx: CommandContext, { key, increment, member }: ZIncrByInput): RespDouble {
    const zset = ctx.db.getOrCreate(key, 'zset', () => new ZSet());
    const current = zset.scores.get(member);
    const next = current === undefined ? increment : current + increment;
    if (Number.isNaN(next)) throw new AppError(ZSetsMessages.SCORE_NAN);
    zset.add(member, next);
    if (Object.is(next, -0)) ZSetsWriteService.storeNegativeZero(ctx, zset);
    return new RespDouble(next);
  }

  /** ZREM: the number of members removed; the key goes when it empties. */
  static rem(ctx: CommandContext, { key, members }: KeyMembersInput): number {
    const zset = ctx.db.get(key, 'zset');
    if (!zset) return 0;
    let removed = 0;
    for (const member of members) if (zset.remove(member)) removed++;
    ctx.db.removeIfEmpty(key);
    return removed;
  }
}
