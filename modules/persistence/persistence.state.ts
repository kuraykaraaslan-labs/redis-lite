import { join } from 'node:path';

import type { AofState, BgStatus } from './persistence.enums';
import { Propagator } from './persistence.propagator';
import type { AofManifest, BgsaveJob, PersistenceHost, PropagatedOp, RdbOptions } from './persistence.types';

/**
 * Base layer of the per-server persistence runtime: every piece of RDB / AOF state, the config-derived paths and the
 * helpers all layers use. The runtime is one stateful object split by responsibility into layers, each its own file:
 *
 *   PersistenceState → PersistenceSnapshot (RDB save / load) → PersistenceAofWriter (AOF append / rewrite / manifest)
 *   → PersistenceAofLoader (AOF replay) → Persistence (commands, cron, config hooks, INFO; persistence.core.ts)
 *
 * The stateless formats (RDB, DUMP, AOF text, manifest, propagation rules) are in PersistenceService.
 */
export abstract class PersistenceState {
  /** Changes since the last successful save (INFO rdb_changes_since_last_save). */
  dirty = 0;
  /** Unix ms of the last successful save (LASTSAVE). */
  lastSave = Date.now();
  /** True while loading the RDB / AOF. */
  loading = false;

  /** Propagation of executed commands; the AOF is one of its sinks (replication can add another). */
  readonly propagator: Propagator;

  // RDB
  protected lastBgsaveStatus: BgStatus = 'ok';
  protected lastBgsaveTry = 0;
  protected lastBgsaveTimeSec = -1;
  protected rdbSaves = 0;
  protected bgsaveJob: BgsaveJob | null = null;
  protected bgsaveScheduled = false;
  protected dirtyBeforeBgsave = 0;
  protected bgsaveCounter = 0;
  protected lastLoadKeysLoaded = 0;
  protected lastLoadKeysExpired = 0;

  // AOF
  protected aofState: AofState = 'off';
  protected manifest: AofManifest | null = null;
  protected aofFd: number | null = null;
  protected aofSelectedDb = -1;
  protected aofBuffer = '';
  protected aofFsyncPending = false;
  protected aofLastFsync = 0;
  protected aofLastWriteStatus: BgStatus = 'ok';
  protected aofLastWriteError = '';
  protected aofRewriteScheduled = false;
  protected aofRewrites = 0;
  protected aofRewritesConsecutiveFailures = 0;
  protected aofLastRewriteTimeSec = -1;
  protected aofLastBgrewriteStatus: BgStatus = 'ok';
  protected aofCurrentSize = 0;
  protected aofBaseSize = 0;
  protected aofIncrSize = 0;

  protected timer: NodeJS.Timeout | null = null;

  constructor(protected readonly host: PersistenceHost) {
    this.propagator = new Propagator({ databases: host.databases, config: host.config });
    // the AOF takes ops only while it is on (feedOps drops them otherwise): with AOF off nothing is recorded at all
    this.propagator.addSink(
      (ops) => this.feedOps(ops),
      () => this.aofState === 'on' && !this.loading,
    );
  }

  // ──────────────────────────────────────────────
  // Hooks implemented by later layers
  // ──────────────────────────────────────────────

  /** Appends a propagated unit to the AOF (PersistenceAofWriter). */
  abstract feedOps(ops: readonly PropagatedOp[]): void;

  /** Runs a scheduled AOF rewrite once no BGSAVE is running (PersistenceAofWriter). */
  protected abstract runScheduled(): void;

  // ──────────────────────────────────────────────
  // Paths / config
  // ──────────────────────────────────────────────

  protected cfg(name: string, fallback = ''): string {
    return this.host.config.get(name) ?? fallback;
  }

  protected get dir(): string {
    return this.cfg('dir', process.cwd());
  }

  get rdbPath(): string {
    return join(this.dir, this.cfg('dbfilename', 'dump.rdb'));
  }

  get aofDir(): string {
    return join(this.dir, this.cfg('appenddirname', 'appendonlydir'));
  }

  protected get aofName(): string {
    return this.cfg('appendfilename', 'appendonly.aof');
  }

  protected get manifestPath(): string {
    return join(this.aofDir, `${this.aofName}.manifest`);
  }

  protected rdbOptions(): Partial<RdbOptions> {
    const c = this.host.config;
    return {
      hashMaxListpackEntries: c.num('hash-max-listpack-entries'),
      hashMaxListpackValue: c.num('hash-max-listpack-value'),
      setMaxIntsetEntries: c.num('set-max-intset-entries'),
      setMaxListpackEntries: c.num('set-max-listpack-entries'),
      setMaxListpackValue: c.num('set-max-listpack-value'),
      zsetMaxListpackEntries: c.num('zset-max-listpack-entries'),
      zsetMaxListpackValue: c.num('zset-max-listpack-value'),
      listMaxListpackSize: c.num('list-max-listpack-size'),
      streamNodeMaxEntries: c.num('stream-node-max-entries'),
      streamNodeMaxBytes: c.num('stream-node-max-bytes'),
      rdbCompression: this.cfg('rdbcompression', 'yes') === 'yes',
      rdbChecksum: this.cfg('rdbchecksum', 'yes') === 'yes',
    };
  }

  /** Parsed `save` config: [seconds, changes] pairs. */
  protected savePoints(): Array<[number, number]> {
    const parts = this.cfg('save').split(' ').filter(Boolean).map(Number);
    const out: Array<[number, number]> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push([parts[i], parts[i + 1]]);
    return out;
  }

  // ──────────────────────────────────────────────
  // Dirty counter / status
  // ──────────────────────────────────────────────

  /** Call once per modification (server.touch, FLUSHALL key count, …), like Redis's server.dirty++. */
  markDirty(n = 1): void {
    this.dirty += n;
  }

  get bgsaveInProgress(): boolean {
    return this.bgsaveJob !== null;
  }

  get aofEnabled(): boolean {
    return this.aofState !== 'off';
  }

  get aofStatus(): AofState {
    return this.aofState;
  }

  /** The current AOF manifest (null when no AOF was ever created or loaded). */
  get aofManifest(): AofManifest | null {
    return this.manifest;
  }

  // ──────────────────────────────────────────────
  // Loading helpers
  // ──────────────────────────────────────────────

  protected withLoading<T>(fn: () => T): T {
    this.loading = true;
    this.propagator.pause();
    try {
      return fn();
    } finally {
      this.propagator.resume();
      this.loading = false;
    }
  }

  /** Flushes every database and every function library (Redis emptyData). */
  protected emptyData(): void {
    this.host.databases.forEach((db, i) => {
      this.host.signalFlushedDb?.(i);
      db.flush();
    });
    const lua = this.host.lua;
    if (lua) for (const name of [...lua.libraries.keys()]) lua.deleteLibrary(name);
  }
}
