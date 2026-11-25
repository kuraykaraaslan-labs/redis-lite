import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import PersistenceService from './persistence.service';
import { PersistenceSnapshot } from './persistence.snapshot';
import type { AofManifest, PropagatedOp } from './persistence.types';

/**
 * AOF layer of the persistence runtime: the multi-part AOF of Redis 7+ (manifest + base + incr files), appends with
 * appendfsync, BGREWRITEAOF and turning the AOF on / off.
 *
 * BGREWRITEAOF runs synchronously (the reply text is still Redis's "…started"), so `aof_rewrite_in_progress` is always
 * 0 and writes never need a rewrite buffer. File layout (Redis 7.0+): <dir>/<appenddirname>/<appendfilename>.manifest,
 * …<n>.base.rdb|aof, …<n>.incr.aof. Temp files are renamed into place (and the directory fsynced) so a crash never
 * leaves a partial file.
 */
export abstract class PersistenceAofWriter extends PersistenceSnapshot {
  // ──────────────────────────────────────────────
  // Appending
  // ──────────────────────────────────────────────

  /** Appends one command (feedAppendOnlyFile), emitting SELECT first when the database changed. */
  feed(dbIndex: number, argv: readonly string[]): void {
    this.feedOps([{ db: dbIndex, argv: [...argv], target: 'all' }]);
  }

  /** Appends a propagated unit (the Propagator's AOF sink). Ops for replicas only are skipped. */
  feedOps(ops: readonly PropagatedOp[]): void {
    if (this.aofState !== 'on' || this.loading) return;
    let out = '';
    for (const o of ops) {
      if (o.target === 'repl') continue;
      if (o.db >= 0 && o.db !== this.aofSelectedDb) {
        out += PersistenceService.encodeAofCommand(['SELECT', String(o.db)]);
        this.aofSelectedDb = o.db;
      }
      out += PersistenceService.encodeAofCommand(o.argv);
    }
    if (!out) return;
    this.aofBuffer += out;
    this.flushAof(false);
  }

  /** Writes the AOF buffer (flushAppendOnlyFile); fsyncs per appendfsync (`force` fsyncs unless 'no'). */
  protected flushAof(force: boolean): void {
    const fd = this.aofFd;
    if (fd === null) return;
    if (this.aofBuffer) {
      const data = Buffer.from(this.aofBuffer, 'latin1');
      let off = 0;
      try {
        while (off < data.length) off += writeSync(fd, data, off, data.length - off);
      } catch (error) {
        // Keep what was not written for the next attempt (serverCron retries); deny writes meanwhile.
        this.aofBuffer = data.subarray(off).toString('latin1');
        this.aofIncrSize += off;
        this.aofCurrentSize += off;
        if (this.aofLastWriteStatus === 'ok') this.host.log('warn', '[Persistence.flushAof] Error writing to the AOF file', { error: PersistenceService.strerror(error) });
        this.aofLastWriteStatus = 'err';
        this.aofLastWriteError = PersistenceService.strerror(error);
        return;
      }
      this.aofBuffer = '';
      this.aofIncrSize += data.length;
      this.aofCurrentSize += data.length;
      if (this.aofLastWriteStatus === 'err') {
        this.host.log('warn', '[Persistence.flushAof] AOF write error looks solved, Redis can write again');
        this.aofLastWriteStatus = 'ok';
      }
      this.aofFsyncPending = true;
    }
    const policy = this.cfg('appendfsync', 'everysec');
    if (policy === 'always' || (force && policy !== 'no')) this.fsyncAof();
  }

  protected fsyncAof(): void {
    if (this.aofFd === null || !this.aofFsyncPending) return;
    try {
      fsyncSync(this.aofFd);
      this.aofFsyncPending = false;
      this.aofLastFsync = Date.now();
    } catch (error) {
      this.aofLastWriteStatus = 'err';
      this.aofLastWriteError = PersistenceService.strerror(error);
    }
  }

  protected closeAofFd(): void {
    if (this.aofFd === null) return;
    this.flushAof(true);
    try {
      fsyncSync(this.aofFd);
    } catch {
      // ignore
    }
    closeSync(this.aofFd);
    this.aofFd = null;
  }

  // ──────────────────────────────────────────────
  // Manifest and files
  // ──────────────────────────────────────────────

  protected persistManifest(m: AofManifest): void {
    mkdirSync(this.aofDir, { recursive: true });
    PersistenceService.writeAtomicSync(this.manifestPath, join(this.aofDir, `temp-${this.aofName}.manifest`), PersistenceService.formatAofManifest(m));
  }

  /** Reads the manifest; upgrades a pre-7.0 single appendonly.aof into the AOF dir (aofUpgradePrepare). */
  protected loadManifestFromDisk(): AofManifest | null {
    if (existsSync(this.manifestPath)) return PersistenceService.parseAofManifest(readFileSync(this.manifestPath, 'latin1'));
    const legacy = join(this.dir, this.aofName);
    if (existsSync(legacy) && statSync(legacy).isFile()) {
      mkdirSync(this.aofDir, { recursive: true });
      const m = PersistenceService.emptyManifest();
      m.base = { name: this.aofName, seq: 1, type: 'b' };
      m.baseSeq = 1;
      this.persistManifest(m);
      renameSync(legacy, join(this.aofDir, this.aofName));
      PersistenceService.fsyncDir(this.aofDir);
      this.host.log('info', '[Persistence.loadManifestFromDisk] Successfully migrated an old-style AOF into the AOF directory');
      return m;
    }
    return null;
  }

  /** openNewIncrAofForAppend: a new incr file, recorded in the manifest, becomes the append target. */
  protected openNewIncr(m: AofManifest, onStart = false): void {
    const seq = m.incrSeq + 1;
    const name = `${this.aofName}.${seq}.incr.aof`;
    mkdirSync(this.aofDir, { recursive: true });
    const fd = openSync(join(this.aofDir, name), 'a');
    m.incr.push({ name, seq, type: 'i' });
    m.incrSeq = seq;
    this.persistManifest(m);
    this.closeAofFd();
    this.aofFd = fd;
    this.aofSelectedDb = -1;
    this.aofIncrSize = 0;
    if (onStart) this.host.log('info', '[Persistence.openNewIncr] Creating AOF incr file on server start', { file: name });
  }

  /** aofOpenIfNeededOnServerStart: empty dataset → create a base file; then open (or create) the last incr file. */
  protected openAofOnStart(): void {
    let m = this.manifest ?? PersistenceService.emptyManifest();
    if (!m.base && !m.incr.length) {
      const name = this.writeNewBase(m);
      this.host.log('info', '[Persistence.openAofOnStart] Creating AOF base file on server start', { file: name });
      m = this.manifest ?? m;
    }
    const last = m.incr[m.incr.length - 1];
    if (last) {
      this.aofFd = openSync(join(this.aofDir, last.name), 'a');
      this.aofSelectedDb = -1;
    } else this.openNewIncr(m, true);
    this.manifest = m;
  }

  /** Writes a new base file (seq + 1) from the current dataset and records it in `m` (old base → history). */
  protected writeNewBase(m: AofManifest): string {
    mkdirSync(this.aofDir, { recursive: true });
    const preamble = this.cfg('aof-use-rdb-preamble', 'yes') === 'yes';
    const content: Buffer | string = preamble ? this.buildRdb(true) : PersistenceService.snapshotToAof(this.snapshot());
    const seq = m.baseSeq + 1;
    const name = `${this.aofName}.${seq}.base.${preamble ? 'rdb' : 'aof'}`;
    PersistenceService.writeAtomicSync(join(this.aofDir, name), join(this.aofDir, `temp-rewriteaof-bg-${process.pid}.aof`), content);
    if (m.base) m.history.push({ ...m.base, type: 'h' });
    m.base = { name, seq, type: 'b' };
    m.baseSeq = seq;
    this.persistManifest(m);
    this.manifest = m;
    this.aofBaseSize = content.length;
    this.aofCurrentSize = content.length + this.aofIncrSize;
    return name;
  }

  /** aofDelHistoryFiles: removes history files and drops them from the manifest. */
  protected deleteHistoryFiles(): void {
    const m = this.manifest;
    if (!m || !m.history.length) return;
    for (const h of m.history) {
      PersistenceService.tryUnlink(join(this.aofDir, h.name));
      this.host.log('info', '[Persistence.deleteHistoryFiles] Removing the history file in the background', { file: h.name });
    }
    m.history = [];
    this.persistManifest(m);
  }

  // ──────────────────────────────────────────────
  // Rewrite, on / off
  // ──────────────────────────────────────────────

  /**
   * BGREWRITEAOF, synchronously: switch appends to a fresh incr file (when AOF is on), write a new base (RDB preamble
   * when aof-use-rdb-preamble yes), mark the old base and the incr files it covers as history, persist the manifest
   * and delete the history files. With AOF off only a base + manifest are produced (no incr file), like Redis.
   */
  rewriteAof(): boolean {
    const started = Date.now();
    try {
      mkdirSync(this.aofDir, { recursive: true });
      const m = this.manifest ?? this.loadManifestFromDisk() ?? PersistenceService.emptyManifest();
      this.manifest = m;
      const on = this.aofState !== 'off';
      if (on) {
        this.flushAof(true);
        this.openNewIncr(m);
      }
      // markRewrittenIncrAofAsHistory: every incr file but the one being written (all of them when AOF is off).
      const keep = on ? m.incr.slice(-1) : [];
      const covered = on ? m.incr.slice(0, -1) : m.incr;
      this.writeNewBase(m);
      for (const i of covered) m.history.push({ ...i, type: 'h' });
      m.incr = keep;
      this.persistManifest(m);
      this.deleteHistoryFiles();
      if (this.aofState === 'wait_rewrite') {
        this.aofState = 'on';
        this.host.log('info', '[Persistence.rewriteAof] Background AOF rewrite finished successfully');
      }
      this.aofCurrentSize = this.aofBaseSize + this.aofIncrSize;
    } catch (error) {
      this.host.log('warn', '[Persistence.rewriteAof] Background AOF rewrite failed', { error: PersistenceService.strerror(error) });
      this.aofLastBgrewriteStatus = 'err';
      this.aofRewritesConsecutiveFailures++;
      return false;
    }
    this.host.log('info', '[Persistence.rewriteAof] Background append only file rewriting started');
    this.host.log('info', '[Persistence.rewriteAof] Background AOF rewrite terminated with success');
    this.aofRewrites++;
    this.aofRewritesConsecutiveFailures = 0;
    this.aofLastBgrewriteStatus = 'ok';
    this.aofLastRewriteTimeSec = Math.floor(Date.now() / 1000) - Math.floor(started / 1000);
    return true;
  }

  /** startAppendOnly (CONFIG SET appendonly yes). */
  protected startAppendOnly(): boolean {
    this.aofState = 'wait_rewrite';
    if (this.bgsaveJob) {
      this.aofRewriteScheduled = true;
      this.host.log('info', '[Persistence.startAppendOnly] AOF enabled while another background operation runs: the rewrite is scheduled');
      return true;
    }
    if (!this.rewriteAof()) {
      this.aofState = 'off';
      this.host.log('warn', "[Persistence.startAppendOnly] Can't trigger the background AOF rewrite needed to enable the AOF");
      return false;
    }
    if (this.aofFd === null && this.manifest) this.openNewIncr(this.manifest);
    this.aofState = 'on';
    return true;
  }

  /** stopAppendOnly (CONFIG SET appendonly no). */
  protected stopAppendOnly(): void {
    this.closeAofFd();
    this.aofState = 'off';
    this.aofRewriteScheduled = false;
    this.aofBuffer = '';
  }

  protected runScheduled(): void {
    if (this.bgsaveJob) return;
    if (this.aofRewriteScheduled) {
      this.aofRewriteScheduled = false;
      this.rewriteAof();
      if (this.aofState === 'wait_rewrite' && this.manifest) {
        if (this.aofFd === null) this.openNewIncr(this.manifest);
        this.aofState = 'on';
      }
    }
  }
}
