import type { GeoPoint } from './geo.types';

/**
 * Geohash math, exactly like Redis: positions are stored as sorted-set scores holding a 52-bit interleaved geohash
 * (26 bits of latitude and of longitude), so ZRANGE / ZREM / ZSCORE keep working on geo keys. Distances use Redis's
 * haversine with its Earth radius, operation for operation, so the replies match digit for digit.
 */
export default class GeoHash {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────
  static readonly LAT_MIN = -85.05112878;
  static readonly LAT_MAX = 85.05112878;
  static readonly LON_MIN = -180;
  static readonly LON_MAX = 180;

  private static readonly STEP = 26;
  private static readonly EARTH_RADIUS = 6372797.560856;
  private static readonly BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  /** Redis's `D_R`: deg→rad is `deg * (M_PI / 180.0)`; `(deg * PI) / 180` rounds differently in the last digits. */
  private static readonly D_R = Math.PI / 180;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static interleave(x: number, y: number): bigint {
    let out = 0n;
    for (let i = 0; i < GeoHash.STEP; i++) {
      out |= BigInt((x >>> i) & 1) << BigInt(2 * i);
      out |= BigInt((y >>> i) & 1) << BigInt(2 * i + 1);
    }
    return out;
  }

  private static deinterleave(bits: bigint): [number, number] {
    let x = 0;
    let y = 0;
    for (let i = 0; i < GeoHash.STEP; i++) {
      x |= Number((bits >> BigInt(2 * i)) & 1n) << i;
      y |= Number((bits >> BigInt(2 * i + 1)) & 1n) << i;
    }
    return [x >>> 0, y >>> 0];
  }

  private static toRad(deg: number): number {
    return deg * GeoHash.D_R;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The 52-bit geohash of a point (the stored score); geohash strings use the full -90..90 latitude range. */
  static encode(p: GeoPoint, latMin = GeoHash.LAT_MIN, latMax = GeoHash.LAT_MAX): bigint {
    const scale = 2 ** GeoHash.STEP;
    const latOffset = Math.floor(((p.lat - latMin) / (latMax - latMin)) * scale);
    const lonOffset = Math.floor(((p.lon - GeoHash.LON_MIN) / (GeoHash.LON_MAX - GeoHash.LON_MIN)) * scale);
    return GeoHash.interleave(Math.min(latOffset, scale - 1), Math.min(lonOffset, scale - 1));
  }

  /** The center of the geohash cell a score designates. */
  static decode(score: number): GeoPoint {
    const [ilat, ilon] = GeoHash.deinterleave(BigInt(score));
    const scale = 2 ** GeoHash.STEP;
    const latLo = GeoHash.LAT_MIN + (ilat / scale) * (GeoHash.LAT_MAX - GeoHash.LAT_MIN);
    const latHi = GeoHash.LAT_MIN + ((ilat + 1) / scale) * (GeoHash.LAT_MAX - GeoHash.LAT_MIN);
    const lonLo = GeoHash.LON_MIN + (ilon / scale) * (GeoHash.LON_MAX - GeoHash.LON_MIN);
    const lonHi = GeoHash.LON_MIN + ((ilon + 1) / scale) * (GeoHash.LON_MAX - GeoHash.LON_MIN);
    return {
      lon: Math.max(GeoHash.LON_MIN, Math.min(GeoHash.LON_MAX, (lonLo + lonHi) / 2)),
      lat: Math.max(GeoHash.LAT_MIN, Math.min(GeoHash.LAT_MAX, (latLo + latHi) / 2)),
    };
  }

  /** geohashGetLatDistance. */
  static latDistance(lat1: number, lat2: number): number {
    return GeoHash.EARTH_RADIUS * Math.abs(GeoHash.toRad(lat2) - GeoHash.toRad(lat1));
  }

  /** geohashGetDistance (haversine), operation for operation, including its equal-longitude shortcut. */
  static distance(a: GeoPoint, b: GeoPoint): number {
    const v = Math.sin((GeoHash.toRad(b.lon) - GeoHash.toRad(a.lon)) / 2);
    if (v === 0) return GeoHash.latDistance(a.lat, b.lat);
    const lat1 = GeoHash.toRad(a.lat);
    const lat2 = GeoHash.toRad(b.lat);
    const u = Math.sin((lat2 - lat1) / 2);
    const h = u * u + Math.cos(lat1) * Math.cos(lat2) * v * v;
    return 2.0 * GeoHash.EARTH_RADIUS * Math.asin(Math.sqrt(h));
  }

  /** The 11-character base32 geohash string GEOHASH returns. */
  static toBase32(p: GeoPoint): string {
    const bits = GeoHash.encode(p, -90, 90);
    let out = '';
    for (let i = 0; i < 11; i++) {
      const idx = i === 10 ? 0 : Number((bits >> BigInt(52 - (i + 1) * 5)) & 0x1fn);
      out += GeoHash.BASE32[idx];
    }
    return out;
  }

  /** A coordinate as Redis prints it: 17 decimals, trailing zeros removed. */
  static formatCoord(n: number): string {
    return n.toFixed(17).replace(/\.?0+$/, '');
  }
}
