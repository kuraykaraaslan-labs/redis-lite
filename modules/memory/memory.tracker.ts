/**
 * Incremental dataset accounting for used_memory.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * Redis's allocator knows used_memory at all times, so maxmemory can be checked before every command. Here the size of
 * every key is computed by the memory model (MemoryService) and cached; a key is re-sized only after it changed
 * (a write touched it, it was added, removed, expired or got / lost a TTL). Each database keeps a running total, so
 * used_memory costs O(databases) plus the keys that changed since the last look, never a rescan of the dataset.
 */
import type { Database } from '@/modules/database/database.service';
import DatabaseService from '@/modules/database/database.service';
import type { ServerConfig } from '@/modules/server/server.service';

import MemoryService from './memory.service';
import type { DbSizes, DbSnapshot } from './memory.types';

/** Per-server stateful component: cached key sizes and per-database totals. */
export class MemoryTracker {
  /**
   * Pending re-sizes kept per database before falling back to a full re-size: past this many (and past the database's
   * key count), remembering every changed key costs more than re-sizing everything, and a server that never reads
   * used_memory (no maxmemory, no INFO) would otherwise keep every key it ever touched.
   */
  private static readonly STALE_LIMIT = 4096;

  private readonly dbs: DbSizes[];

  constructor(
    private readonly databases: readonly Database[],
    private readonly config: ServerConfig,
  ) {
    this.dbs = databases.map(() => ({ sizes: new Map(), total: 0, stale: new Set(), all: false }));
  }

  /** A key changed (or `null`: the whole database did). */
  changed(dbIndex: number, key: string | null): void {
    const d = this.dbs[dbIndex];
    if (!d) return;
    if (key === null) {
      d.sizes.clear();
      d.stale.clear();
      d.total = 0;
      d.all = true;
      return;
    }
    if (d.all) return;
    const old = d.sizes.get(key);
    if (old !== undefined) {
      d.total -= old;
      d.sizes.delete(key);
    }
    d.stale.add(key);
    if (d.stale.size > MemoryTracker.STALE_LIMIT && d.stale.size > this.databases[dbIndex].storedKeys) this.changed(dbIndex, null);
  }

  /** Keys waiting to be re-sized, all databases (bounded; see STALE_LIMIT). */
  get pendingKeys(): number {
    let n = 0;
    for (const d of this.dbs) n += d.stale.size;
    return n;
  }

  /** Every key of every database must be re-sized (a config that changes the memory model). */
  invalidateAll(): void {
    for (let i = 0; i < this.dbs.length; i++) this.changed(i, null);
  }

  private sizeOf(db: Database, key: string): number | undefined {
    const value = db.raw(key);
    if (!value) return undefined;
    return MemoryService.objectSize(key, value, DatabaseService.objectEncoding(value, this.config), {
      samples: 0,
      hasExpire: db.hasExpireRaw(key),
      listMaxListpackSize: this.config.num('list-max-listpack-size'),
      streamNodeMaxEntries: this.config.num('stream-node-max-entries'),
      streamNodeMaxBytes: this.config.num('stream-node-max-bytes'),
      allocated: true,
      sharedIntegers: this.config.num('maxmemory') === 0,
    });
  }

  /** Re-sizes the keys that changed. */
  private refresh(i: number): void {
    const d = this.dbs[i];
    const db = this.databases[i];
    if (d.all) {
      d.all = false;
      d.stale.clear();
      for (const key of db.rawKeys()) this.store(d, key, this.sizeOf(db, key));
      return;
    }
    if (!d.stale.size) return;
    const keys = [...d.stale];
    d.stale.clear();
    for (const key of keys) this.store(d, key, this.sizeOf(db, key));
  }

  private store(d: DbSizes, key: string, size: number | undefined): void {
    const old = d.sizes.get(key);
    if (old !== undefined) d.total -= old;
    if (size === undefined) d.sizes.delete(key);
    else {
      d.sizes.set(key, size);
      d.total += size;
    }
  }

  /** The databases as the memory model wants them, with up-to-date totals. */
  snapshots(): DbSnapshot[] {
    return this.databases.map((db, id) => {
      this.refresh(id);
      return { id, totals: { keys: db.storedKeys, expires: db.expiresCount, dataset: this.dbs[id].total } };
    });
  }
}

export default MemoryTracker;
