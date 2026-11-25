import { AppError } from '@/libs/app-error';
import { normalizeRange } from '@/libs/number';
import { OK } from '@/libs/resp';
import type { Reply, Status } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { KeyInput, KeyRangeInput, LIndexInput, LInsertInput, LPosInput, LRemInput, LSetInput } from './lists.dto';
import ListsMessages from './lists.messages';
import ListStore from './lists.structure';
import type { ListValue } from './lists.types';

/**
 * Elements by position or value: LLEN, LRANGE, LINDEX, LSET, LREM, LTRIM, LINSERT, LPOS. Most of them run on the list
 * read before their arguments were parsed (Redis's precedence, see the commands layer). Negative indexes count from
 * the end.
 */
export default class ListsIndexService {
  // ──────────────────────────────────────────────
  // Read Step
  // ──────────────────────────────────────────────

  /** LSET's read step: the list must exist. */
  static readExisting(ctx: CommandContext, key: string): ListValue {
    const l = ListStore.read(ctx, key);
    if (!l) throw new AppError(ListsMessages.NO_SUCH_KEY);
    return l;
  }

  // ──────────────────────────────────────────────
  // Reads
  // ──────────────────────────────────────────────

  static lLen(ctx: CommandContext, { key }: KeyInput): number {
    return ListStore.read(ctx, key)?.length ?? 0;
  }

  static lRange(l: ListValue | undefined, { start, stop }: KeyRangeInput): string[] {
    if (!l) return [];
    const r = normalizeRange(start, stop, l.length);
    return r ? l.slice(r[0], r[1] + 1) : [];
  }

  static lIndex(l: ListValue | undefined, { index }: LIndexInput): string | null {
    if (!l) return null;
    const i = index < 0 ? l.length + index : index;
    return i >= 0 && i < l.length ? (l.at(i) ?? null) : null;
  }

  /** LPOS: the index of the rank-th match (nil), or with COUNT an array of up to `count` indexes (0 = all). */
  static lPos(l: ListValue | undefined, { element, rank, count, maxLen }: LPosInput): Reply {
    if (!l) return count === null ? null : [];
    const list = l;
    const matches: number[] = [];
    const want = count === null ? 1 : count === 0 ? Infinity : count;
    let skip = Math.abs(rank) - 1;
    const forward = rank > 0;
    for (let step = 0; step < list.length && (maxLen === 0 || step < maxLen) && matches.length < want; step++) {
      const i = forward ? step : list.length - 1 - step;
      if (list.at(i) !== element) continue;
      if (skip > 0) {
        skip--;
        continue;
      }
      matches.push(i);
    }
    return count === null ? (matches[0] ?? null) : matches;
  }

  // ──────────────────────────────────────────────
  // Writes
  // ──────────────────────────────────────────────

  static lSet(l: ListValue, { index, element }: LSetInput): Status {
    const i = index < 0 ? l.length + index : index;
    if (i < 0 || i >= l.length) throw new AppError(ListsMessages.INDEX_OUT_OF_RANGE);
    ListStore.setAt(l, i, element);
    return OK;
  }

  /** LREM: removes `count` matches from the head (> 0), from the tail (< 0) or all of them (0). */
  static lRem(ctx: CommandContext, l: ListValue, { key, count, element }: LRemInput): number {
    const limit = count === 0 ? Infinity : Math.abs(count);
    const drop: number[] = [];
    if (count >= 0) {
      for (let i = 0; i < l.length && drop.length < limit; i++) if (l.at(i) === element) drop.push(i);
    } else {
      for (let i = l.length - 1; i >= 0 && drop.length < limit; i--) if (l.at(i) === element) drop.push(i);
      drop.reverse();
    }
    ListStore.removeAt(l, drop);
    ctx.db.removeIfEmpty(key);
    return drop.length;
  }

  static lTrim(ctx: CommandContext, l: ListValue, { key, start, stop }: KeyRangeInput): Status {
    const r = normalizeRange(start, stop, l.length);
    if (r) {
      l.splice(r[1] + 1);
      l.splice(0, r[0]);
    } else l.splice(0);
    ctx.db.removeIfEmpty(key);
    return OK;
  }

  /** LINSERT: the new length, -1 when the pivot is not found, 0 when the key is missing. */
  static lInsert(ctx: CommandContext, { key, position, pivot, element }: LInsertInput): number {
    const l = ListStore.read(ctx, key);
    if (!l) return 0;
    const i = l.indexOf(pivot);
    if (i < 0) return -1;
    l.splice(position === 'before' ? i : i + 1, 0, element);
    return l.length;
  }
}
