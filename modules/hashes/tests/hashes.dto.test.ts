import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { HRandFieldDTO, HScanDTO, HSetCmdDTO } from '../hashes.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the hashes.*.service tests.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('HSetCmdDTO', () => {
  it('pairs, or an arity error naming the command', () => {
    expect(parse(HSetCmdDTO, ['h', 'f', 'v', 'g', 'w'])).toEqual({ key: 'h', pairs: [['f', 'v'], ['g', 'w']] });
    expect(parse(HSetCmdDTO, ['h', 'f', 'v', 'g'])).toBe("ERR wrong number of arguments for 'hset' command");
  });
});

describe('HScanDTO', () => {
  it('MATCH and COUNT only (no NOVALUES in Redis 7.0)', () => {
    expect(parse(HScanDTO, ['h', '0', 'MATCH', 'a*', 'COUNT', '5'])).toEqual({ key: 'h', cursor: 0, match: 'a*', count: 5 });
    expect(parse(HScanDTO, ['h', '0', 'NOVALUES'])).toBe('ERR syntax error');
  });
});

describe('HRandFieldDTO', () => {
  it('the count is parsed before the trailing option is checked', () => {
    expect(parse(HRandFieldDTO, ['h'])).toEqual({ key: 'h', count: null, withValues: false });
    expect(parse(HRandFieldDTO, ['h', 'x', 'FOO'])).toBe('ERR value is not an integer or out of range');
    expect(parse(HRandFieldDTO, ['h', '2', 'FOO'])).toBe('ERR syntax error');
  });
});
