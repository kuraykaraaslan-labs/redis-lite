import { statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { formatMessage } from '@/libs/message-format';

import ServerMessages from './server.messages';

/** File-system helpers with Redis's error texts (the `dir` config, the ACL file). */
export class ServerFiles {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  private static readonly ERRNO_TEXTS: Record<string, string> = {
    ENOENT: ServerMessages.ERRNO_ENOENT,
    EACCES: ServerMessages.ERRNO_EACCES,
    EISDIR: ServerMessages.ERRNO_EISDIR,
    ENOTDIR: ServerMessages.ERRNO_ENOTDIR,
    EROFS: ServerMessages.ERRNO_EROFS,
    ENOSPC: ServerMessages.ERRNO_ENOSPC,
  };

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** strerror() text of a failed file operation. */
  static strerror(e: unknown): string {
    const code = (e as NodeJS.ErrnoException).code;
    return (code && ServerFiles.ERRNO_TEXTS[code]) ?? (e as Error).message;
  }

  /** Redis chdir()s into `dir`: it must be an existing directory. The absolute path, or the strerror text. */
  static resolveDir(dir: string): { path: string } | { error: string } {
    const path = resolvePath(dir);
    try {
      if (!statSync(path).isDirectory()) return { error: ServerMessages.ERRNO_ENOTDIR };
    } catch (e) {
      return { error: ServerFiles.strerror(e) };
    }
    return { path };
  }

  /** resolveDir() for startup configs: a bad directory is fatal. */
  static checkDir(dir: string): string {
    const r = ServerFiles.resolveDir(dir);
    if ('error' in r) throw new Error(formatMessage(ServerMessages.CHDIR_FAILED, { dir, error: r.error }));
    return r.path;
  }
}
