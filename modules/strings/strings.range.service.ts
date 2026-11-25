import { AppError } from '@/libs/app-error';

import type { CommandContext } from '@/modules/command/command.types';

import type { KeyInput, KeyValueInput, RangeInput, SetRangeInput } from './strings.dto';
import StringsMessages from './strings.messages';

/** Parts of a string: APPEND, STRLEN, GETRANGE, SUBSTR, SETRANGE. Values are binary strings (one char per byte). */
export default class StringsRangeService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** proto-max-bulk-len: the largest string a command may grow a value to. */
  private static checkSize(ctx: CommandContext, size: number): void {
    if (size > ctx.server.config.num('proto-max-bulk-len')) throw new AppError(StringsMessages.STRING_TOO_LONG);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** APPEND: creates the key when missing; returns the new length. */
  static append(ctx: CommandContext, { key, value }: KeyValueInput): number {
    const current = ctx.db.get(key, 'string') ?? '';
    StringsRangeService.checkSize(ctx, current.length + value.length);
    const next = current + value;
    ctx.db.set(key, { type: 'string', value: next, raw: true }, true);
    return next.length;
  }

  static strLen(ctx: CommandContext, { key }: KeyInput): number {
    return (ctx.db.get(key, 'string') ?? '').length;
  }

  /** GETRANGE on the value read before the indexes were parsed. Negative indexes count from the end. */
  static getRange(value: string | null, { start, end }: RangeInput): string {
    const v = value ?? '';
    if (start < 0 && end < 0 && start > end) return '';
    const from = start < 0 ? Math.max(0, v.length + start) : start;
    let to = end < 0 ? Math.max(0, v.length + end) : end;
    if (to >= v.length) to = v.length - 1;
    if (from > to || !v.length) return '';
    return v.slice(from, to + 1);
  }

  /** SUBSTR, the pre-2.0 GETRANGE: same clamping but without GETRANGE's "both negative and reversed" shortcut. */
  static substr(value: string | null, { start, end }: RangeInput): string {
    const v = value ?? '';
    const from = start < 0 ? Math.max(0, v.length + start) : start;
    let to = end < 0 ? Math.max(0, v.length + end) : end;
    if (to >= v.length) to = v.length - 1;
    return from > to || !v.length ? '' : v.slice(from, to + 1);
  }

  /** SETRANGE: overwrites from `offset`, zero-padding a shorter value; an empty value only reports the length. */
  static setRange(ctx: CommandContext, { key, offset, value }: SetRangeInput): number {
    let current = ctx.db.get(key, 'string') ?? '';
    if (!value.length) return current.length;
    StringsRangeService.checkSize(ctx, offset + value.length);
    if (current.length < offset) current = current.padEnd(offset, '\0');
    const next = current.slice(0, offset) + value + current.slice(offset + value.length);
    ctx.db.set(key, { type: 'string', value: next, raw: true }, true);
    return next.length;
  }
}
