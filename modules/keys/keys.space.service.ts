import { AppError } from '@/libs/app-error';
import { matchGlob } from '@/libs/glob';
import { OK, RespError, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import type { Database } from '@/modules/database/database.service';
import DatabaseService from '@/modules/database/database.service';
import { Stream } from '@/modules/streams/streams.structure';
import TimeseriesService from '@/modules/timeseries/timeseries.service';
import { TSDB_TYPE_NAME } from '@/modules/timeseries/timeseries.structure';
import { ZSet } from '@/modules/zsets/zsets.structure';
import type { RedisValue } from '@/modules/database/database.types';

import type { CopyInput, KeyInput, KeysInput, KeysPatternInput, RenameInput, ScanInput } from './keys.dto';
import KeysMessages from './keys.messages';

/** The keyspace of the current database: DEL, UNLINK, EXISTS, TOUCH, TYPE, RENAME, COPY, KEYS, SCAN, RANDOMKEY. */
export default class KeysSpaceService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** A deep copy of a value (COPY): collections are independent of the source. */
  private static cloneValue(v: RedisValue): RedisValue {
    switch (v.type) {
      case 'string':
        return { type: 'string', value: v.value };
      case 'hash':
        return { type: 'hash', value: new Map(v.value) };
      case 'list':
        return { type: 'list', value: [...v.value] };
      case 'set':
        return { type: 'set', value: new Set(v.value) };
      case 'zset': {
        const z = new ZSet();
        for (const e of v.value.entries) z.add(e.member, e.score);
        return { type: 'zset', value: z };
      }
      case 'stream': {
        const s = new Stream();
        s.entries = v.value.entries.map((e) => ({ id: e.id, fields: [...e.fields] }));
        s.lastId = v.value.lastId;
        s.entriesAdded = v.value.entriesAdded;
        s.maxDeletedId = v.value.maxDeletedId;
        return { type: 'stream', value: s };
      }
      case 'timeseries':
        // the copy has the samples and labels, but is neither a compaction source nor a destination
        return { type: 'timeseries', value: v.value.clone(false) };
    }
  }

  /** TYPE's name of a value: the type, or the module type name for module values (`TSDB-TYPE`). */
  private static typeName(v: RedisValue | undefined): string {
    if (!v) return 'none';
    return v.type === 'timeseries' ? TSDB_TYPE_NAME : v.type;
  }

  /** COPY's target database: each DB option must name an existing database, checked in argument order. */
  private static copyTarget(ctx: CommandContext, dbs: number[]): Database {
    let target = ctx.db;
    for (const index of dbs) {
      const db = ctx.server.databases[index];
      if (!db) throw new AppError(KeysMessages.DB_INDEX);
      target = db;
    }
    return target;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** DEL / UNLINK: the number of existing keys removed (a duplicated key counts once). */
  static del(ctx: CommandContext, { keys }: KeysInput): number {
    return keys.reduce((n, k) => n + (ctx.db.lookup(k) && ctx.db.remove(k) ? 1 : 0), 0);
  }

  /** EXISTS: counts every argument, duplicates included. */
  static exists(ctx: CommandContext, { keys }: KeysInput): number {
    return keys.reduce((n, k) => n + (ctx.db.has(k) ? 1 : 0), 0);
  }

  /** TOUCH: refreshes the access time of the existing keys and counts them. */
  static touch(ctx: CommandContext, { keys }: KeysInput): number {
    return keys.reduce((n, k) => {
      if (!ctx.db.peek(k)) return n;
      ctx.db.recordAccess(k);
      return n + 1;
    }, 0);
  }

  static type(ctx: CommandContext, { key }: KeyInput): Status {
    return new Status(KeysSpaceService.typeName(ctx.db.peek(key)));
  }

  /** RENAME (nx = false) / RENAMENX (nx = true): moves the value and its TTL. */
  static rename(ctx: CommandContext, { source, destination }: RenameInput, nx: boolean): Reply {
    const v = ctx.db.lookup(source);
    if (!v) throw new AppError(KeysMessages.NO_SUCH_KEY);
    if (source === destination) return nx ? 0 : OK;
    if (nx && ctx.db.has(destination)) return 0;
    const at = ctx.db.getExpire(source);
    ctx.db.remove(source);
    ctx.db.set(destination, v);
    if (at !== undefined) ctx.db.setExpire(destination, at);
    if (v.type === 'timeseries') TimeseriesService.renamed(ctx.db, source, destination, v.value);
    return nx ? 1 : OK;
  }

  /** COPY: 1 when copied; 0 when the source is missing or the destination exists without REPLACE. */
  static copy(ctx: CommandContext, { source, destination, replace, dbs, issue }: CopyInput): Reply {
    const target = KeysSpaceService.copyTarget(ctx, dbs);
    if (issue !== null) return new RespError(issue);
    if (target === ctx.db && source === destination) throw new AppError(KeysMessages.SAME_OBJECT);
    const v = ctx.db.lookup(source);
    if (!v) return 0;
    if (target.has(destination) && !replace) return 0;
    target.set(destination, KeysSpaceService.cloneValue(v));
    const at = ctx.db.getExpire(source);
    if (at !== undefined) target.setExpire(destination, at);
    return 1;
  }

  static keys(ctx: CommandContext, { pattern }: KeysPatternInput): string[] {
    return ctx.db.keys().filter((k) => matchGlob(pattern, k));
  }

  /** SCAN: MATCH and TYPE filter after the page is taken, so pages can be short or empty, as in Redis. */
  static scan(ctx: CommandContext, { cursor, match, type, count }: ScanInput): Reply {
    const { next, page } = DatabaseService.scanPage(ctx.db.keys(), cursor, count);
    return [String(next), page.filter((k) => matchGlob(match, k) && (!type || KeysSpaceService.typeName(ctx.db.peek(k)).toLowerCase() === type))];
  }

  static randomKey(ctx: CommandContext): string | null {
    const keys = ctx.db.keys();
    return keys.length ? keys[Math.floor(Math.random() * keys.length)] : null;
  }
}
