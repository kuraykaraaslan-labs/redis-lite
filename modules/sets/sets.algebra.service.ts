import { RespSet } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { CombineInput, CombineStoreInput, SInterCardInput } from './sets.dto';
import type { SetOperation } from './sets.enums';
import SetStore from './sets.structure';

/** Set algebra: SUNION, SINTER, SDIFF, their STORE forms, SINTERCARD. Missing keys count as empty sets. */
export default class SetsAlgebraService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static combine(ctx: CommandContext, keys: string[], operation: SetOperation): Set<string> {
    const sets = keys.map((k) => SetStore.read(ctx, k) ?? new Set<string>());
    if (operation === 'union') return new Set(sets.flatMap((s) => [...s]));
    const [first, ...rest] = sets;
    const out = new Set<string>();
    for (const m of first) {
      if (operation === 'inter' ? rest.every((s) => s.has(m)) : !rest.some((s) => s.has(m))) out.add(m);
    }
    return out;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  static combineSets(ctx: CommandContext, { keys, operation }: CombineInput): RespSet {
    return new RespSet([...SetsAlgebraService.combine(ctx, keys, operation)]);
  }

  /** The STORE forms: the result replaces the destination (an empty result deletes it); returns its size. */
  static combineStore(ctx: CommandContext, { destination, keys, operation }: CombineStoreInput): number {
    const members = SetsAlgebraService.combine(ctx, keys, operation);
    if (members.size) ctx.db.set(destination, { type: 'set', value: members });
    else ctx.db.remove(destination);
    return members.size;
  }

  /** SINTERCARD: the intersection's size, capped at LIMIT when it is not 0. */
  static sInterCard(ctx: CommandContext, { keys, limit }: SInterCardInput): number {
    const size = SetsAlgebraService.combine(ctx, keys, 'inter').size;
    return limit > 0 ? Math.min(limit, size) : size;
  }
}
