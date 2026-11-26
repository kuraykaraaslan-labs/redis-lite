import { normalizeRange } from '@/libs/number';
import { RespDouble, RespPairs } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import DatabaseService from '@/modules/database/database.service';

import type { LexRangeInput, ScoreRangeInput, ZRangeInput, ZRangeStoreInput, ZRemRangeByRankInput } from './zsets.dto';
import { ZSet } from './zsets.structure';
import type { ParsedRange, RangeOptions, ZEntry } from './zsets.types';

/** Ranges by rank, score or member: the ZRANGE family, ZRANGESTORE and ZREMRANGEBYSCORE / RANK / LEX. */
export default class ZSetsRangeService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static withScores(entries: ZEntry[], scores: boolean): Reply {
    return scores ? new RespPairs(entries.map((e) => [e.member, new RespDouble(e.score)])) : entries.map((e) => e.member);
  }

  /** ZRANGE core shared by every range variant: the window, REV, then LIMIT. */
  private static collect(zset: ZSet | undefined, range: ParsedRange, options: RangeOptions): ZEntry[] {
    if (!zset) return [];
    let items: ZEntry[];
    if (range.by === 'rank') {
      const window = normalizeRange(range.start, range.stop, zset.size);
      if (!window) return [];
      items = options.rev
        ? zset.entries.slice(zset.size - 1 - window[1], zset.size - window[0]).reverse()
        : zset.entries.slice(window[0], window[1] + 1);
    } else {
      const [lo, hi] = range.by === 'score' ? zset.scoreWindow(range.min, range.max) : zset.lexWindow(range.min, range.max);
      items = zset.entries.slice(lo, hi);
      if (options.rev) items.reverse();
    }
    if (options.limit) {
      const [offset, count] = options.limit;
      if (offset < 0) return [];
      items = count < 0 ? items.slice(offset) : items.slice(offset, offset + count);
    }
    return items;
  }

  /** Removes `entries` from the sorted set at `key` (deleting the key when it empties); returns how many. */
  private static removeEntries(ctx: CommandContext, key: string, entries: ZEntry[]): number {
    const zset = ctx.db.get(key, 'zset');
    if (!zset) return 0;
    for (const entry of [...entries]) zset.remove(entry.member);
    ctx.db.removeIfEmpty(key);
    return entries.length;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** ZRANGE, ZREVRANGE, ZRANGEBYSCORE, ZREVRANGEBYSCORE, ZRANGEBYLEX, ZREVRANGEBYLEX. */
  static range(ctx: CommandContext, { key, range, options }: ZRangeInput): Reply {
    return ZSetsRangeService.withScores(ZSetsRangeService.collect(ctx.db.get(key, 'zset'), range, options), options.scores);
  }

  /** ZRANGESTORE on the source read before the bounds were parsed; an empty result deletes the destination. */
  static rangeStore(ctx: CommandContext, { destination, range, options }: ZRangeStoreInput, source: ZSet | undefined): number {
    const out = new ZSet();
    for (const entry of ZSetsRangeService.collect(source, range, options)) out.add(entry.member, entry.score);
    // a compact destination stores -0 as 0, as Redis does
    if (DatabaseService.isCompact({ type: 'zset', value: out }, ctx.server.config)) out.clearNegativeZeros();
    if (out.size) ctx.db.set(destination, { type: 'zset', value: out });
    else ctx.db.remove(destination);
    return out.size;
  }

  static remRangeByScore(ctx: CommandContext, { key, min, max }: ScoreRangeInput): number {
    const zset = ctx.db.get(key, 'zset');
    if (!zset) return 0;
    const [lo, hi] = zset.scoreWindow(min, max);
    return ZSetsRangeService.removeEntries(ctx, key, zset.entries.slice(lo, hi));
  }

  static remRangeByRank(ctx: CommandContext, { key, start, stop }: ZRemRangeByRankInput): number {
    const zset = ctx.db.get(key, 'zset');
    if (!zset) return 0;
    const window = normalizeRange(start, stop, zset.size);
    return window ? ZSetsRangeService.removeEntries(ctx, key, zset.entries.slice(window[0], window[1] + 1)) : 0;
  }

  static remRangeByLex(ctx: CommandContext, { key, min, max }: LexRangeInput): number {
    const zset = ctx.db.get(key, 'zset');
    if (!zset) return 0;
    const [lo, hi] = zset.lexWindow(min, max);
    return ZSetsRangeService.removeEntries(ctx, key, zset.entries.slice(lo, hi));
  }
}
