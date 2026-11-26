import { matchGlob } from '@/libs/glob';
import { formatFloat } from '@/libs/number';
import { NULL_ARRAY, RespDouble, RespPairs } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import DatabaseService from '@/modules/database/database.service';

import type {
  KeyInput,
  KeyMemberInput,
  KeyMembersInput,
  LexRangeInput,
  ScoreRangeInput,
  ZRandMemberInput,
  ZRankInput,
  ZScanInput,
} from './zsets.dto';
import type { ZSet } from './zsets.structure';
import type { ZEntry } from './zsets.types';

/** Reads that do not walk a range: ZCARD, ZSCORE, ZMSCORE, ZCOUNT, ZLEXCOUNT, ZRANK, ZSCAN, ZRANDMEMBER. */
export default class ZSetsQueryService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static withScores(entries: ZEntry[], scores: boolean): Reply {
    return scores ? new RespPairs(entries.map((e) => [e.member, new RespDouble(e.score)])) : entries.map((e) => e.member);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The sorted set at `key`: undefined when missing, WRONGTYPE for other types (the read step of read-first commands). */
  static get(ctx: CommandContext, { key }: KeyInput): ZSet | undefined {
    return ctx.db.get(key, 'zset');
  }

  static card(ctx: CommandContext, { key }: KeyInput): number {
    return ctx.db.get(key, 'zset')?.size ?? 0;
  }

  static score(ctx: CommandContext, { key, member }: KeyMemberInput): RespDouble | null {
    const score = ctx.db.get(key, 'zset')?.scores.get(member);
    return score === undefined ? null : new RespDouble(score);
  }

  static mScore(ctx: CommandContext, { key, members }: KeyMembersInput): Array<RespDouble | null> {
    const zset = ctx.db.get(key, 'zset');
    return members.map((member) => {
      const score = zset?.scores.get(member);
      return score === undefined ? null : new RespDouble(score);
    });
  }

  /** ZCOUNT on an existing sorted set (a missing key answers 0 without looking at the bounds). */
  static count(zset: ZSet, { min, max }: ScoreRangeInput): number {
    const [lo, hi] = zset.scoreWindow(min, max);
    return hi - lo;
  }

  /** ZLEXCOUNT on an existing sorted set (a missing key answers 0 without looking at the bounds). */
  static lexCount(zset: ZSet, { min, max }: LexRangeInput): number {
    const [lo, hi] = zset.lexWindow(min, max);
    return hi - lo;
  }

  /** ZRANK / ZREVRANK; a miss with WITHSCORE is a null array, without it a null bulk. */
  static rank(ctx: CommandContext, { key, member, withScore, reverse }: ZRankInput): Reply {
    const zset = ctx.db.get(key, 'zset');
    const rank = zset?.rank(member) ?? null;
    if (rank === null || !zset) return withScore ? NULL_ARRAY : null;
    const position = reverse ? zset.size - 1 - rank : rank;
    return withScore ? [position, new RespDouble(zset.scores.get(member) ?? 0)] : position;
  }

  /** ZSCAN on an existing sorted set; a compact (listpack) one is returned whole in one call, as Redis does. */
  static scan(ctx: CommandContext, zset: ZSet, { key, cursor, match, count, noScores }: ZScanInput): Reply {
    const value = ctx.db.peek(key);
    const compact = value !== undefined && DatabaseService.isCompact(value, ctx.server.config);
    const { next, page } = compact ? { next: 0, page: zset.entries.map((e) => e.member) } : DatabaseService.scanPage(zset.scores.keys(), cursor, count);
    const out: string[] = [];
    for (const member of page) {
      if (!matchGlob(match, member)) continue;
      out.push(member);
      if (!noScores) out.push(formatFloat(zset.scores.get(member) ?? 0));
    }
    return [String(next), out];
  }

  /** ZRANDMEMBER on the value read after the count: one member, `count` distinct members, or -count members with repeats. */
  static randMember(zset: ZSet | undefined, { count, withScores }: ZRandMemberInput): Reply {
    const entries = zset?.entries ?? [];
    if (count === null) return entries.length ? entries[Math.floor(Math.random() * entries.length)].member : null;
    const picked =
      count >= 0
        ? [...entries].sort(() => Math.random() - 0.5).slice(0, count)
        : entries.length
          ? Array.from({ length: -count }, () => entries[Math.floor(Math.random() * entries.length)])
          : [];
    return ZSetsQueryService.withScores(picked, withScores);
  }
}
