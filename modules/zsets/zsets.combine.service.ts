import { AppError } from '@/libs/app-error';
import { RespDouble, RespPairs } from '@/libs/resp';
import type { Reply } from '@/libs/resp';
import { RespMessages } from '@/libs/resp/messages';

import type { CommandContext } from '@/modules/command/command.types';

import type { CombineInput, CombineStoreInput } from './zsets.dto';
import { ZSet } from './zsets.structure';
import type { ScoreSource } from './zsets.types';

/** Set algebra over sorted sets (and plain sets, score 1): ZUNION, ZINTER, ZDIFF, their STORE forms and ZINTERCARD. */
export default class ZSetsCombineService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Applies the operation with WEIGHTS and AGGREGATE; a NaN score (inf * 0, inf - inf) becomes 0, as in Redis. */
  private static combine(sources: ScoreSource[], { op, weights, aggregate }: CombineInput): ZSet {
    const acc = new Map<string, number>();
    if (op === 'diff') {
      for (const [member, score] of sources[0]) {
        if (!sources.slice(1).some((src) => src.has(member))) acc.set(member, score);
      }
    } else {
      sources.forEach((src, j) => {
        for (const [member, score] of src) {
          const weighted = score * weights[j];
          const current = acc.get(member);
          if (current === undefined) acc.set(member, weighted);
          else if (aggregate === 'sum') acc.set(member, current + weighted);
          else acc.set(member, aggregate === 'min' ? Math.min(current, weighted) : Math.max(current, weighted));
        }
      });
      if (op === 'inter') {
        for (const member of [...acc.keys()]) if (!sources.every((s) => s.has(member))) acc.delete(member);
      }
    }
    const out = new ZSet();
    for (const [member, score] of acc) out.add(member, Number.isNaN(score) ? 0 : score);
    return out;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The input keys' member → score maps, read before the options are parsed (WRONGTYPE beats a bad option). */
  static sources(ctx: CommandContext, keys: string[]): ScoreSource[] {
    return keys.map((key) => {
      const value = ctx.db.lookup(key);
      if (!value) return new Map<string, number>();
      if (value.type === 'zset') return value.value.scores;
      if (value.type === 'set') return new Map([...value.value].map((member) => [member, 1]));
      throw new AppError(RespMessages.WRONGTYPE);
    });
  }

  /** ZUNION / ZINTER / ZDIFF. */
  static combined(input: CombineInput, sources: ScoreSource[]): Reply {
    const out = ZSetsCombineService.combine(sources, input);
    if (!input.withScores) return out.entries.map((e) => e.member);
    return new RespPairs(out.entries.map((e) => [e.member, new RespDouble(e.score)]));
  }

  /** ZUNIONSTORE / ZINTERSTORE / ZDIFFSTORE: an empty result deletes the destination. */
  static store(ctx: CommandContext, input: CombineStoreInput, sources: ScoreSource[]): number {
    const out = ZSetsCombineService.combine(sources, input);
    if (out.size) ctx.db.set(input.destination, { type: 'zset', value: out });
    else ctx.db.remove(input.destination);
    return out.size;
  }

  /** ZINTERCARD: the intersection's size, capped by LIMIT (0 = no cap). */
  static interCard(input: CombineInput, sources: ScoreSource[]): number {
    const size = ZSetsCombineService.combine(sources, input).size;
    return input.limit > 0 ? Math.min(input.limit, size) : size;
  }
}
