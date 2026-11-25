import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { PfDebugDTO, PfMergeDTO } from '../hyperloglog.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the hyperloglog.*.service tests.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('PfDebugDTO', () => {
  it('a known subcommand takes no extra argument; an unknown one is left to the service', () => {
    expect(parse(PfDebugDTO, ['GetReg', 'k', 'x'])).toBe("ERR Wrong number of arguments for the 'GetReg' subcommand");
    expect(parse(PfDebugDTO, ['ENCODING', 'k'])).toEqual({ name: 'ENCODING', key: 'k', subcommand: 'encoding' });
    expect(parse(PfDebugDTO, ['nope', 'k', 'x'])).toEqual({ name: 'nope', key: 'k', subcommand: null });
  });
});

describe('PfMergeDTO', () => {
  it('merges the destination too', () => {
    expect(parse(PfMergeDTO, ['d', 'a'])).toEqual({ destination: 'd', keys: ['d', 'a'] });
  });
});
