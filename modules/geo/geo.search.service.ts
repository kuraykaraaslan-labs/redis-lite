import { AppError } from '@/libs/app-error';
import { RespDouble } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import { ZSet } from '@/modules/zsets/zsets.service';

import type { GeoQueryInput } from './geo.dto';
import GeoHash from './geo.geohash';
import GeoMessages from './geo.messages';
import type { GeoHit, GeoPoint, GeoQuery } from './geo.types';

/** Area searches: GEORADIUS, GEORADIUSBYMEMBER (+_RO), GEOSEARCH, GEOSEARCHSTORE. */
export default class GeoSearchService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static memberPoint(zset: ZSet, member: string): GeoPoint {
    const score = zset.scores.get(member);
    if (score === undefined) throw new AppError(GeoMessages.MEMBER_NOT_DECODED);
    return GeoHash.decode(score);
  }

  /** Members inside the shape around `center`, with COUNT / ANY / ASC / DESC applied. */
  private static find(zset: ZSet | undefined, center: GeoPoint | null, query: GeoQuery): GeoHit[] {
    if (!zset || !center || !query.shape) return [];
    const shape = query.shape;
    let hits: GeoHit[] = [];
    for (const entry of zset.entries) {
      const point = GeoHash.decode(entry.score);
      let dist: number;
      if (shape.kind === 'radius') {
        dist = GeoHash.distance(center, point);
        if (dist > shape.radius * query.unit) continue;
      } else {
        // geohashGetDistanceIfInRectangle: latitude first (cheaper), then longitude at the point's latitude.
        if (GeoHash.latDistance(point.lat, center.lat) > (shape.height * query.unit) / 2) continue;
        const lonDistance = GeoHash.distance({ lon: point.lon, lat: point.lat }, { lon: center.lon, lat: point.lat });
        if (lonDistance > (shape.width * query.unit) / 2) continue;
        dist = GeoHash.distance(center, point);
      }
      hits.push({ member: entry.member, score: entry.score, dist, point });
      if (query.any && query.count && hits.length >= query.count) break;
    }
    const sort = query.sort ?? (query.count && !query.any ? 'asc' : null);
    if (sort) hits.sort((a, b) => (sort === 'asc' ? a.dist - b.dist : b.dist - a.dist));
    if (query.count) hits = hits.slice(0, query.count);
    return hits;
  }

  /** STORE / STOREDIST (an empty result deletes the destination), or the hits with the WITH… fields asked for. */
  private static respond(ctx: CommandContext, hits: GeoHit[], query: GeoQuery): Reply {
    if (query.store !== null) {
      const out = new ZSet();
      for (const hit of hits) out.add(hit.member, query.storeDist ? hit.dist / query.unit : hit.score);
      if (out.size) ctx.db.set(query.store, { type: 'zset', value: out });
      else ctx.db.remove(query.store);
      ctx.server.touch(ctx.client.dbIndex, query.store);
      return out.size;
    }
    if (!query.withCoord && !query.withDist && !query.withHash) return hits.map((hit) => hit.member);
    return hits.map((hit) => {
      const item: Reply[] = [hit.member];
      if (query.withDist) item.push((hit.dist / query.unit).toFixed(4));
      if (query.withHash) item.push(hit.score);
      if (query.withCoord) {
        const { lon, lat } = hit.point;
        item.push([new RespDouble(lon, GeoHash.formatCoord(lon)), new RespDouble(lat, GeoHash.formatCoord(lat))]);
      }
      return item;
    });
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The source sorted set, read before any argument is parsed (WRONGTYPE wins); undefined when missing. */
  static source(ctx: CommandContext, { key }: { key: string }): ZSet | undefined {
    return ctx.db.get(key, 'zset');
  }

  /**
   * Runs a parsed query on the source read first. The center members are looked up in argument order (only when the
   * source exists, like Redis), then a grammar error met after them is reported.
   */
  static search(ctx: CommandContext, source: ZSet | undefined, query: GeoQueryInput): Reply {
    let center = query.center;
    if (source) for (const member of query.fromMembers) center = GeoSearchService.memberPoint(source, member);
    if (query.pendingError !== null) throw new AppError(query.pendingError);
    return GeoSearchService.respond(ctx, GeoSearchService.find(source, center, query), query);
  }
}
