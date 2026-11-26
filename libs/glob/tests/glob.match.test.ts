import { describe, expect, it } from 'vitest';

import { matchGlob } from '@/libs/glob';

/** Redis glob edge cases; expected values were observed on a real Redis 7.0 server (KEYS). */
describe('matchGlob', () => {
  it('swaps reversed ranges and reads a dash before the end as a range bound', () => {
    expect(matchGlob('h[b-a]llo', 'hallo')).toBe(true);
    expect(matchGlob('h[b-a]llo', 'hbllo')).toBe(true);
    expect(matchGlob('a[b-]', 'a^')).toBe(true);
    expect(matchGlob('a[-b]', 'a-')).toBe(true);
  });

  it('treats an unterminated set as running to the end, and [] as an empty set', () => {
    expect(matchGlob('a[', 'a[')).toBe(false);
    expect(matchGlob('a[bc', 'ac')).toBe(true);
    expect(matchGlob('a[]', 'a]')).toBe(false);
    expect(matchGlob('a[^]', 'ab')).toBe(true);
    expect(matchGlob('a[^', 'ab')).toBe(true);
  });

  it('handles escapes inside and outside sets', () => {
    expect(matchGlob('a\\*', 'a*')).toBe(true);
    expect(matchGlob('a\\*', 'ab')).toBe(false);
    expect(matchGlob('a\\', 'a\\')).toBe(true);
    expect(matchGlob('a[\\]', 'a]')).toBe(true);
    expect(matchGlob('a[\\', 'a\\')).toBe(true);
  });

  it('matches stars without exponential backtracking', () => {
    expect(matchGlob('**a', 'a')).toBe(true);
    expect(matchGlob('*?*?*', 'a')).toBe(false);
    expect(matchGlob(`${'*a'.repeat(30)}b`, 'a'.repeat(60))).toBe(false);
  });
});
