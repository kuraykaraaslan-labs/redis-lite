import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { HExpireCmdDTO, HGetExDTO, HRandFieldDTO, HSetCmdDTO, HSetExDTO } from '../hashes.dto';

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

describe('FIELDS clause', () => {
  it('FIELDS position, numfields, then the count', () => {
    expect(parse(HExpireCmdDTO, ['h', '10', 'NX', 'FIELDS', '1', 'f'])).toMatchObject({ condition: 'nx', fields: ['f'] });
    expect(parse(HExpireCmdDTO, ['h', '10', 'FOO', 'FIELDS', '1', 'f'])).toBe(
      'ERR Mandatory argument FIELDS is missing or not at the right position',
    );
    expect(parse(HExpireCmdDTO, ['h', '10', 'FIELDS', '0', 'f'])).toBe('ERR Number of fields must be a positive integer');
    expect(parse(HExpireCmdDTO, ['h', '10', 'FIELDS', '2', 'f'])).toBe(
      'ERR The `numfields` parameter must match the number of arguments',
    );
    expect(parse(HExpireCmdDTO, ['h', '-1', 'FIELDS', 'x'])).toBe('ERR invalid expire time, must be >= 0');
  });
});

describe('HGetExDTO / HSetExDTO', () => {
  it('expiry values: integer first, then positive (worded for hgetex)', () => {
    expect(parse(HGetExDTO, ['h', 'EX', 'x', 'FIELDS', '1', 'f'])).toBe('ERR value is not an integer or out of range');
    expect(parse(HSetExDTO, ['h', 'PX', '0', 'FIELDS', '1', 'f', 'v'])).toBe("ERR invalid expire time in 'hgetex' command");
  });

  it('HSETEX refuses conflicts where they stand', () => {
    expect(parse(HSetExDTO, ['h', 'FNX', 'FXX', 'EX', '0'])).toBe('ERR Only one of FXX or FNX arguments can be specified');
    expect(parse(HSetExDTO, ['h', 'KEEPTTL', 'EX', '10', 'FNX', 'FXX'])).toBe(
      'ERR Only one of EX, PX, EXAT, PXAT or KEEPTTL arguments can be specified',
    );
    expect(parse(HSetExDTO, ['h', 'fnx', 'keepttl', 'FIELDS', '1', 'f', 'v'])).toEqual({
      key: 'h',
      fnx: true,
      fxx: false,
      keepTtl: true,
      at: null,
      pairs: ['f', 'v'],
    });
  });
});

describe('HRandFieldDTO', () => {
  it('the count is parsed before the trailing option is checked', () => {
    expect(parse(HRandFieldDTO, ['h'])).toEqual({ key: 'h', count: null, withValues: false });
    expect(parse(HRandFieldDTO, ['h', 'x', 'FOO'])).toBe('ERR value is not an integer or out of range');
    expect(parse(HRandFieldDTO, ['h', '2', 'FOO'])).toBe('ERR syntax error');
  });
});
