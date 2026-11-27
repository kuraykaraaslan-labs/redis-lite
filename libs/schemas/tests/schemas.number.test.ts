import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { Int64Schema, IntSchema, IntSchemaWith, IntegerSchema, IntegerSchemaWith, firstIssue } from '@/libs/schemas';

/** Unit tests of the integer argument primitives (no server). */

/** The error text a schema reports for `input`, or the parsed value when it succeeds. */
function parse(schema: z.ZodType, input: unknown): unknown {
  const result = schema.safeParse(input);
  return result.success ? result.data : firstIssue(result.error);
}

const NOT_INTEGER = 'ERR value is not an integer or out of range';

describe('IntegerSchema', () => {
  it('accepts every int64 (string2ll rules), beyond 2^53 as the nearest double', () => {
    expect(parse(IntegerSchema, '0')).toBe(0);
    expect(parse(IntegerSchema, '-42')).toBe(-42);
    expect(parse(IntegerSchema, '9007199254740993')).toBe(9007199254740992);
    expect(parse(IntegerSchema, '9223372036854775807')).toBe(2 ** 63);
    expect(parse(IntegerSchema, '-9223372036854775808')).toBe(-(2 ** 63));
  });

  it('refuses what is not an int64', () => {
    for (const bad of ['9223372036854775808', '-9223372036854775809', '01', '-0', '+1', ' 1', '1.5', '', 'x']) {
      expect(parse(IntegerSchema, bad)).toBe(NOT_INTEGER);
    }
    expect(parse(IntegerSchemaWith('ERR custom'), '9223372036854775808')).toBe('ERR custom');
  });
});

describe('IntSchema', () => {
  it('reads an int64, then checks the C int range', () => {
    expect(parse(IntSchema, '2147483647')).toBe(2147483647);
    expect(parse(IntSchema, '-2147483648')).toBe(-2147483648);
    expect(parse(IntSchema, '2147483648')).toBe('ERR value is out of range, value must between -2147483648 and 2147483647');
    expect(parse(IntSchema, '-9223372036854775808')).toBe('ERR value is out of range, value must between -2147483648 and 2147483647');
    expect(parse(IntSchema, '9223372036854775808')).toBe(NOT_INTEGER);
  });

  it('words both failures as asked', () => {
    const schema = IntSchemaWith('ERR not int', 'ERR range');
    expect(parse(schema, 'x')).toBe('ERR not int');
    expect(parse(schema, '-2147483649')).toBe('ERR range');
  });
});

describe('Int64Schema', () => {
  it('keeps the exact value as a bigint', () => {
    expect(parse(Int64Schema, '9007199254740993')).toBe(9007199254740993n);
    expect(parse(Int64Schema, '-9223372036854775808')).toBe(-9223372036854775808n);
    expect(parse(Int64Schema, '9223372036854775808')).toBe(NOT_INTEGER);
  });
});
