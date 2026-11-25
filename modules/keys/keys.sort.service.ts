import { AppError } from '@/libs/app-error';
import { toFloat } from '@/libs/number';
import type { Reply } from '@/libs/resp';
import { RespMessages } from '@/libs/resp/messages';

import type { CommandContext } from '@/modules/command/command.types';
import { ListDeque } from '@/modules/lists/lists.deque.structure';

import type { SortInput } from './keys.dto';
import KeysMessages from './keys.messages';

/** SORT / SORT_RO: sorts the elements of a list, set or sorted set, optionally by external weights. */
export default class KeysSortService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** SORT's pattern lookup: `#` = the element itself, `key*` = string value, `key*->field` = hash field. */
  private static lookupPattern(ctx: CommandContext, pattern: string, element: string): string | null {
    if (pattern === '#') return element;
    const star = pattern.indexOf('*');
    if (star < 0) return null;
    const arrow = pattern.indexOf('->', star);
    const keyPattern = arrow > 0 ? pattern.slice(0, arrow) : pattern;
    const key = keyPattern.replace('*', element);
    const v = ctx.db.lookup(key);
    if (!v) return null;
    if (arrow > 0) return v.type === 'hash' ? (v.value.get(pattern.slice(arrow + 2)) ?? null) : null;
    return v.type === 'string' ? v.value : null;
  }

  /** The elements of the sorted key, in storage order; WRONGTYPE for strings, hashes and streams. */
  private static elementsOf(ctx: CommandContext, key: string): { elements: string[]; isZset: boolean } {
    const v = ctx.db.lookup(key);
    if (!v) return { elements: [], isZset: false };
    if (v.type === 'list') return { elements: [...v.value], isZset: false };
    if (v.type === 'set') return { elements: [...v.value], isZset: false };
    if (v.type === 'zset') return { elements: v.value.entries.map((e) => e.member), isZset: true };
    throw new AppError(RespMessages.WRONGTYPE);
  }

  /** Sorts `elements` in place by their weight (the element itself, or the BY pattern), ties by element. */
  private static sortElements(ctx: CommandContext, elements: string[], { by, alpha, desc }: SortInput): void {
    const weights = new Map<string, number | string | null>();
    for (const e of elements) {
      const raw = by === null ? e : KeysSortService.lookupPattern(ctx, by, e);
      if (alpha) weights.set(e, raw);
      else if (raw === null) weights.set(e, 0);
      else {
        const n = toFloat(raw);
        if (n === null) throw new AppError(KeysMessages.SORT_NOT_DOUBLE);
        weights.set(e, n);
      }
    }
    elements.sort((a, b) => {
      const wa = weights.get(a) ?? null;
      const wb = weights.get(b) ?? null;
      let cmp: number;
      if (alpha) {
        const sa = String(wa ?? '');
        const sb = String(wb ?? '');
        cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
      } else cmp = (wa as number) - (wb as number);
      if (cmp === 0) cmp = a < b ? -1 : a > b ? 1 : 0;
      return desc ? -cmp : cmp;
    });
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  static sort(ctx: CommandContext, input: SortInput): Reply {
    const { key, by, limit, gets, desc, store } = input;
    const { isZset, ...found } = KeysSortService.elementsOf(ctx, key);
    let elements = found.elements;
    const noSort = by !== null && !by.includes('*');
    // BY nosort on a sorted set keeps the zset order; DESC walks it backwards, as Redis does.
    if (noSort && isZset && desc) elements.reverse();
    if (!noSort) KeysSortService.sortElements(ctx, elements, input);
    if (limit) {
      const [offset, count] = limit;
      const start = Math.max(0, offset);
      elements = count < 0 ? elements.slice(start) : elements.slice(start, start + count);
    }
    const out: Array<string | null> = gets.length
      ? elements.flatMap((e) => gets.map((g) => KeysSortService.lookupPattern(ctx, g, e)))
      : elements;
    if (store !== null) {
      const values = out.map((x) => x ?? '');
      if (values.length) ctx.db.set(store, { type: 'list', value: ListDeque.from(values) });
      else ctx.db.remove(store);
      ctx.server.touch(ctx.client.dbIndex, store);
      return values.length;
    }
    return out;
  }
}
