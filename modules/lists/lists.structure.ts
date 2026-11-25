import { AppError } from '@/libs/app-error';
import type { Reply } from '@/libs/resp';
import { RespMessages } from '@/libs/resp/messages';

import type { CommandContext } from '@/modules/command/command.types';

import { ListDeque } from './lists.deque.structure';
import type { ListSide } from './lists.enums';
import type { ListValue } from './lists.types';

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
  private static take(list: ListValue, left: boolean, count: number): string[] {
    if (count === 1 && list.length) return [(left ? list.shift() : list.pop()) as string];
    return left ? list.splice(0, count) : list.splice(Math.max(0, list.length - count), count).reverse();
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** A new, empty list value. */
  static create(): ListValue {
    return new ListDeque();
  }

  /** The list at `key`; undefined when missing; WRONGTYPE otherwise. */
  static read(ctx: CommandContext, key: string): ListValue | undefined {
    return ctx.db.get(key, 'list');
  }

  /** Overwrites the element at `index` (0 ≤ index < length) in place. */
  static setAt(list: ListValue, index: number, value: string): void {
    list.splice(index, 1, value);
  }

  /**
   * Removes the elements at the ascending positions `drop` in one pass: the survivors after the first dropped position
   * move down in place, then the tail is cut (O(length), however many positions are dropped).
   */
  static removeAt(list: ListValue, drop: readonly number[]): void {
    if (!drop.length) return;
    if (drop.length === 1) {
      list.splice(drop[0], 1);
      return;
    }
    let write = drop[0];
    let next = 0;
    for (let read = drop[0]; read < list.length; read++) {
      if (next < drop.length && drop[next] === read) {
        next++;
        continue;
      }
      ListStore.setAt(list, write++, list.at(read) as string);
    }
    list.splice(write);
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
    const target = ctx.db.getOrCreate(destination, 'list', ListStore.create);
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
