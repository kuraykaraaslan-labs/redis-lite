import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { DecrByDTO, GetExDTO, LcsDTO, MSetDTO, SetDTO, SetRangeDTO } from '../strings.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the strings.*.service tests.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('SetDTO', () => {
  it('parses the options case-insensitively', () => {
    expect(parse(SetDTO, ['k', 'v', 'nx', 'get', 'pxat', '5000'])).toEqual({
      key: 'k',
      value: 'v',
      condition: 'NX',
      get: true,
      keepTtl: false,
      expireAt: 5000,
    });
  });

  it('reads every option before validating the last expiry value', () => {
    expect(parse(SetDTO, ['k', 'v', 'EX', '0', 'FOO'])).toBe('ERR syntax error');
    expect(parse(SetDTO, ['k', 'v', 'FOO', 'EX', '0'])).toBe('ERR syntax error');
    expect(parse(SetDTO, ['k', 'v', 'EX', '10', 'PX', 'abc'])).toBe('ERR syntax error');
    expect(parse(SetDTO, ['k', 'v', 'EX', 'abc', 'EX', '10'])).toMatchObject({ key: 'k', expireAt: expect.any(Number) });
    expect(parse(SetDTO, ['k', 'v', 'EX', '10', 'EX', '0'])).toBe("ERR invalid expire time in 'set' command");
  });

  it('rejects conflicting options once all are read', () => {
    expect(parse(SetDTO, ['k', 'v', 'NX', 'XX'])).toBe('ERR syntax error');
    expect(parse(SetDTO, ['k', 'v', 'EX', '10', 'KEEPTTL'])).toBe('ERR syntax error');
  });
});

describe('GetExDTO', () => {
  it('checks the shape before parsing the time', () => {
    expect(parse(GetExDTO, ['k', 'EX', '0', 'PERSIST'])).toBe('ERR syntax error');
    expect(parse(GetExDTO, ['k', 'PERSIST'])).toEqual({ key: 'k', persist: true, expireAt: undefined });
  });
});

describe('counter, range and pair DTOs', () => {
  it('DecrByDTO negates the decrement and refuses -2^63', () => {
    expect(parse(DecrByDTO, ['k', '5'])).toEqual({ key: 'k', delta: -5n });
    expect(parse(DecrByDTO, ['k', '-9223372036854775808'])).toBe('ERR decrement would overflow');
  });

  it('SetRangeDTO: not an integer beats a negative offset', () => {
    expect(parse(SetRangeDTO, ['k', '-1', 'x'])).toBe('ERR offset is out of range');
    expect(parse(SetRangeDTO, ['k', 'a', 'x'])).toBe('ERR value is not an integer or out of range');
  });

  it('MSetDTO names the command in its arity error', () => {
    expect(parse(MSetDTO, ['a', '1', 'b'])).toBe("ERR wrong number of arguments for 'mset' command");
    expect(parse(MSetDTO, ['a', '1'])).toEqual({ pairs: [['a', '1']] });
  });

  it('LcsDTO: LEN and IDX together are refused', () => {
    expect(parse(LcsDTO, ['a', 'b', 'LEN', 'IDX'])).toBe('ERR If you want both the length and indexes, please just use IDX.');
  });
});
