import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { ScanCursorSchema, ScanOptionsSchema } from '../database.dto';

/** Unit tests of the SCAN-family grammar shared by SCAN, HSCAN and SSCAN (no server). */

/** The error text a schema reports for `input`, or the parsed value when it succeeds. */
function parse(schema: z.ZodType, input: unknown): unknown {
  const result = schema.safeParse(input);
  return result.success ? result.data : firstIssue(result.error);
}

describe('ScanCursorSchema', () => {
  it('accepts unsigned 64-bit cursors only', () => {
    expect(parse(ScanCursorSchema, '0')).toBe(0);
    expect(parse(ScanCursorSchema, '18446744073709551615')).toBe(2 ** 64);
    expect(parse(ScanCursorSchema, '-1')).toBe('ERR invalid cursor');
    expect(parse(ScanCursorSchema, 'abc')).toBe('ERR invalid cursor');
    expect(parse(ScanCursorSchema, '99999999999999999999999')).toBe('ERR invalid cursor');
  });
});

describe('ScanOptionsSchema', () => {
  it('defaults and case-insensitive options', () => {
    expect(parse(ScanOptionsSchema, [])).toEqual({ match: '*', type: null, noValues: false, count: 10 });
    expect(parse(ScanOptionsSchema, ['match', 'a*', 'COUNT', '5', 'Type', 'HASH', 'novalues'])).toEqual({
      match: 'a*',
      type: 'hash',
      noValues: true,
      count: 5,
    });
  });

  it('reports the first problem in argument order', () => {
    expect(parse(ScanOptionsSchema, ['COUNT', 'x', 'FOO'])).toBe('ERR value is not an integer or out of range');
    expect(parse(ScanOptionsSchema, ['COUNT', '0'])).toBe('ERR syntax error');
    expect(parse(ScanOptionsSchema, ['MATCH'])).toBe('ERR syntax error');
    expect(parse(ScanOptionsSchema, ['FOO', 'COUNT', 'x'])).toBe('ERR syntax error');
  });
});
