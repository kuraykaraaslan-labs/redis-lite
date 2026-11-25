/**
 * Incremental dataset accounting for used_memory.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * Redis's allocator knows used_memory at all times, so maxmemory can be checked before every command. Here the size of
 * every key is computed by the memory model (src/store/memory.ts) and cached; a key is re-sized only after it changed
 * (a write touched it, it was added, removed, expired or got / lost a TTL). Each database keeps a running total, so
 * used_memory costs O(databases) plus the keys that changed since the last look, never a rescan of the dataset.
 */
import { hashFieldExpires } from '@/modules/hashes/hashes.commands';
import type { Database } from '@/modules/database/database.core';
import { objectEncoding } from '@/modules/database/database.encoding';
import type { ServerConfig } from '@/modules/server/server.config';

import { objectSize } from './memory.accounting';
import type { DbSnapshot } from './memory.accounting';

interface DbSizes {
  /** Cached objectSize of every key that is not stale. */
  sizes: Map<string, number>;
  /** Sum of `sizes`. */
  total: number;
  /** Keys changed since they were last sized. */
  stale: Set<string>;
  /** Everything must be re-sized (flush, swap, config change). */
  all: boolean;
}

export class MemoryTracker {
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
  }

  /** Every key of every database must be re-sized (a config that changes the memory model). */
  invalidateAll(): void {
    for (let i = 0; i < this.dbs.length; i++) this.changed(i, null);
  }

  private sizeOf(db: Database, key: string): number | undefined {
    const value = db.raw(key);
    if (!value) return undefined;
    const fieldTtls = value.type === 'hash' ? hashFieldExpires(value.value) : undefined;
    return objectSize(key, value, objectEncoding(value, this.config, fieldTtls !== undefined), {
      samples: 0,
      hasExpire: db.hasExpireRaw(key),
      fieldTtls,
      listMaxListpackSize: this.config.num('list-max-listpack-size'),
      streamNodeMaxEntries: this.config.num('stream-node-max-entries'),
      streamNodeMaxBytes: this.config.num('stream-node-max-bytes'),
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
  snapshots(allocated: (dbIndex: number, keys: number) => boolean): DbSnapshot[] {
    return this.databases.map((db, id) => {
      this.refresh(id);
      const keys = db.storedKeys;
      return { id, totals: { keys, expires: db.expiresCount, dataset: this.dbs[id].total }, allocated: allocated(id, keys) };
    });
  }
}
