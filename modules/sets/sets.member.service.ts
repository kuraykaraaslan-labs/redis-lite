import { RespSet } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { KeyInput, KeyMemberInput, KeyMembersInput, SMoveInput } from './sets.dto';
import SetStore from './sets.structure';

/** Members of one set: SADD, SREM, SMEMBERS, SISMEMBER, SMISMEMBER, SCARD, SMOVE. */
export default class SetsMemberService {
  /** SADD: the number of members added. */
  static sAdd(ctx: CommandContext, { key, members }: KeyMembersInput): number {
    const s = ctx.db.getOrCreate(key, 'set', () => new Set());
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) {
        s.add(m);
        added++;
      }
    }
    return added;
  }

  /** SREM: the number of members removed; the key goes with its last member. */
  static sRem(ctx: CommandContext, { key, members }: KeyMembersInput): number {
    const s = SetStore.read(ctx, key);
    if (!s) return 0;
    let n = 0;
    for (const m of members) if (s.delete(m)) n++;
    ctx.db.removeIfEmpty(key);
    return n;
  }

  static sMembers(ctx: CommandContext, { key }: KeyInput): RespSet {
    const s = SetStore.read(ctx, key);
    return new RespSet(s ? SetStore.members(ctx, key, s) : []);
  }

  static sIsMember(ctx: CommandContext, { key, member }: KeyMemberInput): number {
    return SetStore.read(ctx, key)?.has(member) ? 1 : 0;
  }

  static sMIsMember(ctx: CommandContext, { key, members }: KeyMembersInput): number[] {
    const s = SetStore.read(ctx, key);
    return members.map((m) => (s?.has(m) ? 1 : 0));
  }

  static sCard(ctx: CommandContext, { key }: KeyInput): number {
    return SetStore.read(ctx, key)?.size ?? 0;
  }

  /** SMOVE: 1 when moved. Both keys are type-checked before anything moves. */
  static sMove(ctx: CommandContext, { source, destination, member }: SMoveInput): number {
    const s = SetStore.read(ctx, source);
    SetStore.read(ctx, destination); // WRONGTYPE check
    if (!s || !s.has(member)) return 0;
    s.delete(member);
    ctx.db.removeIfEmpty(source);
    ctx.db.getOrCreate(destination, 'set', () => new Set()).add(member);
    return 1;
  }
}
