import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { BitCountDTO, BitfieldCmdDTO, BitfieldRoDTO, BitOpDTO, BitPosDTO, SetBitDTO } from '../bitmaps.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the bitmaps.*.service tests.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('SetBitDTO', () => {
  it('a bad offset is a validation error; a bad bit waits for the offset limit check', () => {
    expect(parse(SetBitDTO, ['k', '-1', '1'])).toBe('ERR bit offset is not an integer or out of range');
    expect(parse(SetBitDTO, ['k', '7', '2'])).toEqual({ key: 'k', offset: 7, bit: 0, issue: 'ERR bit is not an integer or out of range' });
  });
});

describe('BitCountDTO / BitPosDTO', () => {
  it('ranges: start without end, integers, unit', () => {
    expect(parse(BitCountDTO, ['k'])).toEqual({ key: 'k', range: null });
    expect(parse(BitCountDTO, ['k', '0'])).toBe('ERR syntax error');
    expect(parse(BitCountDTO, ['k', 'x', '1', 'FOO'])).toBe('ERR value is not an integer or out of range');
    expect(parse(BitCountDTO, ['k', '0', '1', 'FOO'])).toBe('ERR syntax error');
    expect(parse(BitPosDTO, ['k', '1', '2'])).toEqual({ key: 'k', bit: 1, range: { start: 2, end: null, unit: 'byte' }, explicitEnd: false });
  });
});

describe('BitOpDTO', () => {
  it('the operation is checked; the source count is left to the service', () => {
    expect(parse(BitOpDTO, ['NAND', 'd', 'a'])).toBe('ERR syntax error');
    expect(parse(BitOpDTO, ['not', 'd', 'a', 'b'])).toEqual({ operation: 'not', destination: 'd', sources: ['a', 'b'] });
  });
});

describe('BitfieldCmdDTO / BitfieldRoDTO', () => {
  it('errors before any offset are validation errors', () => {
    expect(parse(BitfieldCmdDTO, ['k', 'OVERFLOW', 'FOO'])).toBe('ERR Invalid OVERFLOW type specified');
    expect(parse(BitfieldCmdDTO, ['k', 'GET', 'u8'])).toBe('ERR syntax error');
    expect(parse(BitfieldCmdDTO, ['k', 'GET', 'u64', '0'])).toMatch(/^ERR Invalid bitfield type/);
    expect(parse(BitfieldRoDTO, ['k', 'SET', 'u8', '0', '1'])).toBe('ERR BITFIELD_RO only supports the GET subcommand');
  });

  it('errors after an offset are deferred, with the pending offset', () => {
    expect(parse(BitfieldCmdDTO, ['k', 'SET', 'u8', '#2', 'x'])).toEqual({
      key: 'k',
      steps: [],
      issue: { message: 'ERR value is not an integer or out of range', offset: 16 },
    });
    expect(parse(BitfieldCmdDTO, ['k', 'GET', 'i8', '0', 'FOO'])).toMatchObject({
      steps: [{ op: 'get', offset: 0, policy: 'wrap' }],
      issue: { message: 'ERR syntax error', offset: null },
    });
  });
});
