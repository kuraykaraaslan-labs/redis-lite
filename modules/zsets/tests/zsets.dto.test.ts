import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import {
  BZMPopDTO,
  ZAddDTO,
  ZInterCardDTO,
  ZPopMinDTO,
  ZRangeDTO,
  ZRangeStoreOptionsDTO,
  ZRankDTO,
  ZRevRangeByScoreDTO,
  ZScanDTO,
  ZUnionDTO,
  ZUnionStoreKeysDTO,
} from '../zsets.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the zsets.*.service tests.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('ZAddDTO', () => {
  it('reads flags until the first non-flag, then checks shape and conflicts before any score', () => {
    expect(parse(ZAddDTO, ['k', 'NX', 'CH', '1', 'a'])).toEqual({
      key: 'k',
      flags: { nx: true, xx: false, gt: false, lt: false, ch: true, incr: false },
      pairs: [[1, 'a']],
    });
    expect(parse(ZAddDTO, ['k', 'NX', 'XX', 'abc', 'a'])).toBe('ERR XX and NX options at the same time are not compatible');
    expect(parse(ZAddDTO, ['k', 'GT', 'LT', '1', 'a'])).toBe('ERR GT, LT, and/or NX options at the same time are not compatible');
    expect(parse(ZAddDTO, ['k', 'INCR', '1', 'a', '2', 'b'])).toBe('ERR INCR option supports a single increment-element pair');
    expect(parse(ZAddDTO, ['k', '1', 'a', '2'])).toBe('ERR syntax error');
    expect(parse(ZAddDTO, ['k', '1', 'a', 'x', 'b'])).toBe('ERR value is not a valid float');
  });
});

describe('range DTOs', () => {
  it('parses the options before the bounds', () => {
    expect(parse(ZRangeDTO, ['k', 'a', 'b', 'FOO'])).toBe('ERR syntax error');
    expect(parse(ZRangeDTO, ['k', 'a', 'b'])).toBe('ERR value is not an integer or out of range');
    expect(parse(ZRangeDTO, ['k', '0', '1', 'LIMIT', '0', '1'])).toBe(
      'ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX',
    );
    expect(parse(ZRangeDTO, ['k', '-', '+', 'BYLEX', 'WITHSCORES'])).toBe(
      'ERR syntax error, WITHSCORES not supported in combination with BYLEX',
    );
  });

  it('REV score ranges take max first', () => {
    expect(parse(ZRevRangeByScoreDTO, ['k', '(5', '1'])).toEqual({
      key: 'k',
      range: { by: 'score', min: { value: 1, exclusive: false }, max: { value: 5, exclusive: true } },
      options: { by: 'score', rev: true, limit: null, scores: false },
    });
    expect(parse(ZRevRangeByScoreDTO, ['k', 'x', 'y'])).toBe('ERR min or max is not a float');
  });

  it('ZRANGESTORE options alone ignore the bounds and refuse WITHSCORES', () => {
    expect(parse(ZRangeStoreOptionsDTO, ['d', 's', 'a', 'b'])).toEqual({ by: 'rank', rev: false, limit: null, scores: false });
    expect(parse(ZRangeStoreOptionsDTO, ['d', 's', '0', '1', 'WITHSCORES'])).toBe('ERR syntax error');
  });
});

describe('query DTOs', () => {
  it('ZRankDTO: key and member only (no WITHSCORE in Redis 7.0)', () => {
    expect(parse(ZRankDTO, ['k', 'm'])).toEqual({ key: 'k', member: 'm', reverse: false });
  });

  it('ZScanDTO: COUNT must be at least 1', () => {
    expect(parse(ZScanDTO, ['k', '0', 'COUNT', '0'])).toBe('ERR syntax error');
    expect(parse(ZScanDTO, ['k', 'x'])).toBe('ERR invalid cursor');
    expect(parse(ZScanDTO, ['k', '0', 'MATCH', 'a*'])).toEqual({ key: 'k', cursor: 0, match: 'a*', count: 10 });
    expect(parse(ZScanDTO, ['k', '0', 'NOSCORES'])).toBe('ERR syntax error');
  });
});

describe('pop DTOs', () => {
  it('ZPopMinDTO: a bad count is "must be positive"', () => {
    expect(parse(ZPopMinDTO, ['k'])).toEqual({ key: 'k', count: 1, withCount: false, max: false });
    expect(parse(ZPopMinDTO, ['k', 'x'])).toBe('ERR value is out of range, must be positive');
    expect(parse(ZPopMinDTO, ['k', '-1'])).toBe('ERR value is out of range, must be positive');
    expect(parse(ZPopMinDTO, ['k', '1', '2'])).toBe('ERR syntax error');
  });

  it('BZMPopDTO: the timeout is checked first', () => {
    expect(parse(BZMPopDTO, ['x', '0', 'k', 'MIN'])).toBe('ERR timeout is not a float or out of range');
    expect(parse(BZMPopDTO, ['-1', '1', 'k', 'MIN'])).toBe('ERR timeout is negative');
    expect(parse(BZMPopDTO, ['0.5', '1', 'k', 'MAX', 'COUNT', '2'])).toEqual({ timeoutMs: 500, keys: ['k'], max: true, count: 2 });
    expect(parse(BZMPopDTO, ['1', '0', 'k', 'MIN'])).toBe('ERR numkeys should be greater than 0');
    expect(parse(BZMPopDTO, ['1', 'x', 'k', 'MIN'])).toBe('ERR numkeys should be greater than 0');
    expect(parse(BZMPopDTO, ['1', '1', 'k', 'MIN', 'COUNT', 'x'])).toBe('ERR count should be greater than 0');
    // seconds are long doubles: inf and ms past the long long range are "negative", -0.5 ms waits forever
    expect(parse(BZMPopDTO, ['inf', '1', 'k', 'MIN'])).toBe('ERR timeout is negative');
    expect(parse(BZMPopDTO, ['1e17', '1', 'k', 'MIN'])).toBe('ERR timeout is negative');
    expect(parse(BZMPopDTO, ['-0.0005', '1', 'k', 'MIN'])).toMatchObject({ timeoutMs: 0 });
    expect(parse(BZMPopDTO, ['0x1p-12', '1', 'k', 'MIN'])).toMatchObject({ timeoutMs: 1 });
  });
});

describe('combine DTOs', () => {
  it('the keys step checks numkeys only', () => {
    expect(parse(ZUnionStoreKeysDTO, ['d', '0', 'a'])).toBe("ERR at least 1 input key is needed for 'zunionstore' command");
    expect(parse(ZUnionStoreKeysDTO, ['d', '3', 'a'])).toBe('ERR syntax error');
    expect(parse(ZUnionStoreKeysDTO, ['d', '1', 'a', 'BAD'])).toEqual(['a']);
  });

  it('options are recognised only with enough arguments left', () => {
    expect(parse(ZUnionDTO, ['2', 'a', 'b', 'WEIGHTS', '1'])).toBe('ERR syntax error');
    expect(parse(ZUnionDTO, ['2', 'a', 'b', 'WEIGHTS', '1', 'x'])).toBe('ERR weight value is not a float');
    expect(parse(ZUnionDTO, ['1', 'a', 'AGGREGATE', 'MAX', 'WITHSCORES'])).toEqual({
      op: 'union',
      keys: ['a'],
      weights: [1],
      aggregate: 'max',
      withScores: true,
      limit: 0,
    });
  });

  it('ZINTERCARD accepts LIMIT only', () => {
    expect(parse(ZInterCardDTO, ['1', 'a', 'LIMIT', '-1'])).toBe("ERR LIMIT can't be negative");
    expect(parse(ZInterCardDTO, ['1', 'a', 'LIMIT', 'x'])).toBe("ERR LIMIT can't be negative");
    expect(parse(ZInterCardDTO, ['1', 'a', 'WITHSCORES'])).toBe('ERR syntax error');
  });
});
