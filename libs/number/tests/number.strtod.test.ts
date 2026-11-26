import { describe, expect, it } from 'vitest';

import { parseSortWeight } from '@/libs/number/strtod';

/** SORT weights; accepted / refused texts were observed on a real Redis 7.0 server. */
describe('parseSortWeight', () => {
  it('accepts what strtod reads to the end, leading white space included', () => {
    expect(parseSortWeight(' 2')).toBe(2);
    expect(parseSortWeight('\t3')).toBe(3);
    expect(parseSortWeight('0x10')).toBe(16);
    expect(parseSortWeight('0X.8P1')).toBe(1);
    expect(parseSortWeight('+.5')).toBe(0.5);
    expect(parseSortWeight('1.')).toBe(1);
    expect(parseSortWeight('-InFiNiTy')).toBe(-Infinity);
    expect(parseSortWeight('')).toBe(0);
    expect(parseSortWeight('1\x002')).toBe(1);
    expect(parseSortWeight('0x1p-1074')).toBe(5e-324);
    expect(parseSortWeight('0e-999999')).toBe(0);
    // just under 2^-1022 but rounding up to it: not tiny, so no ERANGE
    expect(parseSortWeight('2.2250738585072013e-308')).toBe(2.2250738585072014e-308);
  });

  it('refuses trailing text, NaN and ERANGE (overflow, inexact underflow)', () => {
    for (const bad of ['2 ', ' ', '1e', '0x', '.', '-', 'nan', '-nan', 'nan(12)', '1e400', '1e-400', '1e-310', '4.9e-324', '0x1.fffffffffffffp-1023']) {
      expect(parseSortWeight(bad)).toBeNull();
    }
  });
});
