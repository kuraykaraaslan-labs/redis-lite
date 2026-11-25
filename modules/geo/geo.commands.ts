import type { z } from 'zod';

import { keysAt, validated, withDTO } from '@/modules/command/command.handler';
import type { CommandSpec } from '@/modules/command/command.types';

import {
  GeoAddDTO,
  GeoDistDTO,
  GeoHashDTO,
  GeoPosDTO,
  GeoRadiusByMemberDTO,
  GeoRadiusByMemberNoKeyDTO,
  GeoRadiusByMemberRoDTO,
  GeoRadiusByMemberRoNoKeyDTO,
  GeoRadiusDTO,
  GeoRadiusRoDTO,
  GeoSearchDTO,
  GeoSearchStoreDTO,
} from './geo.dto';
import type { GeoQueryInput } from './geo.dto';
import GeoService from './geo.service';

/**
 * Routing of the geo commands: name, arity, flags and keys, then DTO → service. No logic lives here.
 *
 * The search commands read their source key BEFORE parsing their arguments, because Redis does (a WRONGTYPE beats a
 * bad argument): they call the service's read step, then `validated()`, then the service with the value already read.
 */

const WRITE = { write: true } as const;

/** Search on the key at `sourceIndex`: read first (WRONGTYPE beats any argument error), then parse, then search. */
function searchHandler(sourceIndex: number, dto: z.ZodType<GeoQueryInput>): CommandSpec['handler'] {
  return (ctx, args) => {
    const source = GeoService.source(ctx, { key: args[sourceIndex] });
    return validated(dto, args, (query) => GeoService.search(ctx, source, query));
  };
}

/** GEORADIUSBYMEMBER: read first; Redis skips the member and radius arguments when the key does not exist. */
function byMemberHandler(dto: z.ZodType<GeoQueryInput>, noKeyDto: z.ZodType<GeoQueryInput>): CommandSpec['handler'] {
  return (ctx, args) => {
    const source = GeoService.source(ctx, { key: args[0] });
    return validated(source ? dto : noKeyDto, args, (query) => GeoService.search(ctx, source, query));
  };
}

export const geoCommands: CommandSpec[] = [
  // ============================================================================
  // Points
  // ============================================================================
  { name: 'geoadd', arity: -5, flags: WRITE, keys: keysAt(0), handler: withDTO(GeoAddDTO, GeoService.add) },
  { name: 'geopos', arity: -2, handler: withDTO(GeoPosDTO, GeoService.pos) },
  { name: 'geodist', arity: -4, handler: withDTO(GeoDistDTO, GeoService.dist) },
  { name: 'geohash', arity: -2, handler: withDTO(GeoHashDTO, GeoService.hash) },

  // ============================================================================
  // Searches
  // ============================================================================
  { name: 'geosearch', arity: -7, handler: searchHandler(0, GeoSearchDTO) },
  { name: 'geosearchstore', arity: -8, flags: WRITE, keys: keysAt(0), handler: searchHandler(1, GeoSearchStoreDTO) },
  { name: 'georadius', arity: -6, flags: WRITE, handler: searchHandler(0, GeoRadiusDTO) },
  { name: 'georadius_ro', arity: -6, handler: searchHandler(0, GeoRadiusRoDTO) },
  { name: 'georadiusbymember', arity: -5, flags: WRITE, handler: byMemberHandler(GeoRadiusByMemberDTO, GeoRadiusByMemberNoKeyDTO) },
  { name: 'georadiusbymember_ro', arity: -5, handler: byMemberHandler(GeoRadiusByMemberRoDTO, GeoRadiusByMemberRoNoKeyDTO) },
];
