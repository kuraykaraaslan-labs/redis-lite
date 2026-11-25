import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { GeoAddDTO, GeoDistDTO, GeoRadiusByMemberDTO, GeoRadiusByMemberNoKeyDTO, GeoSearchDTO } from '../geo.dto';

/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the geo.*.service tests.
 */

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('point DTOs', () => {
  it('GeoAddDTO: shape and NX + XX are one syntax error, then each pair in order', () => {
    expect(parse(GeoAddDTO, ['k', 'NX', 'XX', '1', '2', 'm'])).toBe('ERR syntax error');
    expect(parse(GeoAddDTO, ['k', '1', '2'])).toBe('ERR syntax error');
    expect(parse(GeoAddDTO, ['k', '200', '2', 'm'])).toBe('ERR invalid longitude,latitude pair 200.000000,2.000000');
    expect(parse(GeoAddDTO, ['k', 'x', '2', 'm'])).toBe('ERR value is not a valid float');
  });

  it('GeoDistDTO: unit after the shape', () => {
    expect(parse(GeoDistDTO, ['k', 'a', 'b', 'km'])).toEqual({ key: 'k', member1: 'a', member2: 'b', unit: 1000 });
    expect(parse(GeoDistDTO, ['k', 'a', 'b', 'yd'])).toBe('ERR unsupported unit provided. please use M, KM, FT, MI');
    expect(parse(GeoDistDTO, ['k', 'a', 'b', 'km', 'x'])).toBe('ERR syntax error');
  });
});

describe('search DTOs', () => {
  it('cross-option checks come after every option', () => {
    expect(parse(GeoSearchDTO, ['k', 'FROMLONLAT', '1', '2', 'BYRADIUS', '1', 'm', 'BYBOX', '1', '1', 'm'])).toBe(
      'ERR exactly one of BYRADIUS and BYBOX can be specified for GEOSEARCH',
    );
    expect(parse(GeoSearchDTO, ['k', 'FROMLONLAT', '1', '2', 'BYRADIUS', '-1', 'm'])).toBe('ERR radius cannot be negative');
    expect(parse(GeoSearchDTO, ['k', 'FROMLONLAT', '1', '2', 'BYRADIUS', '1', 'm', 'ANY'])).toBe(
      'ERR the ANY argument requires COUNT argument',
    );
  });

  it('an error after FROMMEMBER is kept for after the member lookup', () => {
    const query = parse(GeoSearchDTO, ['k', 'FROMMEMBER', 'm', 'BYRADIUS', 'x', 'm']) as { fromMembers: string[]; pendingError: string };
    expect(query.fromMembers).toEqual(['m']);
    expect(query.pendingError).toBe('ERR need numeric radius');
    expect(parse(GeoSearchDTO, ['k', 'BYRADIUS', 'x', 'm', 'FROMMEMBER', 'm'])).toBe('ERR need numeric radius');
  });

  it('GEORADIUSBYMEMBER: the radius is parsed only for an existing key', () => {
    const query = parse(GeoRadiusByMemberDTO, ['k', 'm', 'x', 'km']) as { pendingError: string };
    expect(query.pendingError).toBe('ERR need numeric radius');
    expect(parse(GeoRadiusByMemberNoKeyDTO, ['k', 'm', 'x', 'km'])).toMatchObject({ pendingError: null, shape: null });
    expect(parse(GeoRadiusByMemberNoKeyDTO, ['k', 'm', 'x', 'km', 'FOO'])).toBe('ERR syntax error');
  });
});
