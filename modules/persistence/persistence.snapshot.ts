import { readFileSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { formatMessage } from '@/libs/message-format';

import PersistenceMessages from './persistence.messages';
import PersistenceService from './persistence.service';
import { PersistenceState } from './persistence.state';
import type { BgsaveJob, LoadResult, LoadedKeys, RdbDatabase, RdbFile, RdbKeyEntry, Snapshot } from './persistence.types';

/**
 * RDB layer of the persistence runtime: the point-in-time snapshot of the dataset, loading an RDB image into the
 * databases, foreground SAVE and background BGSAVE.
 *
 * Redis forks for BGSAVE. Here BGSAVE serializes the dataset synchronously (that is the point-in-time snapshot a fork
 * gives) and writes the file asynchronously, so `rdb_bgsave_in_progress` is 1 until the write lands, like Redis.
 */
export abstract class PersistenceSnapshot extends PersistenceState {
  // ──────────────────────────────────────────────
  // Snapshot
  // ──────────────────────────────────────────────

  /** The dataset as RDB entries: live keys with TTLs, LRU/LFU info. */
  snapshot(): Snapshot {
    const policy = this.cfg('maxmemory-policy');
    const lfu = policy.includes('lfu');
    const lru = policy.includes('lru');
    const dbs: RdbDatabase[] = this.host.databases.map((db) => {
      const out: RdbDatabase = new Map();
      for (const key of db.keys()) {
        const value = db.peek(key);
        if (!value) continue;
        const entry: RdbKeyEntry = { value };
        const at = db.getExpire(key);
        if (at !== undefined) entry.expireAt = at;
        if (lfu) entry.freq = db.frequency(key);
        else if (lru) entry.idle = db.idleSeconds(key);
        out.set(key, entry);
      }
      return out;
    });
    const functions = this.host.lua ? [...this.host.lua.libraries.values()].map((l) => l.code) : [];
    return { dbs, functions };
  }

  /** A complete RDB file of the current dataset. `aofBase`: written as an AOF preamble (aux aof-base 1). */
  buildRdb(aofBase = false): Buffer {
    const snap = this.snapshot();
    const aux = PersistenceService.defaultRdbAux({ aofBase, usedMem: process.memoryUsage().rss });
    return PersistenceService.writeRdb(snap.dbs, aux, snap.functions, this.rdbOptions());
  }

  // ──────────────────────────────────────────────
  // Loading
  // ──────────────────────────────────────────────

  protected loadRdbPath(path: string): LoadResult {
    const keys = this.withLoading(() => this.loadRdbBuffer(readFileSync(path), false));
    return { source: 'rdb', ...keys };
  }

  /**
   * Loads an RDB image into the databases (existing keys are replaced, like RDBFLAGS_ALLOW_DUP). Keys already expired
   * are skipped unless `preamble` (Redis loads them from an AOF preamble and lets them expire). UNCERTAIN: expired hash
   * fields are skipped on load too (Redis 7.4+ master behaviour, as recalled).
   */
  loadRdbBuffer(buf: Buffer, preamble: boolean): LoadedKeys {
    return this.loadRdbFile(PersistenceService.readRdb(buf), preamble);
  }

  protected loadRdbFile(file: RdbFile, preamble: boolean): LoadedKeys {
    const dbs = this.host.databases;
    if (file.dbs.length > dbs.length) {
      throw new Error(formatMessage(PersistenceMessages.TOO_MANY_DATABASES, { databases: dbs.length }));
    }
    if (file.functions.length) {
      const lua = this.host.lua;
      if (!lua) throw new Error(PersistenceMessages.FUNCTIONS_ENGINE_NOT_READY);
      for (const code of file.functions) lua.loadLibrary(code, true);
    }
    const now = Date.now();
    const lfu = this.cfg('maxmemory-policy').includes('lfu');
    const fill = Number(this.cfg('list-max-listpack-size', '-2'));
    const compress = Number(this.cfg('list-compress-depth', '0'));
    let keysLoaded = 0;
    let keysExpired = 0;
    file.dbs.forEach((entries, i) => {
      const db = dbs[i];
      for (const [key, e] of entries) {
        if (!preamble && e.expireAt !== undefined && e.expireAt <= now) {
          keysExpired++;
          continue;
        }
        if (e.value.type === 'list') e.value.value.adopt(fill, compress);
        db.set(key, e.value);
        if (e.expireAt !== undefined) db.setExpire(key, e.expireAt);
        if (lfu && e.freq !== undefined) db.setFrequency(key, e.freq);
        else if (!lfu && e.idle !== undefined) db.setIdle(key, e.idle);
        keysLoaded++;
      }
    });
    this.lastLoadKeysLoaded = keysLoaded;
    this.lastLoadKeysExpired = keysExpired;
    return { keysLoaded, keysExpired };
  }

  // ──────────────────────────────────────────────
  // Saving
  // ──────────────────────────────────────────────

  /** Foreground save (SAVE, SHUTDOWN, FLUSHALL with save points, DEBUG RELOAD). True on success. */
  save(): boolean {
    try {
      const buf = this.buildRdb();
      PersistenceService.writeAtomicSync(this.rdbPath, join(this.dir, `temp-${process.pid}.rdb`), buf);
    } catch (error) {
      this.host.log('warn', '[Persistence.save] Failed saving the DB', { error: PersistenceService.strerror(error) });
      PersistenceService.tryUnlink(join(this.dir, `temp-${process.pid}.rdb`));
      return false;
    }
    this.host.log('info', '[Persistence.save] DB saved on disk');
    this.dirty = 0;
    this.lastSave = Date.now();
    this.lastBgsaveStatus = 'ok';
    this.rdbSaves++;
    return true;
  }

  /** Starts a background save (rdbSaveBackground). False when the snapshot could not be produced. */
  protected startBgsave(): boolean {
    const now = Date.now();
    this.lastBgsaveTry = now;
    this.dirtyBeforeBgsave = this.dirty;
    let buf: Buffer;
    try {
      buf = this.buildRdb();
    } catch (error) {
      this.lastBgsaveStatus = 'err';
      this.host.log('warn', "[Persistence.startBgsave] Can't save in background", { error: PersistenceService.strerror(error) });
      return false;
    }
    const tmp = join(this.dir, `temp-${process.pid}-${++this.bgsaveCounter}.rdb`);
    const path = this.rdbPath;
    const job: BgsaveJob = { startedAt: now, cancelled: false, tmp, done: Promise.resolve() };
    job.done = (async () => {
      let ok = true;
      try {
        const fh = await open(tmp, 'w');
        try {
          await fh.writeFile(buf);
          await fh.sync();
        } finally {
          await fh.close();
        }
        if (job.cancelled) throw new Error(PersistenceMessages.BGSAVE_CANCELLED);
        await rename(tmp, path);
        PersistenceService.fsyncDir(this.dir);
      } catch (error) {
        ok = false;
        await unlink(tmp).catch(() => undefined);
        if (!job.cancelled) this.host.log('warn', '[Persistence.startBgsave] Write error saving DB on disk', { error: PersistenceService.strerror(error) });
      }
      this.bgsaveDone(job, ok);
    })();
    this.bgsaveJob = job;
    this.host.log('info', '[Persistence.startBgsave] Background saving started', { pid: process.pid });
    return true;
  }

  /** backgroundSaveDoneHandlerDisk. */
  private bgsaveDone(job: BgsaveJob, ok: boolean): void {
    if (this.bgsaveJob !== job) return;
    this.bgsaveJob = null;
    if (job.cancelled) {
      // killRDBChild (SIGUSR1): not an error.
      this.host.log('warn', '[Persistence.bgsaveDone] Background saving terminated by signal', { signal: 10 });
    } else if (ok) {
      this.host.log('info', '[Persistence.bgsaveDone] Background saving terminated with success');
      this.dirty = Math.max(0, this.dirty - this.dirtyBeforeBgsave);
      this.lastSave = Date.now();
      this.lastBgsaveStatus = 'ok';
      this.rdbSaves++;
    } else {
      this.host.log('warn', '[Persistence.bgsaveDone] Background saving error');
      this.lastBgsaveStatus = 'err';
    }
    this.lastBgsaveTimeSec = Math.floor(Date.now() / 1000) - Math.floor(job.startedAt / 1000);
    this.runScheduled();
  }

  /** killRDBChild: abandons a running BGSAVE (its file is not installed). */
  protected killBgsave(): void {
    const job = this.bgsaveJob;
    if (!job) return;
    job.cancelled = true;
    this.bgsaveJob = null;
    this.lastBgsaveTimeSec = Math.floor(Date.now() / 1000) - Math.floor(job.startedAt / 1000);
  }

  /** Resolves when no BGSAVE is running (tests, SHUTDOWN). */
  async waitForBackground(): Promise<void> {
    while (this.bgsaveJob) await this.bgsaveJob.done;
  }
}
