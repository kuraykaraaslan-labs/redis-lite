import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { SInterCardDTO, SPopDTO, SRandMemberDTO } from '../sets.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the sets.*.service tests.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('SInterCardDTO', () => {
  it('numkeys, the keys, then LIMIT', () => {
    expect(parse(SInterCardDTO, ['2', 'a', 'b', 'LIMIT', '3'])).toEqual({ keys: ['a', 'b'], limit: 3 });
    expect(parse(SInterCardDTO, ['x', 'a'])).toBe('ERR numkeys should be greater than 0');
    expect(parse(SInterCardDTO, ['3', 'a', 'b'])).toBe("ERR Number of keys can't be greater than number of args");
    expect(parse(SInterCardDTO, ['1', 'a', 'LIMIT', 'x'])).toBe("ERR LIMIT can't be negative");
    expect(parse(SInterCardDTO, ['1', 'a', 'FOO', '1'])).toBe('ERR syntax error');
  });
});

describe('SPopDTO / SRandMemberDTO', () => {
  it('extra arguments are a syntax error before the count is parsed', () => {
    expect(parse(SPopDTO, ['s', 'x', 'y'])).toBe('ERR syntax error');
    expect(parse(SPopDTO, ['s', '-1'])).toBe('ERR value is out of range, must be positive');
    expect(parse(SRandMemberDTO, ['s', '-3'])).toEqual({ key: 's', count: -3 });
    expect(parse(SRandMemberDTO, ['s', 'x'])).toBe('ERR value is not an integer or out of range');
  });
});
