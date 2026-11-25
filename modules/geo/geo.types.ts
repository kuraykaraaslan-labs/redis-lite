import type { GeoSort } from './geo.enums';

/** A position in degrees. */
export type GeoPoint = {
  lon: number;
  lat: number;
};

/** The area a search covers, in the search's unit. */
export type GeoShape = { kind: 'radius'; radius: number } | { kind: 'box'; width: number; height: number };

/** One member found by a search. */
export type GeoHit = {
  member: string;
  /** The stored 52-bit geohash score. */
  score: number;
  /** Distance from the center, in meters. */
  dist: number;
  point: GeoPoint;
};

/**
 * A parsed GEORADIUS / GEORADIUSBYMEMBER / GEOSEARCH(STORE) query.
 *
 * `fromMembers` are the members whose position is the center (looked up in the source key, in argument order: a
 * missing one is `ERR could not decode requested zset member`). `pendingError` is a grammar error met AFTER such a
 * member: Redis looks the member up while parsing, so the lookup's error wins over it and it is reported only after
 * the lookups (see GeoSearchService.search).
 */
export type GeoQuery = {
  center: GeoPoint | null;
  fromMembers: string[];
  shape: GeoShape | null;
  /** Meters per unit. */
  unit: number;
  sort: GeoSort | null;
  count: number;
  any: boolean;
  withCoord: boolean;
  withDist: boolean;
  withHash: boolean;
  store: string | null;
  storeDist: boolean;
  pendingError: string | null;
};
