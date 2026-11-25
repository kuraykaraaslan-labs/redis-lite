import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { BlockTimeoutSchema, firstIssue } from '@/libs/schemas';

/** Unit tests of the blocking-timeout primitive (no server). */

function parse(schema: z.ZodType, value: string): unknown {
  const result = schema.safeParse(value);
  return result.success ? result.data : firstIssue(result.error);
}

describe('BlockTimeoutSchema', () => {
  it('converts seconds to ms (0 = forever, at least 1 ms otherwise)', () => {
    expect(parse(BlockTimeoutSchema, '0')).toBe(0);
    expect(parse(BlockTimeoutSchema, '1.5')).toBe(1500);
    expect(parse(BlockTimeoutSchema, '0.0001')).toBe(1);
  });

  it('rejects what is not a finite number before a negative value', () => {
    expect(parse(BlockTimeoutSchema, 'abc')).toBe('ERR timeout is not a float or out of range');
    expect(parse(BlockTimeoutSchema, ' ')).toBe('ERR timeout is not a float or out of range');
    expect(parse(BlockTimeoutSchema, 'inf')).toBe('ERR timeout is not a float or out of range');
    expect(parse(BlockTimeoutSchema, '-1')).toBe('ERR timeout is negative');
  });
});
