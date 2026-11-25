import { CommandError } from '@/libs/app-error';
import { RespMessages } from '@/libs/resp/messages';
import type { Reply } from '@/libs/resp';
import { NULL_ARRAY, RespDouble } from '@/libs/resp';
import { parseFloatArg, parseInt64 } from '@/libs/number';

import { ZSet } from '@/modules/zsets/zsets.structure';
import type { CommandContext, CommandSpec } from '@/modules/command/command.types';
import { keysAt } from '@/modules/command/command.handler';

/**
 * Geo commands, stored exactly like Redis: a sorted set whose scores are 52-bit interleaved geohashes,
 * so ZRANGE/ZREM/ZSCORE keep working on geo keys.
 */
const LAT_MIN = -85.05112878;
const LAT_MAX = 85.05112878;
const LON_MIN = -180;
const LON_MAX = 180;
const STEP = 26;
const EARTH_RADIUS = 6372797.560856;
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const UNITS: Record<string, number> = { m: 1, km: 1000, ft: 0.3048, mi: 1609.34 };

interface Point {
  lon: number;
  lat: number;
}

function interleave(x: number, y: number): bigint {
  let out = 0n;
  for (let i = 0; i < STEP; i++) {
    out |= BigInt((x >>> i) & 1) << BigInt(2 * i);
    out |= BigInt((y >>> i) & 1) << BigInt(2 * i + 1);
  }
  return out;
}

function deinterleave(bits: bigint): [number, number] {
  let x = 0;
  let y = 0;
  for (let i = 0; i < STEP; i++) {
    x |= Number((bits >> BigInt(2 * i)) & 1n) << i;
    y |= Number((bits >> BigInt(2 * i + 1)) & 1n) << i;
  }
  return [x >>> 0, y >>> 0];
}

function encode(p: Point, latMin = LAT_MIN, latMax = LAT_MAX): bigint {
  const scale = 2 ** STEP;
  const latOffset = Math.floor(((p.lat - latMin) / (latMax - latMin)) * scale);
  const lonOffset = Math.floor(((p.lon - LON_MIN) / (LON_MAX - LON_MIN)) * scale);
  return interleave(Math.min(latOffset, scale - 1), Math.min(lonOffset, scale - 1));
}

function decode(score: number): Point {
  const [ilat, ilon] = deinterleave(BigInt(score));
  const scale = 2 ** STEP;
  const latLo = LAT_MIN + (ilat / scale) * (LAT_MAX - LAT_MIN);
  const latHi = LAT_MIN + ((ilat + 1) / scale) * (LAT_MAX - LAT_MIN);
  const lonLo = LON_MIN + (ilon / scale) * (LON_MAX - LON_MIN);
  const lonHi = LON_MIN + ((ilon + 1) / scale) * (LON_MAX - LON_MIN);
  return {
    lon: Math.max(LON_MIN, Math.min(LON_MAX, (lonLo + lonHi) / 2)),
    lat: Math.max(LAT_MIN, Math.min(LAT_MAX, (latLo + latHi) / 2)),
  };
}

/** Redis's `D_R`: deg→rad is `deg * (M_PI / 180.0)`; `(deg * PI) / 180` rounds differently in the last digits. */
const D_R = Math.PI / 180;

function toRad(deg: number): number {
  return deg * D_R;
}

/** geohashGetLatDistance. */
function latDistance(lat1: number, lat2: number): number {
  return EARTH_RADIUS * Math.abs(toRad(lat2) - toRad(lat1));
}

/** geohashGetDistance (haversine), operation for operation, including its equal-longitude shortcut. */
function distance(a: Point, b: Point): number {
  const v = Math.sin((toRad(b.lon) - toRad(a.lon)) / 2);
  if (v === 0) return latDistance(a.lat, b.lat);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const u = Math.sin((lat2 - lat1) / 2);
  const h = u * u + Math.cos(lat1) * Math.cos(lat2) * v * v;
  return 2.0 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

function geohashString(p: Point): string {
  const bits = encode(p, -90, 90);
  let out = '';
  for (let i = 0; i < 11; i++) {
    const idx = i === 10 ? 0 : Number((bits >> BigInt(52 - (i + 1) * 5)) & 0x1fn);
    out += BASE32[idx];
  }
  return out;
}

/** Coordinates as Redis prints them: 17 decimals, trailing zeros removed. */
function coord(n: number): string {
  return n.toFixed(17).replace(/\.?0+$/, '');
}

function parseUnit(raw: string | undefined): number {
  const unit = UNITS[(raw ?? '').toLowerCase()];
  if (unit === undefined) throw new CommandError('ERR unsupported unit provided. please use M, KM, FT, MI');
  return unit;
}

function parsePoint(lonRaw: string, latRaw: string): Point {
  const lon = parseFloatArg(lonRaw);
  const lat = parseFloatArg(latRaw);
  if (lon < LON_MIN || lon > LON_MAX || lat < LAT_MIN || lat > LAT_MAX) {
    throw new CommandError(`ERR invalid longitude,latitude pair ${lon.toFixed(6)},${lat.toFixed(6)}`);
  }
  return { lon, lat };
}

function zset(ctx: CommandContext, key: string): ZSet | undefined {
  return ctx.db.get(key, 'zset');
}

// ---- search ---------------------------------------------------------------------------------------------------

interface SearchOptions {
  center: Point | null;
  shape: { kind: 'radius'; radius: number } | { kind: 'box'; width: number; height: number } | null;
  unit: number;
  sort: 'asc' | 'desc' | null;
  count: number;
  any: boolean;
  withCoord: boolean;
  withDist: boolean;
  withHash: boolean;
  store: string | null;
  storeDist: boolean;
}

/** extractDistanceOrReply: radius, then its sign, then the unit. */
function parseRadius(rawRadius: string, rawUnit: string | undefined): { radius: number; unit: number } {
  const radius = parseFloatArg(rawRadius, 'ERR need numeric radius');
  if (radius < 0) throw new CommandError('ERR radius cannot be negative');
  return { radius, unit: parseUnit(rawUnit) };
}

/** extractBoxOrReply: width, height, their signs, then the unit. */
function parseBox(rawWidth: string, rawHeight: string, rawUnit: string | undefined): { width: number; height: number; unit: number } {
  const width = parseFloatArg(rawWidth, 'ERR need numeric width');
  const height = parseFloatArg(rawHeight, 'ERR need numeric height');
  if (height < 0 || width < 0) throw new CommandError('ERR height or width cannot be negative');
  return { width, height, unit: parseUnit(rawUnit) };
}

type GeoKind = 'radius' | 'member' | 'search';

/**
 * georadiusGeneric: the source key is looked up first (WRONGTYPE wins), then the fixed arguments, then the
 * options in order, then the cross-option checks. Returns null options when the source key does not exist
 * (after all parsing errors had their chance), mirroring Redis's "return ASAP" path.
 */
function parseGeo(
  ctx: CommandContext,
  args: string[],
  kind: GeoKind,
  flags: { noStore: boolean; searchStore: boolean; name: string },
): { o: SearchOptions; z: ZSet | undefined } {
  const srcKey = flags.searchStore ? args[1] : args[0];
  const z = zset(ctx, srcKey);
  const o: SearchOptions = {
    center: null,
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
  };
  let base: number;
  if (kind === 'radius') {
    o.center = parsePoint(args[1], args[2]);
    const { radius, unit } = parseRadius(args[3], args[4]);
    o.shape = { kind: 'radius', radius };
    o.unit = unit;
    base = 5;
  } else if (kind === 'member') {
    base = 4;
    if (z) {
      o.center = memberPoint(z, args[1]);
      const { radius, unit } = parseRadius(args[2], args[3]);
      o.shape = { kind: 'radius', radius };
      o.unit = unit;
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
    const opt = args[i].toLowerCase();
    const more = args.length - i - 1;
    if (opt === 'withdist') o.withDist = true;
    else if (opt === 'withhash') o.withHash = true;
    else if (opt === 'withcoord') o.withCoord = true;
    else if (opt === 'any') o.any = true;
    else if (opt === 'asc' || opt === 'desc') o.sort = opt;
    else if (opt === 'count' && more >= 1) {
      const count = parseInt64(args[++i]);
      if (count <= 0n) throw new CommandError('ERR COUNT must be > 0');
      o.count = count > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(count);
    } else if ((opt === 'store' || opt === 'storedist') && more >= 1 && !flags.noStore && !search) {
      o.store = args[++i];
      o.storeDist = opt === 'storedist';
    } else if (opt === 'storedist' && search && flags.searchStore) o.storeDist = true;
    else if (opt === 'frommember' && more >= 1 && search) {
      const member = args[++i];
      if (z) o.center = memberPoint(z, member);
      fromMember = true;
    } else if (opt === 'fromlonlat' && more >= 2 && search) {
      o.center = parsePoint(args[i + 1], args[i + 2]);
      fromLonLat = true;
      i += 2;
    } else if (opt === 'byradius' && more >= 2 && search) {
      const { radius, unit } = parseRadius(args[i + 1], args[i + 2]);
      o.shape = { kind: 'radius', radius };
      o.unit = unit;
      byRadius = true;
      i += 2;
    } else if (opt === 'bybox' && more >= 3 && search) {
      const { width, height, unit } = parseBox(args[i + 1], args[i + 2], args[i + 3]);
      o.shape = { kind: 'box', width, height };
      o.unit = unit;
      byBox = true;
      i += 3;
    } else throw new CommandError(RespMessages.SYNTAX);
  }

  if (o.store !== null && (o.withDist || o.withHash || o.withCoord)) {
    const who = flags.searchStore ? 'GEOSEARCHSTORE' : 'STORE option in GEORADIUS';
    throw new CommandError(`ERR ${who} is not compatible with WITHDIST, WITHHASH and WITHCOORD options`);
  }
  // Redis formats these two with the command name as typed (argv[0]); the canonical uppercase name is used here.
  if (search && fromMember === fromLonLat) throw new CommandError(`ERR exactly one of FROMMEMBER or FROMLONLAT can be specified for ${flags.name}`);
  if (search && byRadius === byBox) throw new CommandError(`ERR exactly one of BYRADIUS and BYBOX can be specified for ${flags.name}`);
  if (o.any && !o.count) throw new CommandError('ERR the ANY argument requires COUNT argument');
  return { o, z };
}

function memberPoint(z: ZSet, member: string): Point {
  const s = z.scores.get(member);
  if (s === undefined) throw new CommandError('ERR could not decode requested zset member');
  return decode(s);
}

interface Hit {
  member: string;
  score: number;
  dist: number;
  point: Point;
}

function search(z: ZSet | undefined, o: SearchOptions): Hit[] {
  if (!z || !o.center || !o.shape) return [];
  const center = o.center;
  const shape = o.shape;
  let hits: Hit[] = [];
  for (const e of z.entries) {
    const point = decode(e.score);
    let dist: number;
    if (shape.kind === 'radius') {
      dist = distance(center, point);
      if (dist > shape.radius * o.unit) continue;
    } else {
      // geohashGetDistanceIfInRectangle: latitude first (cheaper), then longitude at the point's latitude.
      if (latDistance(point.lat, center.lat) > (shape.height * o.unit) / 2) continue;
      if (distance({ lon: point.lon, lat: point.lat }, { lon: center.lon, lat: point.lat }) > (shape.width * o.unit) / 2) continue;
      dist = distance(center, point);
    }
    hits.push({ member: e.member, score: e.score, dist, point });
    if (o.any && o.count && hits.length >= o.count) break;
  }
  const sort = o.sort ?? (o.count && !o.any ? 'asc' : null);
  if (sort) hits.sort((a, b) => (sort === 'asc' ? a.dist - b.dist : b.dist - a.dist));
  if (o.count) hits = hits.slice(0, o.count);
  return hits;
}

function respond(ctx: CommandContext, hits: Hit[], o: SearchOptions): Reply {
  if (o.store !== null) {
    const out = new ZSet();
    for (const h of hits) out.add(h.member, o.storeDist ? h.dist / o.unit : h.score);
    if (out.size) ctx.db.set(o.store, { type: 'zset', value: out });
    else ctx.db.remove(o.store);
    ctx.server.touch(ctx.client.dbIndex, o.store);
    return out.size;
  }
  if (!o.withCoord && !o.withDist && !o.withHash) return hits.map((h) => h.member);
  return hits.map((h) => {
    const item: Reply[] = [h.member];
    if (o.withDist) item.push((h.dist / o.unit).toFixed(4));
    if (o.withHash) item.push(h.score);
    if (o.withCoord) item.push([new RespDouble(h.point.lon, coord(h.point.lon)), new RespDouble(h.point.lat, coord(h.point.lat))]);
    return item;
  });
}

function geoCommand(kind: GeoKind, flags: { noStore: boolean; searchStore: boolean; name: string }) {
  return (ctx: CommandContext, args: string[]): Reply => {
    const { o, z } = parseGeo(ctx, args, kind, flags);
    return respond(ctx, search(z, o), o);
  };
}

export const geoCommands: CommandSpec[] = [
  {
    name: 'geoadd',
    arity: -5,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      let i = 1;
      let nx = false;
      let xx = false;
      let ch = false;
      for (; i < args.length; i++) {
        const opt = args[i].toLowerCase();
        if (opt === 'nx') nx = true;
        else if (opt === 'xx') xx = true;
        else if (opt === 'ch') ch = true;
        else break;
      }
      const rest = args.slice(i);
      // geoaddCommand folds both into one syntax error; zero triplets is ZADD's own syntax error.
      if (rest.length % 3 || (nx && xx) || !rest.length) throw new CommandError(RespMessages.SYNTAX);
      const items = [];
      for (let j = 0; j < rest.length; j += 3) items.push({ point: parsePoint(rest[j], rest[j + 1]), member: rest[j + 2] });
      const z = ctx.db.getOrCreate(args[0], 'zset', () => new ZSet());
      let added = 0;
      let changed = 0;
      for (const { point, member } of items) {
        const score = Number(encode(point));
        const cur = z.scores.get(member);
        if (cur === undefined) {
          if (xx) continue;
          z.add(member, score);
          added++;
        } else if (!nx && cur !== score) {
          z.add(member, score);
          changed++;
        }
      }
      ctx.db.removeIfEmpty(args[0]);
      return ch ? added + changed : added;
    },
  },
  {
    name: 'geopos',
    arity: -2,
    handler: (ctx, args) => {
      const z = zset(ctx, args[0]);
      return args.slice(1).map((m) => {
        const s = z?.scores.get(m);
        if (s === undefined) return NULL_ARRAY;
        const p = decode(s);
        return [new RespDouble(p.lon, coord(p.lon)), new RespDouble(p.lat, coord(p.lat))];
      });
    },
  },
  {
    name: 'geodist',
    arity: -4,
    handler: (ctx, args) => {
      if (args.length > 4) throw new CommandError(RespMessages.SYNTAX);
      const unit = args[3] === undefined ? 1 : parseUnit(args[3]);
      const z = zset(ctx, args[0]);
      const a = z?.scores.get(args[1]);
      const b = z?.scores.get(args[2]);
      if (a === undefined || b === undefined) return null;
      return (distance(decode(a), decode(b)) / unit).toFixed(4);
    },
  },
  {
    name: 'geohash',
    arity: -2,
    handler: (ctx, args) => {
      const z = zset(ctx, args[0]);
      return args.slice(1).map((m) => {
        const s = z?.scores.get(m);
        return s === undefined ? null : geohashString(decode(s));
      });
    },
  },
  { name: 'geosearch', arity: -7, handler: geoCommand('search', { noStore: true, searchStore: false, name: 'GEOSEARCH' }) },
  {
    name: 'geosearchstore',
    arity: -8,
    flags: { write: true },
    keys: keysAt(0),
    handler: geoCommand('search', { noStore: false, searchStore: true, name: 'GEOSEARCHSTORE' }),
  },
  { name: 'georadius', arity: -6, flags: { write: true }, handler: geoCommand('radius', { noStore: false, searchStore: false, name: 'GEORADIUS' }) },
  { name: 'georadius_ro', arity: -6, handler: geoCommand('radius', { noStore: true, searchStore: false, name: 'GEORADIUS_RO' }) },
  { name: 'georadiusbymember', arity: -5, flags: { write: true }, handler: geoCommand('member', { noStore: false, searchStore: false, name: 'GEORADIUSBYMEMBER' }) },
  { name: 'georadiusbymember_ro', arity: -5, handler: geoCommand('member', { noStore: true, searchStore: false, name: 'GEORADIUSBYMEMBER_RO' }) },
];
