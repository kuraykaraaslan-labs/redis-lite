import { AppError } from '@/libs/app-error';
import type { Reply } from '@/libs/resp';
import { RespMessages } from '@/libs/resp/messages';

import type { CommandContext } from '@/modules/command/command.types';

import type { ListSide } from './lists.enums';

/**
 * The list lookups and element moves shared by the list sub-services (which never import each other): the blocking
 * commands retry the same moves as their non-blocking forms. Every move touches the keys it modifies itself, because a
 * blocked client's retry runs outside the normal dispatch path.
 */
export default class ListStore {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Removes up to `count` elements from one end (right-end pops come back in pop order). */
  private static take(list: string[], left: boolean, count: number): string[] {
    return left ? list.splice(0, count) : list.splice(Math.max(0, list.length - count), count).reverse();
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The list at `key`; undefined when missing; WRONGTYPE otherwise. */
  static read(ctx: CommandContext, key: string): string[] | undefined {
    return ctx.db.get(key, 'list');
  }

  /** Pops up to `count` elements from the list at `key` (undefined when missing); the key goes with its last element. */
  static pop(ctx: CommandContext, key: string, left: boolean, count: number): string[] | undefined {
    const l = ListStore.read(ctx, key);
    if (!l) return undefined;
    const out = ListStore.take(l, left, count);
    ctx.db.removeIfEmpty(key);
    return out;
  }

  /** LMOVE core: the moved element, or undefined when the source is empty. Touches both keys. */
  static move(ctx: CommandContext, source: string, destination: string, from: ListSide, to: ListSide): string | undefined {
    const s = ListStore.read(ctx, source);
    if (!s || !s.length) return undefined;
    const d = ListStore.read(ctx, destination); // WRONGTYPE check before popping
    if (!d && ctx.db.lookup(destination)) throw new AppError(RespMessages.WRONGTYPE);
    const value = (from === 'left' ? s.shift() : s.pop()) as string;
    ctx.db.removeIfEmpty(source);
    const target = ctx.db.getOrCreate(destination, 'list', () => []);
    if (to === 'left') target.unshift(value);
    else target.push(value);
    ctx.server.touch(ctx.client.dbIndex, source);
    ctx.server.touch(ctx.client.dbIndex, destination);
    return value;
  }

  /** BLPOP / BRPOP attempt: one element from the first non-empty key, as `[key, element]`. */
  static popFirst(ctx: CommandContext, keys: string[], left: boolean): Reply | undefined {
    for (const key of keys) {
      const l = ListStore.read(ctx, key);
      if (!l || !l.length) continue;
      const value = (left ? l.shift() : l.pop()) as string;
      ctx.db.removeIfEmpty(key);
      ctx.server.touch(ctx.client.dbIndex, key);
      return [key, value];
    }
    return undefined;
  }

  /** LMPOP / BLMPOP attempt: up to `count` elements from the first non-empty key, as `[key, elements]`. */
  static mPop(ctx: CommandContext, keys: string[], left: boolean, count: number): Reply | undefined {
    for (const key of keys) {
      const l = ListStore.read(ctx, key);
      if (!l || !l.length) continue;
      const out = ListStore.take(l, left, count);
      ctx.db.removeIfEmpty(key);
      ctx.server.touch(ctx.client.dbIndex, key);
      return [key, out];
    }
    return undefined;
  }
}
