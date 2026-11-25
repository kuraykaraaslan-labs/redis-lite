import { RespError } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandMeta } from '@/modules/command/command.types';
import type { Database } from '@/modules/database/database.service';
import DatabaseService from '@/modules/database/database.service';
import HashesService from '@/modules/hashes/hashes.service';
import NotificationsService from '@/modules/notifications/notifications.service';
import type { KeyEvent, NotifyFlags } from '@/modules/notifications/notifications.types';
import TrackingService from '@/modules/tracking/tracking.service';
import type { RedisValue } from '@/modules/database/database.types';

import type { RedisLiteServer } from './server.core';
import type { KeyState } from './server.types';
import { ServerWatches } from './server.watch';

/** Element count of a value (stream entries, list / set / hash / zset elements, time series samples, string bytes). */
function valueSize(v: RedisValue | undefined): number {
  if (!v) return 0;
  switch (v.type) {
    case 'string':
    case 'list':
      return v.value.length;
    case 'hash':
    case 'set':
    case 'zset':
      return v.value.size;
    case 'stream':
      return v.value.length;
    case 'timeseries':
      return v.value.totalSamples;
  }
}

/** How a command ran, for its keyspace events. */
export interface CommandOutcome {
  write: boolean;
  noop: boolean;
  meta: CommandMeta | undefined;
}

/**
 * Key change tracking: the WATCHed keys a change invalidates (ServerWatches), what happens when a key is modified, expires, is evicted or
 * its database is flushed / swapped, and the keyspace notifications those changes publish.
 */
export class ServerKeyspace {
  /** The clients WATCHing each key; only watched keys have an entry. */
  readonly watches = new ServerWatches();
  private notifyCache: { raw: string; flags: NotifyFlags | null } = { raw: '', flags: null };

  constructor(private readonly server: RedisLiteServer) {}

  // ──────────────────────────────────────────────
  // Public Methods: changes
  // ──────────────────────────────────────────────

  /** Marks a key modified: invalidates WATCH and wakes clients blocked on it. */
  touch(dbIndex: number, key: string): void {
    const server = this.server;
    server.persistence.markDirty(1);
    server.memoryModel.tracker.changed(dbIndex, key);
    TrackingService.invalidate(server.tracking, key, server.tracking.current);
    const value = server.databases[dbIndex]?.peek(key);
    if (value) server.memoryModel.markAllocated(dbIndex);
    if (value) DatabaseService.updateEncoding(value, server.config, value.type === 'hash' && HashesService.hashHasFieldTtl(value.value));
    this.watches.touched(dbIndex, key);
    server.blocking.keyChanged(dbIndex, key);
  }

  /** A key expired (on access or by the active cycle): DEL / UNLINK propagation, `expired` event, invalidation. */
  onExpired(dbIndex: number, key: string): void {
    const server = this.server;
    server.stats.expired++;
    this.watches.touched(dbIndex, key);
    server.persistence.propagator.expired(dbIndex, key);
    this.notify(dbIndex, [{ cls: 'x', event: 'expired', key }]);
    TrackingService.invalidate(server.tracking, key, null);
  }

  /** Evicts one key (maxmemory): delete, propagate DEL / UNLINK, `evicted` event, WATCH and tracking invalidation. */
  evictKey(dbIndex: number, key: string): void {
    const server = this.server;
    const db = server.databases[dbIndex];
    if (!db.remove(key)) return;
    server.persistence.propagator.also(dbIndex, [server.config.get('lazyfree-lazy-eviction') === 'yes' ? 'UNLINK' : 'DEL', key]);
    this.notify(dbIndex, [{ cls: 'e', event: 'evicted', key }]);
    this.watches.touched(dbIndex, key);
    TrackingService.invalidate(server.tracking, key, null);
  }

  /** Hash fields expired lazily (hash field TTL): `hexpired`, plus `del` when the hash is gone. */
  fieldsExpired(dbIndex: number, key: string, keyDeleted: boolean): void {
    this.server.memoryModel.tracker.changed(dbIndex, key);
    const events: KeyEvent[] = [{ cls: 'h', event: 'hexpired', key }];
    if (keyDeleted) events.push({ cls: 'g', event: 'del', key });
    this.notify(dbIndex, events);
  }

  /**
   * FLUSHDB / FLUSHALL / SWAPDB (Redis touchAllWatchedKeysInDb): invalidates the WATCHes on keys of `dbIndex` that exist there (or,
   * for SWAPDB, in `other`). Call it before the database changes. Watched keys that did not exist are left alone (Redis 7.0+).
   */
  signalFlushedDb(dbIndex: number, other?: number): void {
    const server = this.server;
    // the peak is sampled on demand; take a sample before a database is emptied
    if (other === undefined && server.databases[dbIndex]?.storedKeys) server.memoryReport();
    const databases = server.databases;
    this.watches.touchedWhere(dbIndex, (key) => databases[dbIndex].peek(key) !== undefined || (other !== undefined && databases[other].peek(key) !== undefined));
  }

  /**
   * FLUSHDB / FLUSHALL: empties the databases, counts the removed keys as changes, invalidates WATCHes and every
   * tracking client's cache. FLUSHALL also kills a running BGSAVE and saves at once when save points are configured.
   */
  flushDatabases(indexes: readonly number[], all: boolean): void {
    const server = this.server;
    for (const i of indexes) {
      server.persistence.markDirty(server.databases[i].keys().length);
      this.signalFlushedDb(i);
      server.databases[i].flush();
    }
    TrackingService.flushed(server.tracking);
    server.evictor.clearPool();
    if (all) {
      server.persistence.afterFlushAll();
      server.persistence.markDirty(1);
    }
  }

  /** SWAPDB: exchanges the contents of two databases, invalidates WATCHes and serves clients blocked on keys that now exist. */
  swapDatabases(a: number, b: number): void {
    this.signalFlushedDb(a, b);
    if (a !== b) this.signalFlushedDb(b, a);
    this.server.databases[a].swapWith(this.server.databases[b]);
    this.server.blocking.databasesSwapped(a, b);
  }

  // ──────────────────────────────────────────────
  // Public Methods: keyspace notifications
  // ──────────────────────────────────────────────

  /** Parsed notify-keyspace-events, or null when no notification can be published (or while loading). */
  notifyFlags(): NotifyFlags | null {
    const raw = this.server.config.get('notify-keyspace-events') ?? '';
    if (raw !== this.notifyCache.raw) {
      const flags = NotificationsService.parseNotifyFlags(raw);
      this.notifyCache = { raw, flags: (flags.keyspace || flags.keyevent) && flags.classes.size ? flags : null };
    }
    return this.server.persistence.loading ? null : this.notifyCache.flags;
  }

  /** Publishes keyspace / keyevent messages for events in database `dbIndex` (an event may name another db). */
  notify(dbIndex: number, events: readonly KeyEvent[]): void {
    const flags = this.notifyFlags();
    if (!flags || !events.length) return;
    for (const e of events) for (const [channel, message] of NotificationsService.notificationMessages(flags, e.db ?? dbIndex, e)) this.server.publish(channel, message);
  }

  /** The state of a command's keys before it runs. */
  keyStates(db: Database, keys: readonly string[]): Map<string, KeyState> {
    const out = new Map<string, KeyState>();
    for (const key of keys) {
      if (out.has(key)) continue;
      const v = db.peek(key);
      out.set(key, { exists: v !== undefined, size: valueSize(v) });
    }
    return out;
  }

  /** Events of one executed command: `new` for created keys, the command's own events, `keymiss` for missed reads. */
  notifyCommand(
    dbIndex: number,
    name: string,
    args: string[],
    reply: Reply,
    before: Map<string, KeyState>,
    { write, noop, meta }: CommandOutcome,
  ): void {
    if (reply instanceof RespError) return;
    const db = this.server.databases[dbIndex];
    const exists = (key: string): boolean => db.peek(key) !== undefined;
    const events: KeyEvent[] = [];
    if (write && !noop) {
      for (const key of before.keys()) if (!before.get(key)?.exists && exists(key)) events.push({ cls: 'n', event: 'new', key });
      events.push(
        ...NotificationsService.keyspaceEvents({
          name,
          args,
          reply,
          existedBefore: (key) => before.get(key)?.exists ?? false,
          existsAfter: exists,
          sizeBefore: (key) => before.get(key)?.size ?? 0,
          sizeAfter: (key) => valueSize(db.peek(key)),
        }),
      );
    }
    if (!write && meta?.flagSet.has('readonly')) {
      for (const [key, state] of before) if (!state.exists) events.push({ cls: 'm', event: 'keymiss', key });
    }
    this.notify(dbIndex, events);
  }
}
