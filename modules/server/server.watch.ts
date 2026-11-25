/**
 * WATCH bookkeeping (conceptually Redis's watched_keys): the server keeps, per database and key, the clients that
 * WATCH it, and each client keeps its own watched keys plus one dirty flag (CLIENT_DIRTY_CAS). A change to a watched
 * key marks its watchers dirty; EXEC fails for a dirty client. Memory is bounded by what is currently watched: a key
 * nobody watches has no entry, and a client's entries go away on UNWATCH, EXEC, DISCARD, RESET and disconnect.
 */
export class ServerWatches {
  /** dbIndex → key → the clients watching it. Empty maps are removed. */
  private readonly byDb = new Map<number, Map<string, Set<WatchedKeys>>>();

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Number of keys watched by at least one client (all databases). */
  get size(): number {
    let n = 0;
    for (const keys of this.byDb.values()) n += keys.size;
    return n;
  }

  add(watched: WatchedKeys, dbIndex: number, key: string): void {
    let keys = this.byDb.get(dbIndex);
    if (!keys) this.byDb.set(dbIndex, (keys = new Map()));
    let watchers = keys.get(key);
    if (!watchers) keys.set(key, (watchers = new Set()));
    watchers.add(watched);
  }

  remove(watched: WatchedKeys, dbIndex: number, key: string): void {
    const keys = this.byDb.get(dbIndex);
    const watchers = keys?.get(key);
    if (!keys || !watchers) return;
    watchers.delete(watched);
    if (watchers.size) return;
    keys.delete(key);
    if (!keys.size) this.byDb.delete(dbIndex);
  }

  /** A key changed: every client watching it is marked dirty. O(1) when the key is not watched. */
  touched(dbIndex: number, key: string): void {
    if (!this.byDb.size) return;
    const watchers = this.byDb.get(dbIndex)?.get(key);
    if (watchers) for (const w of watchers) w.dirty = true;
  }

  /** Marks dirty the watchers of every key of `dbIndex` for which `exists(key)` holds (FLUSHDB / FLUSHALL / SWAPDB). */
  touchedWhere(dbIndex: number, exists: (key: string) => boolean): void {
    const keys = this.byDb.get(dbIndex);
    if (!keys) return;
    for (const [key, watchers] of keys) {
      if (!exists(key)) continue;
      for (const w of watchers) w.dirty = true;
    }
  }

  /** Server close: every watch is forgotten. */
  clear(): void {
    this.byDb.clear();
  }
}

/** One client's WATCHed keys and its dirty flag. */
export class WatchedKeys {
  /** A watched key changed since it was WATCHed: EXEC must fail. */
  dirty = false;
  /** dbIndex → watched keys. */
  private readonly byDb = new Map<number, Set<string>>();
  private count = 0;
  private registry: ServerWatches | null = null;

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Number of watched keys (CLIENT LIST `watch=`, INFO total_watched_keys). */
  get size(): number {
    return this.count;
  }

  /** WATCHes a key (a key already watched keeps its state). */
  add(registry: ServerWatches, dbIndex: number, key: string): void {
    let keys = this.byDb.get(dbIndex);
    if (!keys) this.byDb.set(dbIndex, (keys = new Set()));
    if (keys.has(key)) return;
    keys.add(key);
    this.count++;
    this.registry = registry;
    registry.add(this, dbIndex, key);
  }

  /** UNWATCH (also EXEC, DISCARD, RESET, disconnect): forgets every key and the dirty flag. */
  clear(): void {
    const registry = this.registry;
    if (registry) for (const [dbIndex, keys] of this.byDb) for (const key of keys) registry.remove(this, dbIndex, key);
    this.byDb.clear();
    this.count = 0;
    this.dirty = false;
    this.registry = null;
  }
}
