/**
 * Persistence: RDB snapshots (SAVE / BGSAVE / save points), the multi-part AOF of Redis 7+ (manifest + base + incr files,
 * BGREWRITEAOF, appendfsync), loading at startup, DEBUG RELOAD / LOADAOF and the INFO persistence section.
 *
 * `Persistence` is the per-server runtime (one stateful object, split by responsibility into layers, see
 * persistence.state.ts). This file holds its top layer: startup load, the command entry points, write denial, config
 * hooks, serverCron duties and INFO.
 */
import { existsSync, fsyncSync, readFileSync } from 'node:fs';

import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import type { Reply } from '@/libs/resp';
import { OK, Status } from '@/libs/resp';

import { PersistenceAofLoader } from './persistence.aof_loader';
import PersistenceMessages from './persistence.messages';
import PersistenceService from './persistence.service';
import type { LoadResult } from './persistence.types';

export class Persistence extends PersistenceAofLoader {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Redis CONFIG_BGSAVE_RETRY_DELAY (seconds). */
  private static readonly BGSAVE_RETRY_DELAY = 5;

  // ──────────────────────────────────────────────
  // Startup
  // ──────────────────────────────────────────────

  /**
   * Startup load (Redis loadDataFromDisk + aofOpenIfNeededOnServerStart). appendonly yes: the AOF (an old single-file
   * appendonly.aof is upgraded into the AOF dir first); when none exists, an empty base + incr file are created and the
   * RDB is NOT loaded (Redis 7 behaviour). appendonly no: dir/dbfilename when present. Throws on a corrupt file (Redis
   * exits). Needs the Lua engine when the files contain functions.
   */
  loadAtStartup(): LoadResult {
    const started = Date.now();
    let result: LoadResult = { source: 'none', keysLoaded: 0, keysExpired: 0 };
    if (this.cfg('appendonly') === 'yes') {
      this.aofState = 'on';
      this.manifest = this.loadManifestFromDisk();
      if (this.manifest && (this.manifest.base || this.manifest.incr.length)) {
        result = this.loadAof(this.manifest);
        this.host.log('info', '[Persistence.loadAtStartup] DB loaded from append only file', { seconds: ((Date.now() - started) / 1000).toFixed(3) });
      }
      this.openAofOnStart();
      this.deleteHistoryFiles();
    } else if (existsSync(this.rdbPath)) {
      result = this.loadRdbPath(this.rdbPath);
      this.host.log('info', '[Persistence.loadAtStartup] DB loaded from disk', { seconds: ((Date.now() - started) / 1000).toFixed(3) });
    }
    this.dirty = 0;
    this.lastSave = Date.now();
    return result;
  }

  // ──────────────────────────────────────────────
  // Commands
  // ──────────────────────────────────────────────

  /** SAVE. */
  saveCommand(): Reply {
    if (this.bgsaveJob) throw new AppError(PersistenceMessages.BGSAVE_IN_PROGRESS);
    if (this.save()) return OK;
    throw new AppError(PersistenceMessages.SAVE_FAILED);
  }

  /**
   * BGSAVE [SCHEDULE]. `inExec`: called inside MULTI/EXEC, where Redis schedules it. SCHEDULE only matters while an
   * AOF rewrite child runs ("Another child process is active (AOF?)…"); rewrites here are synchronous, so never.
   */
  bgsaveCommand(opts: { schedule?: boolean; inExec?: boolean } = {}): Reply {
    if (this.bgsaveJob) throw new AppError(PersistenceMessages.BGSAVE_IN_PROGRESS);
    if (opts.inExec) {
      this.bgsaveScheduled = true;
      return new Status(PersistenceMessages.BGSAVE_SCHEDULED);
    }
    if (this.startBgsave()) return new Status(PersistenceMessages.BGSAVE_STARTED);
    throw new AppError(PersistenceMessages.SAVE_FAILED);
  }

  /** BGREWRITEAOF. */
  bgrewriteaofCommand(inExec = false): Reply {
    if (this.bgsaveJob || inExec) {
      this.aofRewriteScheduled = true;
      this.aofRewritesConsecutiveFailures = 0;
      return new Status(PersistenceMessages.AOF_REWRITE_SCHEDULED);
    }
    if (this.rewriteAof()) return new Status(PersistenceMessages.AOF_REWRITE_STARTED);
    throw new AppError(PersistenceMessages.AOF_REWRITE_FAILED);
  }

  /** LASTSAVE: unix seconds. */
  lastsaveCommand(): number {
    return Math.floor(this.lastSave / 1000);
  }

  /**
   * DEBUG RELOAD [MERGE] [NOFLUSH] [NOSAVE]: save the RDB, empty the dataset (and functions), load the RDB back.
   * With NOFLUSH, keys present in both are replaced (Redis needs MERGE for that and panics otherwise).
   */
  debugReload(opts: { merge?: boolean; noflush?: boolean; nosave?: boolean } = {}): Reply {
    if (!opts.nosave) {
      this.killBgsave();
      if (!this.save()) throw new AppError(PersistenceMessages.SAVE_FAILED);
    }
    if (!opts.noflush) this.emptyData();
    try {
      this.withLoading(() => this.loadRdbBuffer(readFileSync(this.rdbPath), false));
    } catch (error) {
      this.host.log('warn', '[Persistence.debugReload] Error trying to load the RDB dump', { error: PersistenceService.strerror(error) });
      throw new AppError(PersistenceMessages.RELOAD_FAILED);
    }
    this.host.log('info', '[Persistence.debugReload] DB reloaded by DEBUG RELOAD');
    return OK;
  }

  /** DEBUG LOADAOF: flush the AOF, empty the dataset, load the AOF again. */
  debugLoadAof(): Reply {
    if (this.aofState === 'on') this.flushAof(true);
    this.emptyData();
    try {
      const m = this.loadManifestFromDisk();
      if (m) {
        this.manifest = m;
        this.deleteHistoryFiles();
        this.loadAof(m);
      }
    } catch (error) {
      this.host.log('warn', '[Persistence.debugLoadAof] Error loading the AOF', { error: PersistenceService.strerror(error) });
      throw new AppError(PersistenceMessages.LOADAOF_FAILED);
    }
    this.dirty = 0;
    this.host.log('info', '[Persistence.debugLoadAof] Append Only File loaded by DEBUG LOADAOF');
    return OK;
  }

  /**
   * A replica's full sync: the RDB received from the master replaces the whole dataset (functions included). The
   * payload is parsed before anything is flushed, so a corrupt one leaves the old dataset in place (throws). Keys whose
   * TTL already elapsed are kept: a replica waits for the master's DEL. With the AOF on, it is rewritten from the new
   * dataset.
   */
  replaceDataset(payload: Buffer): LoadResult {
    const file = PersistenceService.readRdb(payload);
    this.killBgsave();
    this.emptyData();
    const keys = this.withLoading(() => this.loadRdbFile(file, true));
    if (this.aofState === 'on') this.rewriteAof();
    return { source: 'rdb', ...keys };
  }

  /**
   * After FLUSHALL (flushallCommand): kill a running BGSAVE; with save points configured, save the now empty dataset
   * right away. The caller then still counts FLUSHALL as one change (server.dirty++), so it propagates.
   */
  afterFlushAll(): void {
    this.killBgsave();
    if (this.savePoints().length) this.save();
  }

  /**
   * SHUTDOWN preparation (prepareForShutdown): kill BGSAVE, flush + fsync the AOF, save the RDB when save points are
   * configured (or `save`) unless `nosave`. False when the save failed and the shutdown must be refused (the caller
   * replies "ERR Errors trying to SHUTDOWN. Check logs.") unless `force`.
   */
  prepareShutdown(opts: { save?: boolean; nosave?: boolean; force?: boolean } = {}): boolean {
    this.killBgsave();
    if (this.aofState !== 'off') {
      this.flushAof(true);
      if (this.aofFd !== null) {
        try {
          fsyncSync(this.aofFd);
        } catch {
          // reported through aof_last_write_status already
        }
      }
    }
    if ((this.savePoints().length && !opts.nosave) || opts.save) {
      this.host.log('info', '[Persistence.prepareShutdown] Saving the final RDB snapshot before exiting');
      if (!this.save()) {
        if (!opts.force) {
          this.host.log('warn', "[Persistence.prepareShutdown] Error trying to save the DB, can't exit");
          return false;
        }
      } else this.host.log('info', '[Persistence.prepareShutdown] DB saved on disk');
    }
    this.stop();
    return true;
  }

  // ──────────────────────────────────────────────
  // Write denial
  // ──────────────────────────────────────────────

  /**
   * writeCommandsDeniedByDiskError: the error a write command (and, on a master, PING) must get instead of running,
   * or null. Without the leading '-'.
   */
  writeDeniedError(): string | null {
    if (this.cfg('stop-writes-on-bgsave-error', 'yes') === 'yes' && this.savePoints().length && this.lastBgsaveStatus === 'err') {
      return PersistenceMessages.RDB_MISCONF;
    }
    if (this.aofState !== 'off' && this.aofLastWriteStatus === 'err') return formatMessage(PersistenceMessages.AOF_MISCONF, { error: this.aofLastWriteError });
    return null;
  }

  // ──────────────────────────────────────────────
  // Config hooks
  // ──────────────────────────────────────────────

  /**
   * Call after CONFIG SET stored a new value. Returns the reason to report when the change cannot be applied (Redis:
   * "ERR CONFIG SET failed (possibly related to argument 'appendonly') - <reason>"), else null.
   */
  onConfigChange(name: string): string | null {
    const key = name.toLowerCase();
    if (key === 'appendonly') {
      const want = this.cfg('appendonly') === 'yes';
      if (want && this.aofState === 'off') return this.startAppendOnly() ? null : PersistenceMessages.AOF_ENABLE_FAILED;
      if (!want && this.aofState !== 'off') this.stopAppendOnly();
    } else if (key === 'appendfsync' && this.cfg('appendfsync') === 'always') this.fsyncAof();
    return null;
  }

  // ──────────────────────────────────────────────
  // Cron
  // ──────────────────────────────────────────────

  /** Starts serverCron's persistence duties (every 100 ms, like hz 10). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.cron(Date.now()), 100);
    this.timer.unref();
  }

  /** Stops the timer and closes the AOF (after a final flush + fsync). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closeAofFd();
  }

  /** One serverCron tick: scheduled BGSAVE / rewrite, save points, auto AOF rewrite, everysec fsync, write retry. */
  cron(now = Date.now()): void {
    const sec = Math.floor(now / 1000);
    const retryOk = sec - Math.floor(this.lastBgsaveTry / 1000) > Persistence.BGSAVE_RETRY_DELAY || this.lastBgsaveStatus === 'ok';
    if (!this.bgsaveJob) {
      this.runScheduled();
      if (this.bgsaveScheduled && retryOk) {
        if (this.startBgsave()) this.bgsaveScheduled = false;
      }
    }
    if (!this.bgsaveJob) {
      for (const [seconds, changes] of this.savePoints()) {
        if (this.dirty >= changes && sec - Math.floor(this.lastSave / 1000) > seconds && retryOk) {
          this.host.log('info', '[Persistence.cron] Save point reached, saving', { changes, seconds });
          this.startBgsave();
          break;
        }
      }
    }
    if (!this.bgsaveJob && this.aofState === 'on') {
      const perc = Number(this.cfg('auto-aof-rewrite-percentage', '100'));
      const minSize = Number(this.cfg('auto-aof-rewrite-min-size', String(64 * 1024 * 1024)));
      if (perc && this.aofCurrentSize > minSize) {
        const base = this.aofBaseSize || 1;
        const growth = Math.floor((this.aofCurrentSize * 100) / base) - 100;
        if (growth >= perc) {
          this.host.log('info', '[Persistence.cron] Starting automatic rewriting of AOF', { growthPercent: growth });
          this.rewriteAof();
        }
      }
    }
    if (this.aofState === 'on') {
      if (this.aofBuffer) this.flushAof(false);
      if (this.cfg('appendfsync', 'everysec') === 'everysec' && this.aofFsyncPending && now - this.aofLastFsync >= 1000) this.fsyncAof();
    }
  }

  // ──────────────────────────────────────────────
  // INFO
  // ──────────────────────────────────────────────

  /** INFO persistence, in Redis's field order. */
  info(): string[] {
    const now = Date.now();
    const job = this.bgsaveJob;
    const lines = [
      `loading:${this.loading ? 1 : 0}`,
      'async_loading:0',
      'current_cow_peak:0',
      'current_cow_size:0',
      'current_cow_size_age:0',
      'current_fork_perc:0.00',
      'current_save_keys_processed:0',
      'current_save_keys_total:0',
      `rdb_changes_since_last_save:${this.dirty}`,
      `rdb_bgsave_in_progress:${job ? 1 : 0}`,
      `rdb_last_save_time:${Math.floor(this.lastSave / 1000)}`,
      `rdb_last_bgsave_status:${this.lastBgsaveStatus}`,
      `rdb_last_bgsave_time_sec:${this.lastBgsaveTimeSec}`,
      `rdb_current_bgsave_time_sec:${job ? Math.floor(now / 1000) - Math.floor(job.startedAt / 1000) : -1}`,
      `rdb_saves:${this.rdbSaves}`,
      'rdb_last_cow_size:0',
      `rdb_last_load_keys_expired:${this.lastLoadKeysExpired}`,
      `rdb_last_load_keys_loaded:${this.lastLoadKeysLoaded}`,
      `aof_enabled:${this.aofState !== 'off' ? 1 : 0}`,
      'aof_rewrite_in_progress:0',
      `aof_rewrite_scheduled:${this.aofRewriteScheduled ? 1 : 0}`,
      `aof_last_rewrite_time_sec:${this.aofLastRewriteTimeSec}`,
      'aof_current_rewrite_time_sec:-1',
      `aof_last_bgrewrite_status:${this.aofLastBgrewriteStatus}`,
      `aof_rewrites:${this.aofRewrites}`,
      `aof_rewrites_consecutive_failures:${this.aofRewritesConsecutiveFailures}`,
      `aof_last_write_status:${this.aofLastWriteStatus}`,
      'aof_last_cow_size:0',
      'module_fork_in_progress:0',
      'module_fork_last_cow_size:0',
    ];
    if (this.aofState !== 'off') {
      lines.push(
        `aof_current_size:${this.aofCurrentSize}`,
        `aof_base_size:${this.aofBaseSize}`,
        `aof_pending_rewrite:${this.aofRewriteScheduled ? 1 : 0}`,
        `aof_buffer_length:${this.aofBuffer.length}`,
        'aof_pending_bio_fsync:0',
        'aof_delayed_fsync:0',
      );
    }
    return lines;
  }
}

export default Persistence;
