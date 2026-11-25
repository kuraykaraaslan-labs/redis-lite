import { AppError } from '@/libs/app-error';
import { RespMap } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { LcsInput } from './strings.dto';
import StringsMessages from './strings.messages';
import type { LcsMatchRange } from './strings.types';

/** LCS: longest common subsequence of two string values, as a string, its length, or the matching ranges (IDX). */
export default class StringsLcsService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Dynamic-programming table: table[i][j] = LCS length of a[0, i) and b[0, j). */
  private static lengths(a: string, b: string): number[][] {
    const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
    return table;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Both values, read before the options are parsed: a missing key is an empty string, another type an error. */
  static readValues(ctx: CommandContext, keyA: string, keyB: string): [string, string] {
    const read = (key: string): string => {
      const entry = ctx.db.lookup(key);
      if (entry && entry.type !== 'string') throw new AppError(StringsMessages.LCS_NOT_STRINGS);
      return entry?.type === 'string' ? entry.value : '';
    };
    return [read(keyA), read(keyB)];
  }

  /** Walks the table back from the end, collecting the common string and the contiguous match ranges, as Redis does. */
  static lcs([a, b]: [string, string], { len, idx, withMatchLen, minMatchLen }: LcsInput): Reply {
    const table = StringsLcsService.lengths(a, b);
    const total = table[a.length][b.length];
    if (len) return total;
    const chars: string[] = [];
    const matches: Reply[] = [];
    let range: LcsMatchRange | null = null;
    const flush = (): void => {
      if (!range) return;
      const length = range.aEnd - range.aStart + 1;
      if (length >= minMatchLen) {
        const match: Reply[] = [[range.aStart, range.aEnd], [range.bStart, range.bEnd]];
        if (withMatchLen) match.push(length);
        matches.push(match);
      }
      range = null;
    };
    let i = a.length;
    let j = b.length;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        chars.push(a[i - 1]);
        if (range && range.aStart === i && range.bStart === j) {
          range.aStart = i - 1;
          range.bStart = j - 1;
        } else {
          flush();
          range = { aStart: i - 1, aEnd: i - 1, bStart: j - 1, bEnd: j - 1 };
        }
        i--;
        j--;
      } else if (table[i - 1][j] > table[i][j - 1]) i--;
      else j--;
    }
    flush();
    if (idx) return RespMap.from(['matches', matches, 'len', total]);
    return chars.reverse().join('');
  }
}
