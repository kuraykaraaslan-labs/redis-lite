import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { PersistenceErrnoMessages } from './persistence.messages';

/** Crash-safe file primitives (temp file + fsync + rename + directory fsync) and strerror() for disk errors. */
export default class PersistenceFilesService {
  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The strerror() text Redis prints for a failed file operation. */
  static strerror(error: unknown): string {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return (code && PersistenceErrnoMessages[code]) || (error as Error | undefined)?.message || String(error);
  }

  /** Writes `buf` to `path` through `tmp` + fsync + rename, then fsyncs the directory. */
  static writeAtomicSync(path: string, tmp: string, buf: Buffer | string): void {
    const fd = openSync(tmp, 'w');
    try {
      const data = typeof buf === 'string' ? Buffer.from(buf, 'latin1') : buf;
      let off = 0;
      while (off < data.length) off += writeSync(fd, data, off, data.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    PersistenceFilesService.fsyncDir(join(path, '..'));
  }

  static fsyncDir(dir: string): void {
    try {
      const fd = openSync(dir, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Not supported everywhere (Windows); Redis ignores this too on platforms without it.
    }
  }

  static tryUnlink(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
}
