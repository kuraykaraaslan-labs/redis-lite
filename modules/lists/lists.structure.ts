import { AppError } from '@/libs/app-error';
import { RespError } from '@/libs/resp';
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

  /** A new, empty list value with the server's list-max-listpack-size and list-compress-depth (each list keeps its own). */
  static create(ctx: CommandContext): ListValue {
    const c = ctx.server.config;
    return new ListDeque(undefined, c.num('list-max-listpack-size'), c.num('list-compress-depth'));
  }

  /** A factory of new lists for `ctx.db.getOrCreate`. */
  static creator(ctx: CommandContext): () => ListValue {
    return () => ListStore.create(ctx);
  }

  /** The list at `key`; undefined when missing; WRONGTYPE otherwise. */
  static read(ctx: CommandContext, key: string): ListValue | undefined {
    return ctx.db.get(key, 'list');
  }

  /**
   * The list at `key` for a blocked client being served: a key of another type counts as not ready (undefined), never
   * as WRONGTYPE. Redis leaves such a client blocked until the key holds a list again (or another of its keys does).
   */
  static readServing(ctx: CommandContext, key: string): ListValue | undefined {
    const value = ctx.db.lookup(key);
    return value?.type === 'list' ? value.value : undefined;
  }

  /**
   * The attempt of a blocking command: `attempt(false)` runs as the command itself (errors are thrown as usual); every
   * later call serves the blocked client (`attempt(true)`), where an error becomes the client's reply instead of being
   * thrown out of the server's wake-up loop.
   */
  static blockingAttempt(attempt: (serving: boolean) => Reply | undefined): () => Reply | undefined {
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

  /** Overwrites the element at `index` (0 ≤ index < length) in place. */
  static setAt(list: ListValue, index: number, value: string): void {
    list.set(index, value);
  }

  /** Removes the elements at the ascending positions `drop` in one pass (O(length), however many are dropped). */
  static removeAt(list: ListValue, drop: readonly number[]): void {
    list.removeIndices(drop);
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
    const target = ctx.db.getOrCreate(destination, 'list', ListStore.creator(ctx));
    if (to === 'left') target.unshift(value);
    else target.push(value);
    ctx.server.touch(ctx.client.dbIndex, source);
    ctx.server.touch(ctx.client.dbIndex, destination);
    return value;
  }

  /**
   * BLMOVE / BRPOPLPUSH serving a blocked client: a source of another type is not ready; a destination of another type
   * answers WRONGTYPE (the client is unblocked with the error and the source keeps its element), as in Redis.
   */
  static serveMove(ctx: CommandContext, source: string, destination: string, from: ListSide, to: ListSide): Reply | undefined {
    const s = ListStore.readServing(ctx, source);
    if (!s || !s.length) return undefined;
    const d = ctx.db.lookup(destination);
    if (d && d.type !== 'list') return new RespError(RespMessages.WRONGTYPE);
    return ListStore.move(ctx, source, destination, from, to);
  }

  /** BLPOP / BRPOP attempt: one element from the first non-empty key, as `[key, element]` (`serving`: see readServing). */
  static popFirst(ctx: CommandContext, keys: string[], left: boolean, serving = false): Reply | undefined {
    for (const key of keys) {
      const l = serving ? ListStore.readServing(ctx, key) : ListStore.read(ctx, key);
      if (!l || !l.length) continue;
      const value = (left ? l.shift() : l.pop()) as string;
      ctx.db.removeIfEmpty(key);
      ctx.server.touch(ctx.client.dbIndex, key);
      return [key, value];
    }
    return undefined;
  }

  /** LMPOP / BLMPOP attempt: up to `count` elements from the first non-empty key, as `[key, elements]`. */
  static mPop(ctx: CommandContext, keys: string[], left: boolean, count: number, serving = false): Reply | undefined {
    for (const key of keys) {
      const l = serving ? ListStore.readServing(ctx, key) : ListStore.read(ctx, key);
      if (!l || !l.length) continue;
      const out = ListStore.take(l, left, count);
      ctx.db.removeIfEmpty(key);
      ctx.server.touch(ctx.client.dbIndex, key);
      return [key, out];
    }
    return undefined;
  }
}
