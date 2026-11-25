import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { BlockTimeoutSchema as TimeoutSchema, firstIssue } from '@/libs/schemas';

import { BLMoveDTO, BLMPopDTO, LMPopDTO, LPopDTO, LPosDTO } from '../lists.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the lists.*.service tests.
 */

/** The error text a DTO reports for `input`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, input: unknown): unknown {
  const result = dto.safeParse(input);
  return result.success ? result.data : firstIssue(result.error);
}

describe('TimeoutSchema', () => {
  it('seconds → ms, 0 = forever, at least 1 ms', () => {
    expect(parse(TimeoutSchema, '0')).toBe(0);
    expect(parse(TimeoutSchema, '0.0001')).toBe(1);
    expect(parse(TimeoutSchema, '1.5')).toBe(1500);
    expect(parse(TimeoutSchema, 'abc')).toBe('ERR timeout is not a float or out of range');
    expect(parse(TimeoutSchema, '-1')).toBe('ERR timeout is negative');
  });
});

describe('LPopDTO', () => {
  it('a second count is an arity error, a bad count must be positive', () => {
    expect(parse(LPopDTO, ['l', '1', '2'])).toBe("ERR wrong number of arguments for 'lpop' command");
    expect(parse(LPopDTO, ['l', 'x'])).toBe('ERR value is out of range, must be positive');
    expect(parse(LPopDTO, ['l', '0'])).toEqual({ key: 'l', left: true, count: 0 });
  });
});

describe('LMPopDTO / BLMPopDTO', () => {
  it('numkeys, keys and side, then COUNT', () => {
    expect(parse(LMPopDTO, ['2', 'a', 'b', 'RIGHT', 'COUNT', '3'])).toEqual({ keys: ['a', 'b'], left: false, count: 3 });
    expect(parse(LMPopDTO, ['0', 'a', 'LEFT'])).toBe('ERR numkeys should be greater than 0');
    expect(parse(LMPopDTO, ['1', 'a', 'UP'])).toBe('ERR syntax error');
    expect(parse(LMPopDTO, ['1', 'a', 'LEFT', 'COUNT', '0'])).toBe('ERR count should be greater than 0');
  });

  it('BLMPOP checks the timeout first', () => {
    expect(parse(BLMPopDTO, ['-1', '0', 'a', 'UP'])).toBe('ERR timeout is negative');
  });
});

describe('LPosDTO / BLMoveDTO', () => {
  it('LPOS options are checked where they stand', () => {
    expect(parse(LPosDTO, ['l', 'e', 'RANK', '0', 'COUNT', '-1'])).toMatch(/^ERR RANK can't be zero/);
    expect(parse(LPosDTO, ['l', 'e', 'COUNT'])).toBe('ERR syntax error');
  });

  it('BLMOVE checks the sides before the timeout', () => {
    expect(parse(BLMoveDTO, ['a', 'b', 'UP', 'LEFT', '-1'])).toBe('ERR syntax error');
    expect(parse(BLMoveDTO, ['a', 'b', 'left', 'RIGHT', '-1'])).toBe('ERR timeout is negative');
  });
});
