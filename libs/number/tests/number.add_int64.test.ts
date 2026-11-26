import { describe, expect, it } from 'vitest';

import { INT64_MAX, INT64_MIN, addInt64 } from '@/libs/number';

/** addInt64: the INCRBY / HINCRBY sum, fast path and bigint path alike. */
describe('addInt64', () => {
  it('adds small counters as safe numbers', () => {
    expect(addInt64(undefined, 1n)).toBe(1);
    expect(addInt64('41', 1n)).toBe(42);
    expect(addInt64('-5', -10n)).toBe(-15);
    // "-0" is not an integer to Redis (string2ll)
    expect(addInt64('-0', 0n)).toBe('not-integer');
  });

  it('falls back to bigints past the safe-integer range and keeps the int64 bounds', () => {
    expect(addInt64(String(Number.MAX_SAFE_INTEGER), 1n)).toBe(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(addInt64('999999999999999', 1n)).toBe(1000000000000000);
    expect(addInt64(undefined, INT64_MAX)).toBe(INT64_MAX);
    expect(addInt64(INT64_MAX.toString(), 1n)).toBe('overflow');
    expect(addInt64(INT64_MIN.toString(), -1n)).toBe('overflow');
    expect(addInt64('1', INT64_MAX)).toBe('overflow');
  });

  it('rejects values that are not strict int64 text', () => {
    for (const bad of ['', 'a', '01', '+1', ' 1', '1.0', '9223372036854775808', '1e3']) expect(addInt64(bad, 1n)).toBe('not-integer');
  });
});
