import { AppError } from '@/libs/app-error';
import { normalizeRange } from '@/libs/number';
import { OK } from '@/libs/resp';
import type { Reply, Status } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { KeyInput, KeyRangeInput, LIndexInput, LInsertInput, LPosInput, LRemInput, LSetInput } from './lists.dto';
import ListsMessages from './lists.messages';
import ListStore from './lists.structure';

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
  static readExisting(ctx: CommandContext, key: string): string[] {
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

  static lRange(l: string[] | undefined, { start, stop }: KeyRangeInput): string[] {
    const list = l ?? [];
    const r = normalizeRange(start, stop, list.length);
    return r ? list.slice(r[0], r[1] + 1) : [];
  }

  static lIndex(l: string[] | undefined, { index }: LIndexInput): string | null {
    const list = l ?? [];
    return list[index < 0 ? list.length + index : index] ?? null;
  }

  /** LPOS: the index of the rank-th match (nil), or with COUNT an array of up to `count` indexes (0 = all). */
  static lPos(l: string[] | undefined, { element, rank, count, maxLen }: LPosInput): Reply {
    const list = l ?? [];
    const matches: number[] = [];
    const want = count === null ? 1 : count === 0 ? Infinity : count;
    let skip = Math.abs(rank) - 1;
    const forward = rank > 0;
    for (let step = 0; step < list.length && (maxLen === 0 || step < maxLen) && matches.length < want; step++) {
      const i = forward ? step : list.length - 1 - step;
      if (list[i] !== element) continue;
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

  static lSet(l: string[], { index, element }: LSetInput): Status {
    const i = index < 0 ? l.length + index : index;
    if (i < 0 || i >= l.length) throw new AppError(ListsMessages.INDEX_OUT_OF_RANGE);
    l[i] = element;
    return OK;
  }

  /** LREM: removes `count` matches from the head (> 0), from the tail (< 0) or all of them (0). */
  static lRem(ctx: CommandContext, l: string[], { key, count, element }: LRemInput): number {
    let removed = 0;
    const limit = count === 0 ? Infinity : Math.abs(count);
    if (count >= 0) {
      for (let i = 0; i < l.length && removed < limit; ) {
        if (l[i] === element) {
          l.splice(i, 1);
          removed++;
        } else i++;
      }
    } else {
      for (let i = l.length - 1; i >= 0 && removed < limit; i--) {
        if (l[i] === element) {
          l.splice(i, 1);
          removed++;
        }
      }
    }
    ctx.db.removeIfEmpty(key);
    return removed;
  }

  static lTrim(ctx: CommandContext, l: string[], { key, start, stop }: KeyRangeInput): Status {
    const r = normalizeRange(start, stop, l.length);
    const kept = r ? l.slice(r[0], r[1] + 1) : [];
    l.splice(0, l.length, ...kept);
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
