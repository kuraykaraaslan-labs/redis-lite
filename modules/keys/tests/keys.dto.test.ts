import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { CopyDTO, ExpireCmdDTO, ObjectDTO, RestoreDTO, SortRoDTO, SwapDbDTO } from '../keys.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the keys.*.service tests.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('ExpireCmdDTO', () => {
  it('reads every condition, then refuses conflicting ones', () => {
    expect(parse(ExpireCmdDTO, ['k', '10', 'xx', 'GT'])).toMatchObject({ key: 'k', nx: false, xx: true, gt: true, lt: false });
    expect(parse(ExpireCmdDTO, ['k', '10', 'NX', 'GT'])).toBe('ERR NX and XX, GT or LT options at the same time are not compatible');
    expect(parse(ExpireCmdDTO, ['k', '10', 'GT', 'LT'])).toBe('ERR GT and LT options at the same time are not compatible');
  });

  it('an unknown option is named as given, before conflicts and overflow', () => {
    expect(parse(ExpireCmdDTO, ['k', '10', 'nx', 'Foo', 'xx'])).toBe('ERR Unsupported option Foo');
    expect(parse(ExpireCmdDTO, ['k', 'abc', 'Foo'])).toBe('ERR value is not an integer or out of range');
    expect(parse(ExpireCmdDTO, ['k', '9223372036854775807'])).toBe("ERR invalid expire time in 'expire' command");
  });
});

describe('CopyDTO', () => {
  it('a grammar error before any DB option is a plain validation error', () => {
    expect(parse(CopyDTO, ['a', 'b', 'FOO'])).toBe('ERR syntax error');
    expect(parse(CopyDTO, ['a', 'b', 'DB', 'x'])).toBe('ERR value is not an integer or out of range');
  });

  it('after a DB option the error is deferred until that database is checked', () => {
    expect(parse(CopyDTO, ['a', 'b', 'DB', '99', 'FOO'])).toEqual({
      source: 'a',
      destination: 'b',
      replace: false,
      dbs: [99],
      issue: 'ERR syntax error',
    });
  });
});

describe('ObjectDTO', () => {
  it('HELP needs no key; other subcommands exactly one', () => {
    expect(parse(ObjectDTO, ['help', 'extra'])).toEqual({ help: true });
    expect(parse(ObjectDTO, ['FOO'])).toBe("ERR wrong number of arguments for 'object|foo' command");
    expect(parse(ObjectDTO, ['FOO', 'k'])).toEqual({ help: false, key: 'k', subcommand: null, given: 'FOO' });
  });
});

describe('SortRoDTO / SwapDbDTO / RestoreDTO', () => {
  it('SORT_RO refuses STORE as an unknown option', () => {
    expect(parse(SortRoDTO, ['k', 'STORE', 'dst'])).toBe('ERR syntax error');
  });

  it('SWAPDB names the index that is wrong', () => {
    expect(parse(SwapDbDTO, ['x', 'y'])).toBe('ERR invalid first DB index');
    expect(parse(SwapDbDTO, ['0', 'y'])).toBe('ERR invalid second DB index');
  });

  it('RESTORE checks the TTL before the options', () => {
    expect(parse(RestoreDTO, ['k', '-1', 'p', 'FOO'])).toBe('ERR Invalid TTL value, must be >= 0');
    expect(parse(RestoreDTO, ['k', '0', 'p', 'FREQ', '256'])).toBe('ERR Invalid FREQ value, must be >= 0 and <= 255');
    expect(parse(RestoreDTO, ['k', '0', 'p', 'IDLETIME'])).toBe('ERR value is not an integer or out of range');
  });
});
