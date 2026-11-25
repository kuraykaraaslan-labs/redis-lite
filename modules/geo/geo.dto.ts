import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { toFloat } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';
import { FloatSchema, Int64Schema, KeySchema, ValueSchema, firstIssue, reject } from '@/libs/schemas';

import { GeoSortEnum } from './geo.enums';
import GeoHash from './geo.geohash';
import GeoMessages from './geo.messages';
import type { GeoPoint, GeoQuery } from './geo.types';

/**
 * Argument grammar of the geo commands. Each DTO parses the arguments after the command name (`args`) in Redis's
 * order, so the first issue is the error Redis reports first.
 *
 * The search commands read their source key before any argument (WRONGTYPE wins), and Redis looks FROMMEMBER /
 * GEORADIUSBYMEMBER members up while it parses: a grammar error met after such a member is not rejected here but
 * returned as `pendingError`, which the service reports after the member lookups (see GeoQuery).
 */

// ============================================================================
// Argument Primitives
// ============================================================================

/** One argument parsed inside a DTO's option loop: its value, or the Redis error text of its first issue. */
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseArg<T>(schema: z.ZodType<T>, raw: string): Parsed<T> {
  const result = schema.safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: firstIssue(result.error) };
}

/** Meters per unit; looked up by the lowercased unit name. */
const UNITS: Record<string, number> = { m: 1, km: 1000, ft: 0.3048, mi: 1609.34 };

/** A float whose failure reports `message` (Redis's "need numeric radius" family). */
function FloatSchemaWith(message: string) {
  return z
    .string()
    .refine((value) => toFloat(value) !== null, { error: message })
    .transform((value) => toFloat(value) as number);
}

const RadiusSchema = FloatSchemaWith(GeoMessages.NEED_NUMERIC_RADIUS);
const WidthSchema = FloatSchemaWith(GeoMessages.NEED_NUMERIC_WIDTH);
const HeightSchema = FloatSchemaWith(GeoMessages.NEED_NUMERIC_HEIGHT);

function parseUnit(raw: string | undefined): Parsed<number> {
  const unit = UNITS[(raw ?? '').toLowerCase()];
  return unit === undefined ? { ok: false, error: GeoMessages.UNSUPPORTED_UNIT } : { ok: true, value: unit };
}

/** `longitude latitude`: both floats, then the pair's range (as GEOADD prints it, 6 decimals). */
function parsePoint(lonRaw: string, latRaw: string): Parsed<GeoPoint> {
  const lon = parseArg(FloatSchema, lonRaw);
  if (!lon.ok) return lon;
  const lat = parseArg(FloatSchema, latRaw);
  if (!lat.ok) return lat;
  if (lon.value < GeoHash.LON_MIN || lon.value > GeoHash.LON_MAX || lat.value < GeoHash.LAT_MIN || lat.value > GeoHash.LAT_MAX) {
    return { ok: false, error: formatMessage(GeoMessages.INVALID_LON_LAT, { lon: lon.value.toFixed(6), lat: lat.value.toFixed(6) }) };
  }
  return { ok: true, value: { lon: lon.value, lat: lat.value } };
}

/** extractDistanceOrReply: radius, then its sign, then the unit. */
function parseRadius(rawRadius: string, rawUnit: string | undefined): Parsed<{ radius: number; unit: number }> {
  const radius = parseArg(RadiusSchema, rawRadius);
  if (!radius.ok) return radius;
  if (radius.value < 0) return { ok: false, error: GeoMessages.RADIUS_NEGATIVE };
  const unit = parseUnit(rawUnit);
  return unit.ok ? { ok: true, value: { radius: radius.value, unit: unit.value } } : unit;
}

/** extractBoxOrReply: width, height, their signs, then the unit. */
function parseBox(
  rawWidth: string,
  rawHeight: string,
  rawUnit: string | undefined,
): Parsed<{ width: number; height: number; unit: number }> {
  const width = parseArg(WidthSchema, rawWidth);
  if (!width.ok) return width;
  const height = parseArg(HeightSchema, rawHeight);
  if (!height.ok) return height;
  if (height.value < 0 || width.value < 0) return { ok: false, error: GeoMessages.WIDTH_HEIGHT_NEGATIVE };
  const unit = parseUnit(rawUnit);
  return unit.ok ? { ok: true, value: { width: width.value, height: height.value, unit: unit.value } } : unit;
}

// ============================================================================
// Point DTOs: GEOADD, GEOPOS, GEODIST, GEOHASH
// ============================================================================

const KeyMembersDTO = z.tuple([KeySchema], ValueSchema).transform(([key, ...members]) => ({ key, members }));

/**
 * GEOADD key [NX | XX] [CH] longitude latitude member [longitude latitude member …]
 * geoaddCommand folds a bad shape and NX + XX into one syntax error; zero triplets is ZADD's own syntax error.
 */
export const GeoAddDTO = z.tuple([KeySchema], z.string()).transform(([key, ...args], ctx) => {
  let i = 0;
  let nx = false;
  let xx = false;
  let ch = false;
  for (; i < args.length; i++) {
    const option = args[i].toLowerCase();
    if (option === 'nx') nx = true;
    else if (option === 'xx') xx = true;
    else if (option === 'ch') ch = true;
    else break;
  }
  const rest = args.slice(i);
  if (rest.length % 3 || (nx && xx) || !rest.length) return reject(ctx, RespMessages.SYNTAX);
  const items: Array<{ point: GeoPoint; member: string }> = [];
  for (let j = 0; j < rest.length; j += 3) {
    const point = parsePoint(rest[j], rest[j + 1]);
    if (!point.ok) return reject(ctx, point.error);
    items.push({ point: point.value, member: rest[j + 2] });
  }
  return { key, nx, xx, ch, items };
});

export const GeoPosDTO = KeyMembersDTO;
export const GeoHashDTO = KeyMembersDTO;

/** GEODIST key member1 member2 [M | KM | FT | MI] */
export const GeoDistDTO = z.tuple([KeySchema, ValueSchema, ValueSchema], z.string()).transform(([key, member1, member2, ...rest], ctx) => {
  if (rest.length > 1) return reject(ctx, RespMessages.SYNTAX);
  if (rest[0] === undefined) return { key, member1, member2, unit: 1 };
  const unit = parseUnit(rest[0]);
  return unit.ok ? { key, member1, member2, unit: unit.value } : reject(ctx, unit.error);
});

// ============================================================================
// Search DTOs: GEORADIUS, GEORADIUSBYMEMBER (+_RO), GEOSEARCH, GEOSEARCHSTORE
// ============================================================================

/** georadiusGeneric's three entry points: center from the arguments, from a member, or GEOSEARCH's FROM… / BY… options. */
type QueryKind = 'radius' | 'member' | 'search';

type QueryFlags = {
  /** The read-only variants and GEOSEARCH: no STORE / STORERDIST option. */
  noStore: boolean;
  /** GEOSEARCHSTORE: the destination comes first and STOREDIST is a flag. */
  searchStore: boolean;
  /** The command name used in the "exactly one of" errors. */
  name: string;
};

/**
 * georadiusGeneric's parsing: the fixed arguments, then the options in order, then the cross-option checks.
 * `memberRadius`: GEORADIUSBYMEMBER on an existing key (Redis skips the member and radius arguments when the source
 * key does not exist, then still parses the options).
 */
function parseQuery(args: string[], kind: QueryKind, flags: QueryFlags, memberRadius: boolean): Parsed<GeoQuery> {
  const query: GeoQuery = {
    center: null,
    fromMembers: [],
    shape: null,
    unit: 1,
    sort: null,
    count: 0,
    any: false,
    withCoord: false,
    withDist: false,
    withHash: false,
    store: flags.searchStore ? args[0] : null,
    storeDist: false,
    pendingError: null,
  };
  // An error met after a member lookup is reported after it (see GeoQuery.pendingError).
  const stop = (error: string): Parsed<GeoQuery> =>
    query.fromMembers.length ? { ok: true, value: { ...query, pendingError: error } } : { ok: false, error };

  let base: number;
  if (kind === 'radius') {
    const center = parsePoint(args[1], args[2]);
    if (!center.ok) return stop(center.error);
    query.center = center.value;
    const radius = parseRadius(args[3], args[4]);
    if (!radius.ok) return stop(radius.error);
    query.shape = { kind: 'radius', radius: radius.value.radius };
    query.unit = radius.value.unit;
    base = 5;
  } else if (kind === 'member') {
    base = 4;
    if (memberRadius) {
      query.fromMembers.push(args[1]);
      const radius = parseRadius(args[2], args[3]);
      if (!radius.ok) return stop(radius.error);
      query.shape = { kind: 'radius', radius: radius.value.radius };
      query.unit = radius.value.unit;
    }
  } else {
    base = flags.searchStore ? 2 : 1;
  }

  const search = kind === 'search';
  let fromMember = false;
  let fromLonLat = false;
  let byRadius = false;
  let byBox = false;
  for (let i = base; i < args.length; i++) {
    const option = args[i].toLowerCase();
    const more = args.length - i - 1;
    const sort = GeoSortEnum.safeParse(option);
    if (option === 'withdist') query.withDist = true;
    else if (option === 'withhash') query.withHash = true;
    else if (option === 'withcoord') query.withCoord = true;
    else if (option === 'any') query.any = true;
    else if (sort.success) query.sort = sort.data;
    else if (option === 'count' && more >= 1) {
      const count = parseArg(Int64Schema, args[++i]);
      if (!count.ok) return stop(count.error);
      if (count.value <= 0n) return stop(GeoMessages.COUNT_NOT_POSITIVE);
      query.count = count.value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(count.value);
    } else if ((option === 'store' || option === 'storedist') && more >= 1 && !flags.noStore && !search) {
      query.store = args[++i];
      query.storeDist = option === 'storedist';
    } else if (option === 'storedist' && search && flags.searchStore) query.storeDist = true;
    else if (option === 'frommember' && more >= 1 && search) {
      query.fromMembers.push(args[++i]);
      fromMember = true;
    } else if (option === 'fromlonlat' && more >= 2 && search) {
      const center = parsePoint(args[i + 1], args[i + 2]);
      if (!center.ok) return stop(center.error);
      query.center = center.value;
      fromLonLat = true;
      i += 2;
    } else if (option === 'byradius' && more >= 2 && search) {
      const radius = parseRadius(args[i + 1], args[i + 2]);
      if (!radius.ok) return stop(radius.error);
      query.shape = { kind: 'radius', radius: radius.value.radius };
      query.unit = radius.value.unit;
      byRadius = true;
      i += 2;
    } else if (option === 'bybox' && more >= 3 && search) {
      const box = parseBox(args[i + 1], args[i + 2], args[i + 3]);
      if (!box.ok) return stop(box.error);
      query.shape = { kind: 'box', width: box.value.width, height: box.value.height };
      query.unit = box.value.unit;
      byBox = true;
      i += 3;
    } else return stop(RespMessages.SYNTAX);
  }

  if (query.store !== null && (query.withDist || query.withHash || query.withCoord)) {
    return stop(flags.searchStore ? GeoMessages.SEARCHSTORE_WITH_OPTIONS : GeoMessages.STORE_WITH_OPTIONS);
  }
  if (search && fromMember === fromLonLat) return stop(formatMessage(GeoMessages.EXACTLY_ONE_FROM, { command: flags.name }));
  if (search && byRadius === byBox) return stop(formatMessage(GeoMessages.EXACTLY_ONE_BY, { command: flags.name }));
  if (query.any && !query.count) return stop(GeoMessages.ANY_REQUIRES_COUNT);
  return { ok: true, value: query };
}

function QueryDTO(kind: QueryKind, flags: QueryFlags, memberRadius = true) {
  return z.array(z.string()).transform((args, ctx) => {
    const query = parseQuery(args, kind, flags, memberRadius);
    return query.ok ? query.value : reject(ctx, query.error);
  });
}

const GEORADIUS = { noStore: false, searchStore: false, name: 'GEORADIUS' };
const GEORADIUS_RO = { noStore: true, searchStore: false, name: 'GEORADIUS_RO' };
const GEORADIUSBYMEMBER = { noStore: false, searchStore: false, name: 'GEORADIUSBYMEMBER' };
const GEORADIUSBYMEMBER_RO = { noStore: true, searchStore: false, name: 'GEORADIUSBYMEMBER_RO' };

/** GEORADIUS key longitude latitude radius unit [options] */
export const GeoRadiusDTO = QueryDTO('radius', GEORADIUS);
export const GeoRadiusRoDTO = QueryDTO('radius', GEORADIUS_RO);

/** GEORADIUSBYMEMBER key member radius unit [options], on an existing key. */
export const GeoRadiusByMemberDTO = QueryDTO('member', GEORADIUSBYMEMBER);
export const GeoRadiusByMemberRoDTO = QueryDTO('member', GEORADIUSBYMEMBER_RO);

/** GEORADIUSBYMEMBER on a missing key: the member and the radius are not looked at, the options still are. */
export const GeoRadiusByMemberNoKeyDTO = QueryDTO('member', GEORADIUSBYMEMBER, false);
export const GeoRadiusByMemberRoNoKeyDTO = QueryDTO('member', GEORADIUSBYMEMBER_RO, false);

/** GEOSEARCH key FROMMEMBER m | FROMLONLAT lon lat  BYRADIUS r unit | BYBOX w h unit [options] */
export const GeoSearchDTO = QueryDTO('search', { noStore: true, searchStore: false, name: 'GEOSEARCH' });

/** GEOSEARCHSTORE destination source … [STOREDIST] */
export const GeoSearchStoreDTO = QueryDTO('search', { noStore: false, searchStore: true, name: 'GEOSEARCHSTORE' });

// ============================================================================
// Type Exports
// ============================================================================

export type KeyMembersInput = z.infer<typeof KeyMembersDTO>;
export type GeoAddInput = z.infer<typeof GeoAddDTO>;
export type GeoDistInput = z.infer<typeof GeoDistDTO>;
export type GeoQueryInput = z.infer<typeof GeoSearchDTO>;
