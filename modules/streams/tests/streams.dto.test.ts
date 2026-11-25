import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import {
  RangeEndSchema,
  RangeStartSchema,
  XAddDTO,
  XClaimDTO,
  XGroupDTO,
  XInfoDTO,
  XPendingDTO,
  XReadGroupDTO,
  XRevRangeDTO,
  XSetIdDTO,
  XTrimDTO,
} from '../streams.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the streams.*.service tests.
 */

/** The error text a DTO reports for `input`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, input: unknown): unknown {
  const result = dto.safeParse(input);
  return result.success ? result.data : firstIssue(result.error);
}

const id = (ms: bigint, seq: bigint) => ({ ms, seq });
const U64_MAX = (1n << 64n) - 1n;

// ============================================================================
// Interval bounds
// ============================================================================

describe('RangeStartSchema / RangeEndSchema', () => {
  it('fills a missing seq with 0 for a start and with the largest seq for an end', () => {
    expect(parse(RangeStartSchema, '5')).toEqual(id(5n, 0n));
    expect(parse(RangeEndSchema, '5')).toEqual(id(5n, U64_MAX));
  });

  it('steps over an exclusive bound and refuses one that cannot be stepped over', () => {
    expect(parse(RangeStartSchema, '(5-1')).toEqual(id(5n, 2n));
    expect(parse(RangeEndSchema, '(5-0')).toEqual(id(4n, U64_MAX));
    expect(parse(RangeStartSchema, `(${U64_MAX}-${U64_MAX}`)).toBe('ERR invalid start ID for the interval');
    expect(parse(RangeEndSchema, '(0-0')).toBe('ERR invalid end ID for the interval');
  });

  it('accepts - and + but not as exclusive bounds', () => {
    expect(parse(RangeStartSchema, '-')).toEqual(id(0n, 0n));
    expect(parse(RangeEndSchema, '+')).toEqual(id(U64_MAX, U64_MAX));
    expect(parse(RangeStartSchema, '(-')).toBe('ERR Invalid stream ID specified as stream command argument');
  });
});

// ============================================================================
// XADD / XTRIM / XREVRANGE
// ============================================================================

describe('XAddDTO / XTrimDTO', () => {
  it('leaves the LIMIT of an approximate trim to the service (null) unless given', () => {
    expect(parse(XTrimDTO, ['k', 'MAXLEN', '~', '10'])).toMatchObject({ trim: { strategy: 'maxlen', maxlen: 10, approx: true, limit: null } });
    expect(parse(XTrimDTO, ['k', 'MAXLEN', '~', '10', 'LIMIT', '5'])).toMatchObject({ trim: { limit: 5 } });
  });

  it('checks the options before the field count, and the field count before a 0-0 id', () => {
    expect(parse(XAddDTO, ['k', 'MAXLEN', '-1', '0-0', 'f'])).toBe('ERR The MAXLEN argument must be >= 0.');
    expect(parse(XAddDTO, ['k', '0-0', 'f'])).toBe("ERR wrong number of arguments for 'xadd' command");
    expect(parse(XAddDTO, ['k', '0-0', 'f', 'v'])).toBe('ERR The ID specified in XADD must be greater than 0-0');
  });

  it('parses <ms>-* as an id whose seq comes from the stream', () => {
    expect(parse(XAddDTO, ['k', '7-*', 'f', 'v'])).toMatchObject({ id: id(7n, 0n), seqGiven: false, fields: ['f', 'v'] });
  });
});

describe('XRevRangeDTO', () => {
  it('parses the start (third argument) before the end', () => {
    expect(parse(XRevRangeDTO, ['k', '(0-0', `(${U64_MAX}-${U64_MAX}`])).toBe('ERR invalid start ID for the interval');
  });
});

// ============================================================================
// XREADGROUP / XPENDING / XCLAIM
// ============================================================================

describe('XReadGroupDTO', () => {
  it('tokenizes the ids: their errors come after the key and group checks', () => {
    expect(parse(XReadGroupDTO, ['GROUP', 'g', 'c', 'STREAMS', 'a', 'b', '>', 'bad'])).toMatchObject({
      group: 'g',
      consumer: 'c',
      keys: ['a', 'b'],
      ids: [{ kind: 'new' }, { kind: 'invalid' }],
    });
  });
});

describe('XPendingDTO', () => {
  it('parses IDLE before checking the argument count, then the count before the bounds', () => {
    expect(parse(XPendingDTO, ['k', 'g', 'IDLE', 'x', '-', '+'])).toBe('ERR value is not an integer or out of range');
    expect(parse(XPendingDTO, ['k', 'g', 'IDLE', '5', '-', '+'])).toBe('ERR syntax error');
    expect(parse(XPendingDTO, ['k', 'g', 'bad', '+', 'x'])).toBe('ERR value is not an integer or out of range');
  });
});

describe('XClaimDTO', () => {
  it('keeps the last of IDLE and TIME', () => {
    expect(parse(XClaimDTO, ['k', 'g', 'c', '0', '1-1', 'IDLE', '5', 'TIME', '9'])).toMatchObject({ deliveryTime: { kind: 'time', ms: 9 } });
  });

  it('names an unknown option', () => {
    expect(parse(XClaimDTO, ['k', 'g', 'c', '0', '1-1', 'BOGUS'])).toBe("ERR Unrecognized XCLAIM option 'BOGUS'");
  });
});

// ============================================================================
// XGROUP / XINFO / XSETID
// ============================================================================

describe('XGroupDTO / XInfoDTO', () => {
  it('checks the subcommand, then its arity', () => {
    expect(parse(XGroupDTO, ['nope', 'k'])).toBe("ERR unknown subcommand 'nope'. Try XGROUP HELP.");
    expect(parse(XGroupDTO, ['DESTROY', 'k'])).toBe("ERR wrong number of arguments for 'xgroup|destroy' command");
    expect(parse(XInfoDTO, ['constructor', 'k'])).toBe("ERR unknown subcommand 'constructor'. Try XINFO HELP.");
  });

  it('validates ENTRIESREAD up front but leaves the id to the service', () => {
    expect(parse(XGroupDTO, ['CREATE', 'k', 'g', 'bad', 'ENTRIESREAD', '-2'])).toBe('ERR value for ENTRIESREAD must be positive or -1');
    expect(parse(XGroupDTO, ['CREATE', 'k', 'g', 'bad', 'ENTRIESREAD', '-1'])).toMatchObject({ id: { kind: 'invalid' }, entriesRead: null });
  });
});

describe('XSetIdDTO', () => {
  it('refuses a MAXDELETEDID above the new last id', () => {
    expect(parse(XSetIdDTO, ['k', '5-0', 'MAXDELETEDID', '6-0'])).toBe(
      'ERR The ID specified in XSETID is smaller than the provided max_deleted_entry_id',
    );
  });
});
