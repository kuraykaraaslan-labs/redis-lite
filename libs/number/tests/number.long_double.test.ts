import { describe, expect, it } from 'vitest';

import { addLongDouble, formatLongDouble, parseLongDouble } from '@/libs/number/long-double';
import type { LongDouble } from '@/libs/number/long-double';

/** INCRBYFLOAT's arithmetic: stored + increment, both read as long doubles, printed as Redis prints them. */
function incr(stored: string, increment: string): string | null {
  const a = parseLongDouble(stored);
  const b = parseLongDouble(increment);
  if (!a || !b) return null;
  const sum = addLongDouble(a, b) as LongDouble;
  return sum && !sum.inf ? formatLongDouble(sum) : 'inf';
}

/** Expected values were observed on a real Redis 7.0 server. */
describe('long double', () => {
  it('adds in 64-bit significand precision and prints %.17Lf trimmed', () => {
    expect(incr('0.1', '0.2')).toBe('0.3');
    expect(incr('10.6', '5.0e3')).toBe('5010.60000000000000009');
    expect(incr('100000', '1.5E-3')).toBe('100000.00150000000000006');
    expect(incr('0', '0.000003814697265625')).toBe('0.00000381469726562');
    expect(incr('0', '0.000011444091796875')).toBe('0.00001144409179688');
    expect(incr('0', '0.000000000000000015')).toBe('0.00000000000000002');
    expect(incr('0', '-0.000000000000000001')).toBe('0');
    expect(incr('-0', '-0')).toBe('0');
    expect(incr('1e400', '0')).toMatch(/^10000000000000000000281880683947586514586453433629052038625910693539685534/);
  });

  it('reads the strtold grammar with Redis checks', () => {
    expect(incr('0x10', '1')).toBe('17');
    expect(incr('0', '0x1.8p1')).toBe('3');
    expect(incr('0', '0X1P-2')).toBe('0.25');
    expect(incr('0', '-.5e1')).toBe('-5');
    expect(incr('0', '+5')).toBe('5');
    expect(incr('0', '5.')).toBe('5');
    for (const bad of ['', ' 1', '1 ', '0x', '.', '-', '1e', '1e+', 'nan', 'infinit', '0b1', '1e5000', '1e-4951', '0x1p-16446', '1_0', '1\x002']) {
      expect(parseLongDouble(bad)).toBeNull();
    }
    expect(parseLongDouble('2e-4951')).not.toBeNull();
    expect(parseLongDouble('0x1p-16445')).not.toBeNull();
    expect(parseLongDouble(`0.${'0'.repeat(5117)}`)).not.toBeNull();
    expect(parseLongDouble(`0.${'0'.repeat(5118)}`)).toBeNull();
  });

  it('overflows to infinity only past the long double range', () => {
    expect(incr('1.1e4932', '1.1e4932')).toBe('inf');
    expect(incr('1.7e308', '1.7e308')).toMatch(/^340000000000000000006273556050395193590540427779388267466087171526404912102411641988123739177800600673957047683771263425322806997836001586961/);
    expect(incr('inf', '1')).toBe('inf');
    expect(addLongDouble(parseLongDouble('inf')!, parseLongDouble('-inf')!)).toBeNull();
  });
});
