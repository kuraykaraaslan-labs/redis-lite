import { existsSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { basename, join } from 'node:path';

import { formatMessage } from '@/libs/message-format';
import { RespError } from '@/libs/resp';

import { PersistenceAofWriter } from './persistence.aof_writer';
import PersistenceMessages from './persistence.messages';
import PersistenceService from './persistence.service';
import type { AofManifest, LoadResult, RdbFile } from './persistence.types';

/**
 * AOF replay layer of the persistence runtime: loads the base (RDB preamble or commands) and incr files listed in the
 * manifest, honouring MULTI/EXEC blocks, annotations and aof-load-truncated.
 */
export abstract class PersistenceAofLoader extends PersistenceAofWriter {
  // ──────────────────────────────────────────────
  // Loading
  // ──────────────────────────────────────────────

  protected loadAof(m: AofManifest): LoadResult {
    return this.withLoading(() => {
      this.lastLoadKeysLoaded = 0;
      this.lastLoadKeysExpired = 0;
      const files = [...(m.base ? [m.base] : []), ...m.incr];
      let total = 0;
      files.forEach((info, i) => {
        const path = join(this.aofDir, info.name);
        if (!existsSync(path)) {
          // A missing last incr file is treated as empty (it is created when opened for append); any other is fatal.
          if (info.type === 'i' && i === files.length - 1) return;
          throw new Error(formatMessage(PersistenceMessages.AOF_FILE_MISSING, { file: info.name }));
        }
        const buf = readFileSync(path);
        total += buf.length;
        if (info.type === 'b') this.aofBaseSize = buf.length;
        this.loadAofBuffer(buf, path, i === files.length - 1);
      });
      this.aofCurrentSize = total;
      this.aofIncrSize = 0;
      const last = m.incr[m.incr.length - 1];
      if (last) {
        const p = join(this.aofDir, last.name);
        if (existsSync(p)) this.aofIncrSize = statSync(p).size;
      }
      return { source: 'aof' as const, keysLoaded: this.lastLoadKeysLoaded, keysExpired: this.lastLoadKeysExpired };
    });
  }

  /** Loads one AOF file: an optional RDB preamble, then RESP commands. Handles a truncated tail on the last file. */
  private loadAofBuffer(buf: Buffer, path: string, isLast: boolean): void {
    const file = basename(path);
    let start = 0;
    if (buf.length >= 5 && buf.toString('latin1', 0, 5) === 'REDIS') {
      // Base files written by Redis 7+ are pure RDB; a pre-7.0 single file may continue with commands.
      let rdb: RdbFile;
      try {
        rdb = PersistenceService.readRdb(buf);
        start = buf.length;
      } catch {
        start = PersistenceService.rdbLength(buf);
        rdb = PersistenceService.readRdb(buf.subarray(0, start));
      }
      this.loadRdbFile(rdb, true);
    }
    if (start >= buf.length) return;
    const text = buf.toString('latin1');
    const client = this.host.createInternalClient();
    let pos = start;
    let validUpTo = start;
    let validBeforeMulti = start;
    let multi: string[][] | null = null;
    const run = (argv: string[]): void => {
      const name = argv[0].toLowerCase();
      if (name === 'select') {
        const n = Number(argv[1]);
        if (!Number.isInteger(n) || n < 0 || n >= this.host.databases.length) throw new Error(formatMessage(PersistenceMessages.AOF_BAD_SELECT, { file }));
        client.dbIndex = n;
        return;
      }
      const r = this.host.execute(client, argv, { inScript: false, noBlock: true });
      if (r instanceof RespError) {
        if (/^ERR unknown command/.test(r.message)) throw new Error(formatMessage(PersistenceMessages.AOF_UNKNOWN_COMMAND, { command: argv[0], file }));
        this.host.log('warn', '[Persistence.loadAofBuffer] Error executing a command from the append only file', { command: argv[0], file, error: r.message });
      }
    };
    let truncated = false;
    while (pos < text.length) {
      if (text[pos] === '#') {
        // Annotations (aof-timestamp-enabled): a line starting with '#'.
        const nl = text.indexOf('\n', pos);
        if (nl < 0) {
          truncated = true;
          break;
        }
        pos = nl + 1;
        if (!multi) validUpTo = pos;
        continue;
      }
      const step = PersistenceService.parseAofCommand(text, pos);
      if ('error' in step) throw new Error(formatMessage(PersistenceMessages.AOF_BAD_FORMAT_IN, { error: step.error, file }));
      if ('incomplete' in step) {
        truncated = true;
        break;
      }
      pos = step.next;
      const name = step.argv[0].toLowerCase();
      if (multi === null && name === 'multi') {
        multi = [];
        validBeforeMulti = validUpTo;
      } else if (multi !== null && name === 'exec') {
        const queued: string[][] = multi;
        multi = null;
        for (const argv of queued) run(argv);
      } else if (multi !== null) multi.push(step.argv);
      else run(step.argv);
      if (multi === null) validUpTo = pos;
    }
    if (multi !== null) {
      this.host.log('warn', '[Persistence.loadAofBuffer] Revert incomplete MULTI/EXEC transaction in AOF file');
      validUpTo = validBeforeMulti;
      truncated = true;
    }
    if (truncated) {
      if (!isLast || this.cfg('aof-load-truncated', 'yes') !== 'yes') {
        throw new Error(formatMessage(PersistenceMessages.AOF_UNEXPECTED_EOF, { file }));
      }
      this.host.log('warn', '[Persistence.loadAofBuffer] Short read while loading the AOF file', { file });
      this.host.log('warn', '[Persistence.loadAofBuffer] Truncating the AOF', { file, offset: validUpTo });
      truncateSync(path, validUpTo);
      this.host.log('warn', '[Persistence.loadAofBuffer] AOF loaded anyway because aof-load-truncated is enabled', { file });
    }
  }
}
