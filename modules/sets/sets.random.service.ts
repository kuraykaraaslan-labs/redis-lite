import { RespSet } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { SPopInput, SRandMemberInput } from './sets.dto';

/** Random members: SPOP, SRANDMEMBER. Both run on the set read before their arguments were parsed. */
export default class SetsRandomService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Fisher–Yates, in place. */
  private static shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** SPOP: one member (no count) or a set of up to `count` distinct members, removed from the set. */
  static sPop(ctx: CommandContext, { key, count }: SPopInput, s: Set<string> | undefined): Reply {
    const hasCount = count !== null;
    if (!s) return hasCount ? new RespSet([]) : null;
    const picked = SetsRandomService.shuffle([...s]).slice(0, count ?? 1);
    for (const m of picked) s.delete(m);
    ctx.db.removeIfEmpty(key);
    return hasCount ? new RespSet(picked) : (picked[0] ?? null);
  }

  /** SRANDMEMBER: one member, `count` distinct members, or -`count` members possibly repeated. */
  static sRandMember({ count }: SRandMemberInput, s: Set<string> | undefined): Reply {
    const members = [...(s ?? [])];
    if (count === null) return members.length ? members[Math.floor(Math.random() * members.length)] : null;
    if (count >= 0) return SetsRandomService.shuffle(members).slice(0, count);
    return members.length ? Array.from({ length: -count }, () => members[Math.floor(Math.random() * members.length)]) : [];
  }
}
