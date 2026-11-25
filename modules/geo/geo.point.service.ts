import { NULL_ARRAY, RespDouble } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import { ZSet } from '@/modules/zsets/zsets.service';

import type { GeoAddInput, GeoDistInput, KeyMembersInput } from './geo.dto';
import GeoHash from './geo.geohash';

/** Positions of members: GEOADD, GEOPOS, GEODIST, GEOHASH. */
export default class GeoPointService {
  /** GEOADD: the number of members added (CH: added + moved). */
  static add(ctx: CommandContext, { key, nx, xx, ch, items }: GeoAddInput): number {
    const zset = ctx.db.getOrCreate(key, 'zset', () => new ZSet());
    let added = 0;
    let changed = 0;
    for (const { point, member } of items) {
      const score = Number(GeoHash.encode(point));
      const current = zset.scores.get(member);
      if (current === undefined) {
        if (xx) continue;
        zset.add(member, score);
        added++;
      } else if (!nx && current !== score) {
        zset.add(member, score);
        changed++;
      }
    }
    ctx.db.removeIfEmpty(key);
    return ch ? added + changed : added;
  }

  /** GEOPOS: [longitude, latitude] per member, a null array for a missing one. */
  static pos(ctx: CommandContext, { key, members }: KeyMembersInput): Reply[] {
    const zset = ctx.db.get(key, 'zset');
    return members.map((member) => {
      const score = zset?.scores.get(member);
      if (score === undefined) return NULL_ARRAY;
      const p = GeoHash.decode(score);
      return [new RespDouble(p.lon, GeoHash.formatCoord(p.lon)), new RespDouble(p.lat, GeoHash.formatCoord(p.lat))];
    });
  }

  /** GEODIST: the distance in `unit`, 4 decimals; null when either member is missing. */
  static dist(ctx: CommandContext, { key, member1, member2, unit }: GeoDistInput): string | null {
    const zset = ctx.db.get(key, 'zset');
    const a = zset?.scores.get(member1);
    const b = zset?.scores.get(member2);
    if (a === undefined || b === undefined) return null;
    return (GeoHash.distance(GeoHash.decode(a), GeoHash.decode(b)) / unit).toFixed(4);
  }

  /** GEOHASH: the 11-character geohash string per member, null for a missing one. */
  static hash(ctx: CommandContext, { key, members }: KeyMembersInput): Array<string | null> {
    const zset = ctx.db.get(key, 'zset');
    return members.map((member) => {
      const score = zset?.scores.get(member);
      return score === undefined ? null : GeoHash.toBase32(GeoHash.decode(score));
    });
  }
}
