/**
 * Persistence: RDB snapshots (SAVE / BGSAVE / save points), the multi-part AOF of Redis 7+ (manifest + base + incr files,
 * BGREWRITEAOF, appendfsync), loading at startup, DEBUG RELOAD / LOADAOF and the INFO persistence section.
 *
 * Redis forks for BGSAVE / BGREWRITEAOF. Here:
 * - BGSAVE serializes the dataset synchronously (that is the point-in-time snapshot a fork gives) and writes the file
 *   asynchronously, so `rdb_bgsave_in_progress` is 1 until the write lands, like Redis.
 * - BGREWRITEAOF runs synchronously (the reply text is still Redis's "…started"), so `aof_rewrite_in_progress` is
 *   always 0 and writes never need a rewrite buffer.
 *
 * File layout (Redis 7.0+): <dir>/<dbfilename>; <dir>/<appenddirname>/<appendfilename>.manifest, …<n>.base.rdb|aof,
 * …<n>.incr.aof. Temp files are renamed into place (and the directory fsynced) so a crash never leaves a partial file.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { CommandError } from '@/libs/app-error';
import type { Reply } from '@/libs/resp';
import { OK, RespError, Status } from '@/libs/resp';
import type { LogContext, LogLevelName } from '@/libs/logger';

import { hashFieldExpires, setHashFieldExpires } from '@/modules/hashes/hashes.commands';
import type { LuaEngine } from '@/modules/scripting/scripting.engine';
import type { Database, RedisValue } from '@/modules/database/database.core';
import { idToString } from '@/modules/streams/streams.structure';
import type { Client } from '@/modules/server/server.client';
import type { ServerConfig } from '@/modules/server/server.config';

import { defaultRdbAux, readRdb, writeRdb } from './persistence.rdb';
import type { FieldExpires, RdbDatabase, RdbFile, RdbKeyEntry, RdbOptions } from './persistence.rdb';
import { Propagator } from './persistence.propagate';
import type { PropagatedOp } from './persistence.propagate';

/** What Persistence needs from the server. RedisLiteServer satisfies it structurally. */
export interface PersistenceHost {
  readonly databases: Database[];
  readonly config: ServerConfig;
  /** Needed to save / load FUNCTION libraries; undefined before the engine is created. */
  readonly lua?: LuaEngine;
  execute(client: Client, argv: string[], mode: { inScript: boolean; noBlock: boolean }): unknown;
  createInternalClient(): Client;
  log(level: LogLevelName, message: string, context?: LogContext): void;
  /** Invalidates WATCHes on a database about to be emptied (DEBUG RELOAD / LOADAOF). */
  signalFlushedDb?(dbIndex: number): void;
}

export type BgStatus = 'ok' | 'err';
export type AofState = 'off' | 'on' | 'wait_rewrite';

/** One manifest line: `file <name> seq <n> type <b|h|i>`. */
export interface AofInfo {
  name: string;
  seq: number;
  type: 'b' | 'h' | 'i';
}

export interface AofManifest {
  base: AofInfo | null;
  incr: AofInfo[];
  history: AofInfo[];
  /** Highest base / incr sequence used so far. */
  baseSeq: number;
  incrSeq: number;
}

export interface LoadResult {
  source: 'aof' | 'rdb' | 'none';
  keysLoaded: number;
  keysExpired: number;
}

// ---- RESP / AOF text -------------------------------------------------------------------------------------------

/** One command as RESP multibulk (latin1 binary string), the AOF record format. */
export function encodeAofCommand(argv: readonly string[]): string {
  let out = `*${argv.length}\r\n`;
  for (const a of argv) out += `$${a.length}\r\n${a}\r\n`;
  return out;
}

export type AofParseStep = { argv: string[]; next: number } | { incomplete: true } | { error: string };

/** Parses one AOF record starting at `pos`. `incomplete`: the file ends inside the record. */
export function parseAofCommand(text: string, pos: number): AofParseStep {
  const line = (from: number): { value: string; next: number } | null => {
    const nl = text.indexOf('\r\n', from);
    return nl < 0 ? null : { value: text.slice(from, nl), next: nl + 2 };
  };
  if (text[pos] !== '*') return { error: 'Bad file format reading the append only file' };
  const head = line(pos + 1);
  if (!head) return { incomplete: true };
  const argc = Number(head.value);
  if (!Number.isInteger(argc) || argc < 1) return { error: 'Bad file format reading the append only file' };
  let p = head.next;
  const argv: string[] = [];
  for (let i = 0; i < argc; i++) {
    if (p >= text.length) return { incomplete: true };
    if (text[p] !== '$') return { error: 'Bad file format reading the append only file' };
    const len = line(p + 1);
    if (!len) return { incomplete: true };
    const n = Number(len.value);
    if (!Number.isInteger(n) || n < 0) return { error: 'Bad file format reading the append only file' };
    if (len.next + n + 2 > text.length) return { incomplete: true };
    if (text.slice(len.next + n, len.next + n + 2) !== '\r\n') return { error: 'Bad file format reading the append only file' };
    argv.push(text.slice(len.next, len.next + n));
    p = len.next + n + 2;
  }
  return { argv, next: p };
}

/** C printf("%.17g"): the score format Redis uses when rewriting ZADD into an AOF. */
export function formatG17(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  if (n === 0) return Object.is(n, -0) ? '-0' : '0';
  const exp = Number(n.toExponential(16).split('e')[1]);
  if (exp < -4 || exp >= 17) {
    const [mant, e] = n.toExponential(16).split('e');
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    const ev = Number(e);
    return `${m}e${ev < 0 ? '-' : '+'}${String(Math.abs(ev)).padStart(2, '0')}`;
  }
  const fixed = n.toFixed(Math.max(0, 16 - exp));
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

// ---- manifest --------------------------------------------------------------------------------------------------

/** sdssplitargs(): space-separated words, "double quoted" with C escapes or 'single quoted'. */
export function splitArgs(line: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let cur = '';
    if (line[i] === '"') {
      i++;
      let closed = false;
      while (i < line.length) {
        const c = line[i];
        if (c === '\\' && i + 1 < line.length) {
          const nx = line[i + 1];
          if (nx === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
            cur += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' };
          cur += map[nx] ?? nx;
          i += 2;
        } else if (c === '"') {
          closed = true;
          i++;
          break;
        } else {
          cur += c;
          i++;
        }
      }
      if (!closed || (i < line.length && !/\s/.test(line[i]))) return null;
    } else if (line[i] === "'") {
      i++;
      let closed = false;
      while (i < line.length) {
        if (line[i] === '\\' && line[i + 1] === "'") {
          cur += "'";
          i += 2;
        } else if (line[i] === "'") {
          closed = true;
          i++;
          break;
        } else cur += line[i++];
      }
      if (!closed) return null;
    } else {
      while (i < line.length && !/\s/.test(line[i])) cur += line[i++];
    }
    out.push(cur);
  }
  return out;
}

/** sdscatrepr() when the name needs it (spaces, quotes, non-printables), as getAofManifestAsString does. */
function manifestName(name: string): string {
  if (!/[\s"'\\\x00-\x1f\x7f-\xff]/.test(name)) return name;
  const esc: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\x07': '\\a', '\b': '\\b' };
  return `"${name.replace(/[\\"\x00-\x1f\x7f-\xff]/g, (c) => esc[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}"`;
}

export function emptyManifest(): AofManifest {
  return { base: null, incr: [], history: [], baseSeq: 0, incrSeq: 0 };
}

/** Parses a manifest; throws 'Invalid AOF manifest file format' like Redis. */
export function parseAofManifest(text: string): AofManifest {
  const m = emptyManifest();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const args = splitArgs(line);
    if (!args || args.length % 2) throw new Error('Invalid AOF manifest file format');
    const kv = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) kv.set(args[i], args[i + 1]);
    const name = kv.get('file');
    const seq = Number(kv.get('seq'));
    const type = kv.get('type');
    if (!name || !Number.isInteger(seq) || (type !== 'b' && type !== 'h' && type !== 'i')) throw new Error('Invalid AOF manifest file format');
    const info: AofInfo = { name, seq, type };
    if (type === 'b') {
      if (m.base) throw new Error('Found duplicate base file information');
      m.base = info;
      m.baseSeq = seq;
    } else if (type === 'h') m.history.push(info);
    else {
      if (seq <= m.incrSeq) throw new Error('Found a non-monotonic sequence number');
      m.incr.push(info);
      m.incrSeq = seq;
    }
  }
  return m;
}

/** getAofManifestAsString: base, then history, then incr files. */
export function formatAofManifest(m: AofManifest): string {
  const line = (i: AofInfo): string => `file ${manifestName(i.name)} seq ${i.seq} type ${i.type}\n`;
  return [...(m.base ? [m.base] : []), ...m.history, ...m.incr].map(line).join('');
}

// ---- snapshot → AOF commands -----------------------------------------------------------------------------------

/** Redis AOF_REWRITE_ITEMS_PER_CMD. */
const ITEMS_PER_CMD = 64;

export interface Snapshot {
  dbs: RdbDatabase[];
  functions: string[];
}

function pushBatched(out: string[], head: string[], itemsFlat: string[], width: number): void {
  const per = ITEMS_PER_CMD * width;
  for (let i = 0; i < itemsFlat.length; i += per) out.push(encodeAofCommand([...head, ...itemsFlat.slice(i, i + per)]));
}

function rewriteKey(out: string[], key: string, e: RdbKeyEntry): void {
  const v = e.value;
  switch (v.type) {
    case 'string':
      out.push(encodeAofCommand(['SET', key, v.value]));
      break;
    case 'list':
      pushBatched(out, ['RPUSH', key], v.value, 1);
      break;
    case 'set':
      pushBatched(out, ['SADD', key], [...v.value], 1);
      break;
    case 'zset':
      pushBatched(out, ['ZADD', key], v.value.entries.flatMap((z) => [formatG17(z.score), z.member]), 2);
      break;
    case 'hash': {
      pushBatched(out, ['HMSET', key], [...v.value].flat(), 2);
      // UNCERTAIN: Redis 7.4's rewriteHashObject field-TTL form; one HPEXPIREAT per field is equivalent.
      for (const [f, at] of e.fieldExpires ?? []) out.push(encodeAofCommand(['HPEXPIREAT', key, String(at), 'FIELDS', '1', f]));
      break;
    }
    case 'stream': {
      const s = v.value;
      const lastId = idToString(s.lastId);
      if (s.length) for (const entry of s.entries) out.push(encodeAofCommand(['XADD', key, idToString(entry.id), ...entry.fields]));
      else out.push(encodeAofCommand(['XADD', key, 'MAXLEN', '0', lastId, 'x', 'y']));
      out.push(encodeAofCommand(['XSETID', key, lastId, 'ENTRIESADDED', String(s.entriesAdded), 'MAXDELETEDID', idToString(s.maxDeletedId)]));
      for (const g of s.groups.values()) {
        out.push(encodeAofCommand(['XGROUP', 'CREATE', key, g.name, idToString(g.lastId), 'ENTRIESREAD', String(g.entriesRead ?? -1)]));
        for (const c of g.consumers.values()) {
          if (!c.pending.size) {
            out.push(encodeAofCommand(['XGROUP', 'CREATECONSUMER', key, g.name, c.name]));
            continue;
          }
          for (const p of c.pending.values()) {
            out.push(
              encodeAofCommand(['XCLAIM', key, g.name, c.name, '0', idToString(p.id), 'TIME', String(p.deliveryTime), 'RETRYCOUNT', String(p.deliveryCount), 'JUSTID', 'FORCE']),
            );
          }
        }
      }
      break;
    }
  }
  if (e.expireAt !== undefined) out.push(encodeAofCommand(['PEXPIREAT', key, String(e.expireAt)]));
}

/** A base AOF in command form (aof-use-rdb-preamble no): FUNCTION LOADs, then per database SELECT + its keys. */
export function snapshotToAof(snap: Snapshot): string {
  const out: string[] = [];
  for (const code of snap.functions) out.push(encodeAofCommand(['FUNCTION', 'LOAD', code]));
  snap.dbs.forEach((db, i) => {
    if (!db.size) return;
    out.push(encodeAofCommand(['SELECT', String(i)]));
    for (const [key, e] of db) rewriteKey(out, key, e);
  });
  return out.join('');
}

// ---- errors ------------------------------------------------------------------------------------------------------

const STRERROR: Record<string, string> = {
  ENOSPC: 'No space left on device',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  EIO: 'Input/output error',
  EBADF: 'Bad file descriptor',
  EROFS: 'Read-only file system',
  EDQUOT: 'Disk quota exceeded',
  ENOENT: 'No such file or directory',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
};

function strerror(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (code && STRERROR[code]) || (error as Error | undefined)?.message || String(error);
}

const RDB_MISCONF =
  "MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist to disk. Commands that may modify the data set are disabled, because this instance is configured to report errors during writes if RDB snapshotting fails (stop-writes-on-bgsave-error option). Please check the Redis logs for details about the RDB error.";

/** Redis CONFIG_BGSAVE_RETRY_DELAY (seconds). */
const BGSAVE_RETRY_DELAY = 5;

interface BgsaveJob {
  startedAt: number;
  cancelled: boolean;
  tmp: string;
  done: Promise<void>;
}

/** Writes `buf` to `path` through `tmp` + fsync + rename, then fsyncs the directory. */
function writeAtomicSync(path: string, tmp: string, buf: Buffer | string): void {
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
  fsyncDir(join(path, '..'));
}

function fsyncDir(dir: string): void {
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

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class Persistence {
  /** Changes since the last successful save (INFO rdb_changes_since_last_save). */
  dirty = 0;
  /** Unix ms of the last successful save (LASTSAVE). */
  lastSave = Date.now();
  /** True while loading the RDB / AOF. */
  loading = false;

  /** Propagation of executed commands; the AOF is one of its sinks (replication can add another). */
  readonly propagator: Propagator;

  // RDB
  private lastBgsaveStatus: BgStatus = 'ok';
  private lastBgsaveTry = 0;
  private lastBgsaveTimeSec = -1;
  private rdbSaves = 0;
  private bgsaveJob: BgsaveJob | null = null;
  private bgsaveScheduled = false;
  private dirtyBeforeBgsave = 0;
  private bgsaveCounter = 0;
  private lastLoadKeysLoaded = 0;
  private lastLoadKeysExpired = 0;

  // AOF
  private aofState: AofState = 'off';
  private manifest: AofManifest | null = null;
  private aofFd: number | null = null;
  private aofSelectedDb = -1;
  private aofBuffer = '';
  private aofFsyncPending = false;
  private aofLastFsync = 0;
  private aofLastWriteStatus: BgStatus = 'ok';
  private aofLastWriteError = '';
  private aofRewriteScheduled = false;
  private aofRewrites = 0;
  private aofRewritesConsecutiveFailures = 0;
  private aofLastRewriteTimeSec = -1;
  private aofLastBgrewriteStatus: BgStatus = 'ok';
  private aofCurrentSize = 0;
  private aofBaseSize = 0;
  private aofIncrSize = 0;

  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly host: PersistenceHost) {
    this.propagator = new Propagator({ databases: host.databases, config: host.config });
    this.propagator.addSink((ops) => this.feedOps(ops));
  }

  // ---- paths / config ----------------------------------------------------------------------------------------

  private cfg(name: string, fallback = ''): string {
    return this.host.config.get(name) ?? fallback;
  }

  private get dir(): string {
    return this.cfg('dir', process.cwd());
  }

  get rdbPath(): string {
    return join(this.dir, this.cfg('dbfilename', 'dump.rdb'));
  }

  get aofDir(): string {
    return join(this.dir, this.cfg('appenddirname', 'appendonlydir'));
  }

  private get aofName(): string {
    return this.cfg('appendfilename', 'appendonly.aof');
  }

  private get manifestPath(): string {
    return join(this.aofDir, `${this.aofName}.manifest`);
  }

  private rdbOptions(): Partial<RdbOptions> {
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
  private savePoints(): Array<[number, number]> {
    const parts = this.cfg('save').split(' ').filter(Boolean).map(Number);
    const out: Array<[number, number]> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push([parts[i], parts[i + 1]]);
    return out;
  }

  // ---- dirty counter -----------------------------------------------------------------------------------------

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

  // ---- snapshot ------------------------------------------------------------------------------------------------

  /** The dataset as RDB entries: live keys with TTLs, hash field TTLs (expired fields dropped), LRU/LFU info. */
  snapshot(): Snapshot {
    const now = Date.now();
    const policy = this.cfg('maxmemory-policy');
    const lfu = policy.includes('lfu');
    const lru = policy.includes('lru');
    const dbs: RdbDatabase[] = this.host.databases.map((db) => {
      const out: RdbDatabase = new Map();
      for (const key of db.keys()) {
        let value = db.peek(key);
        if (!value) continue;
        const entry: RdbKeyEntry = { value };
        const at = db.getExpire(key);
        if (at !== undefined) entry.expireAt = at;
        if (value.type === 'hash') {
          const ttl = hashFieldExpires(value.value);
          if (ttl) {
            const live: FieldExpires = new Map();
            let expired = false;
            for (const [f, t] of ttl) {
              if (!value.value.has(f)) continue;
              if (t <= now) expired = true;
              else live.set(f, t);
            }
            if (expired) {
              const h = new Map([...value.value].filter(([f]) => (ttl.get(f) ?? Infinity) > now));
              if (!h.size) continue;
              value = { type: 'hash', value: h };
              entry.value = value;
            }
            if (live.size) entry.fieldExpires = live;
          }
        }
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
    const aux = defaultRdbAux({ aofBase, usedMem: process.memoryUsage().rss });
    return writeRdb(snap.dbs, aux, snap.functions, this.rdbOptions());
  }

  // ---- loading -------------------------------------------------------------------------------------------------

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

  private loadRdbPath(path: string): LoadResult {
    const keys = this.withLoading(() => this.loadRdbBuffer(readFileSync(path), false));
    return { source: 'rdb', ...keys };
  }

  private withLoading<T>(fn: () => T): T {
    this.loading = true;
    this.propagator.pause();
    try {
      return fn();
    } finally {
      this.propagator.resume();
      this.loading = false;
    }
  }

  /**
   * Loads an RDB image into the databases (existing keys are replaced, like RDBFLAGS_ALLOW_DUP). Keys already expired
   * are skipped unless `preamble` (Redis loads them from an AOF preamble and lets them expire). UNCERTAIN: expired hash
   * fields are skipped on load too (Redis 7.4+ master behaviour, as recalled).
   */
  loadRdbBuffer(buf: Buffer, preamble: boolean): { keysLoaded: number; keysExpired: number } {
    return this.loadRdbFile(readRdb(buf), preamble);
  }

  private loadRdbFile(file: RdbFile, preamble: boolean): { keysLoaded: number; keysExpired: number } {
    const dbs = this.host.databases;
    if (file.dbs.length > dbs.length) {
      throw new Error(`FATAL: Data file was created with a Redis server configured to handle more than ${dbs.length} databases. Exiting`);
    }
    if (file.functions.length) {
      const lua = this.host.lua;
      if (!lua) throw new Error('Cannot load functions: the scripting engine is not ready');
      for (const code of file.functions) lua.loadLibrary(code, true);
    }
    const now = Date.now();
    const lfu = this.cfg('maxmemory-policy').includes('lfu');
    let keysLoaded = 0;
    let keysExpired = 0;
    file.dbs.forEach((entries, i) => {
      const db = dbs[i];
      for (const [key, e] of entries) {
        if (!preamble && e.expireAt !== undefined && e.expireAt <= now) {
          keysExpired++;
          continue;
        }
        let value: RedisValue = e.value;
        let fields = e.fieldExpires;
        if (value.type === 'hash' && fields && !preamble) {
          const h = value.value;
          const live: FieldExpires = new Map();
          for (const [f, t] of fields) {
            if (t <= now) h.delete(f);
            else live.set(f, t);
          }
          fields = live;
          if (!h.size) {
            keysExpired++;
            continue;
          }
          value = { type: 'hash', value: h };
        }
        db.set(key, value);
        if (value.type === 'hash' && fields && fields.size) setHashFieldExpires(value.value, fields);
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

  /** Reads the manifest; upgrades a pre-7.0 single appendonly.aof into the AOF dir (aofUpgradePrepare). */
  private loadManifestFromDisk(): AofManifest | null {
    if (existsSync(this.manifestPath)) return parseAofManifest(readFileSync(this.manifestPath, 'latin1'));
    const legacy = join(this.dir, this.aofName);
    if (existsSync(legacy) && statSync(legacy).isFile()) {
      mkdirSync(this.aofDir, { recursive: true });
      const m = emptyManifest();
      m.base = { name: this.aofName, seq: 1, type: 'b' };
      m.baseSeq = 1;
      this.persistManifest(m);
      renameSync(legacy, join(this.aofDir, this.aofName));
      fsyncDir(this.aofDir);
      this.host.log('info', '[Persistence.loadManifestFromDisk] Successfully migrated an old-style AOF into the AOF directory');
      return m;
    }
    return null;
  }

  private loadAof(m: AofManifest): LoadResult {
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
          throw new Error(`The AOF file ${info.name} doesn't exist`);
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

  /** Byte length of the RDB at the start of `buf` (the only cut point where the parse reaches EOF). */
  private static rdbLength(buf: Buffer): number {
    for (let p = 9; p + 9 <= buf.length; p++) {
      if (buf[p] !== 0xff) continue;
      try {
        readRdb(buf.subarray(0, p + 9));
        return p + 9;
      } catch {
        // not the EOF opcode
      }
    }
    return buf.length;
  }

  /** Loads one AOF file: an optional RDB preamble, then RESP commands. Handles a truncated tail on the last file. */
  private loadAofBuffer(buf: Buffer, path: string, isLast: boolean): void {
    let start = 0;
    if (buf.length >= 5 && buf.toString('latin1', 0, 5) === 'REDIS') {
      // Base files written by Redis 7+ are pure RDB; a pre-7.0 single file may continue with commands.
      let file: RdbFile;
      try {
        file = readRdb(buf);
        start = buf.length;
      } catch {
        start = Persistence.rdbLength(buf);
        file = readRdb(buf.subarray(0, start));
      }
      this.loadRdbFile(file, true);
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
        if (!Number.isInteger(n) || n < 0 || n >= this.host.databases.length) throw new Error(`Bad SELECT index in the append only file ${basename(path)}`);
        client.dbIndex = n;
        return;
      }
      const r = this.host.execute(client, argv, { inScript: false, noBlock: true });
      if (r instanceof RespError) {
        if (/^ERR unknown command/.test(r.message)) throw new Error(`Unknown command '${argv[0]}' reading the append only file ${basename(path)}`);
        this.host.log('warn', '[Persistence.loadAofBuffer] Error executing a command from the append only file', { command: argv[0], file: basename(path), error: r.message });
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
      const step = parseAofCommand(text, pos);
      if ('error' in step) throw new Error(`${step.error} ${basename(path)}`);
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
        throw new Error(`Unexpected end of file reading the append only file ${basename(path)}. You can: 1) Make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>. 2) Alternatively you can set the 'aof-load-truncated' configuration option to yes and restart the server.`);
      }
      this.host.log('warn', '[Persistence.loadAofBuffer] Short read while loading the AOF file', { file: basename(path) });
      this.host.log('warn', '[Persistence.loadAofBuffer] Truncating the AOF', { file: basename(path), offset: validUpTo });
      truncateSync(path, validUpTo);
      this.host.log('warn', '[Persistence.loadAofBuffer] AOF loaded anyway because aof-load-truncated is enabled', { file: basename(path) });
    }
  }

  /** Flushes every database and every function library (Redis emptyData). */
  private emptyData(): void {
    this.host.databases.forEach((db, i) => {
      this.host.signalFlushedDb?.(i);
      db.flush();
    });
    const lua = this.host.lua;
    if (lua) for (const name of [...lua.libraries.keys()]) lua.deleteLibrary(name);
  }

  // ---- RDB saving --------------------------------------------------------------------------------------------

  /** Foreground save (SAVE, SHUTDOWN, FLUSHALL with save points, DEBUG RELOAD). True on success. */
  save(): boolean {
    try {
      const buf = this.buildRdb();
      writeAtomicSync(this.rdbPath, join(this.dir, `temp-${process.pid}.rdb`), buf);
    } catch (error) {
      this.host.log('warn', '[Persistence.save] Failed saving the DB', { error: strerror(error) });
      tryUnlink(join(this.dir, `temp-${process.pid}.rdb`));
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
  private startBgsave(): boolean {
    const now = Date.now();
    this.lastBgsaveTry = now;
    this.dirtyBeforeBgsave = this.dirty;
    let buf: Buffer;
    try {
      buf = this.buildRdb();
    } catch (error) {
      this.lastBgsaveStatus = 'err';
      this.host.log('warn', "[Persistence.startBgsave] Can't save in background", { error: strerror(error) });
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
        if (job.cancelled) throw new Error('cancelled');
        await rename(tmp, path);
        fsyncDir(this.dir);
      } catch (error) {
        ok = false;
        await unlink(tmp).catch(() => undefined);
        if (!job.cancelled) this.host.log('warn', '[Persistence.startBgsave] Write error saving DB on disk', { error: strerror(error) });
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
  private killBgsave(): void {
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

  // ---- commands ----------------------------------------------------------------------------------------------

  /** SAVE. */
  saveCommand(): Reply {
    if (this.bgsaveJob) throw new CommandError('ERR Background save already in progress');
    if (this.save()) return OK;
    throw new CommandError('ERR');
  }

  /**
   * BGSAVE [SCHEDULE]. `inExec`: called inside MULTI/EXEC, where Redis schedules it. SCHEDULE only matters while an
   * AOF rewrite child runs ("Another child process is active (AOF?)…"); rewrites here are synchronous, so never.
   */
  bgsaveCommand(opts: { schedule?: boolean; inExec?: boolean } = {}): Reply {
    if (this.bgsaveJob) throw new CommandError('ERR Background save already in progress');
    if (opts.inExec) {
      this.bgsaveScheduled = true;
      return new Status('Background saving scheduled');
    }
    if (this.startBgsave()) return new Status('Background saving started');
    throw new CommandError('ERR');
  }

  /** BGREWRITEAOF. */
  bgrewriteaofCommand(inExec = false): Reply {
    if (this.bgsaveJob || inExec) {
      this.aofRewriteScheduled = true;
      this.aofRewritesConsecutiveFailures = 0;
      return new Status('Background append only file rewriting scheduled');
    }
    if (this.rewriteAof()) return new Status('Background append only file rewriting started');
    throw new CommandError("ERR Can't execute an AOF background rewriting. Please check the server logs for more information.");
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
      if (!this.save()) throw new CommandError('ERR');
    }
    if (!opts.noflush) this.emptyData();
    try {
      this.withLoading(() => this.loadRdbBuffer(readFileSync(this.rdbPath), false));
    } catch (error) {
      this.host.log('warn', '[Persistence.debugReload] Error trying to load the RDB dump', { error: strerror(error) });
      throw new CommandError('ERR Error trying to load the RDB dump, check server logs.');
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
      this.host.log('warn', '[Persistence.debugLoadAof] Error loading the AOF', { error: strerror(error) });
      throw new CommandError('ERR Error loading the AOF, check server logs.');
    }
    this.dirty = 0;
    this.host.log('info', '[Persistence.debugLoadAof] Append Only File loaded by DEBUG LOADAOF');
    return OK;
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

  // ---- write denial ------------------------------------------------------------------------------------------

  /**
   * writeCommandsDeniedByDiskError: the error a write command (and, on a master, PING) must get instead of running,
   * or null. Without the leading '-'.
   */
  writeDeniedError(): string | null {
    if (this.cfg('stop-writes-on-bgsave-error', 'yes') === 'yes' && this.savePoints().length && this.lastBgsaveStatus === 'err') return RDB_MISCONF;
    if (this.aofState !== 'off' && this.aofLastWriteStatus === 'err') return `MISCONF Errors writing to the AOF file: ${this.aofLastWriteError}`;
    return null;
  }

  // ---- AOF writing -------------------------------------------------------------------------------------------

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
        out += encodeAofCommand(['SELECT', String(o.db)]);
        this.aofSelectedDb = o.db;
      }
      out += encodeAofCommand(o.argv);
    }
    if (!out) return;
    this.aofBuffer += out;
    this.flushAof(false);
  }

  /** Writes the AOF buffer (flushAppendOnlyFile); fsyncs per appendfsync (`force` fsyncs unless 'no'). */
  private flushAof(force: boolean): void {
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
        if (this.aofLastWriteStatus === 'ok') this.host.log('warn', '[Persistence.flushAof] Error writing to the AOF file', { error: strerror(error) });
        this.aofLastWriteStatus = 'err';
        this.aofLastWriteError = strerror(error);
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

  private fsyncAof(): void {
    if (this.aofFd === null || !this.aofFsyncPending) return;
    try {
      fsyncSync(this.aofFd);
      this.aofFsyncPending = false;
      this.aofLastFsync = Date.now();
    } catch (error) {
      this.aofLastWriteStatus = 'err';
      this.aofLastWriteError = strerror(error);
    }
  }

  private closeAofFd(): void {
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

  private persistManifest(m: AofManifest): void {
    mkdirSync(this.aofDir, { recursive: true });
    writeAtomicSync(this.manifestPath, join(this.aofDir, `temp-${this.aofName}.manifest`), formatAofManifest(m));
  }

  /** openNewIncrAofForAppend: a new incr file, recorded in the manifest, becomes the append target. */
  private openNewIncr(m: AofManifest, onStart = false): void {
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
  private openAofOnStart(): void {
    let m = this.manifest ?? emptyManifest();
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
  private writeNewBase(m: AofManifest): string {
    mkdirSync(this.aofDir, { recursive: true });
    const preamble = this.cfg('aof-use-rdb-preamble', 'yes') === 'yes';
    const content: Buffer | string = preamble ? this.buildRdb(true) : snapshotToAof(this.snapshot());
    const seq = m.baseSeq + 1;
    const name = `${this.aofName}.${seq}.base.${preamble ? 'rdb' : 'aof'}`;
    writeAtomicSync(join(this.aofDir, name), join(this.aofDir, `temp-rewriteaof-bg-${process.pid}.aof`), content);
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
  private deleteHistoryFiles(): void {
    const m = this.manifest;
    if (!m || !m.history.length) return;
    for (const h of m.history) {
      tryUnlink(join(this.aofDir, h.name));
      this.host.log('info', '[Persistence.deleteHistoryFiles] Removing the history file in the background', { file: h.name });
    }
    m.history = [];
    this.persistManifest(m);
  }

  /**
   * BGREWRITEAOF, synchronously: switch appends to a fresh incr file (when AOF is on), write a new base (RDB preamble
   * when aof-use-rdb-preamble yes), mark the old base and the incr files it covers as history, persist the manifest
   * and delete the history files. With AOF off only a base + manifest are produced (no incr file), like Redis.
   */
  rewriteAof(): boolean {
    const started = Date.now();
    try {
      mkdirSync(this.aofDir, { recursive: true });
      const m = this.manifest ?? this.loadManifestFromDisk() ?? emptyManifest();
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
      this.host.log('warn', '[Persistence.rewriteAof] Background AOF rewrite failed', { error: strerror(error) });
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
  private startAppendOnly(): boolean {
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
  private stopAppendOnly(): void {
    this.closeAofFd();
    this.aofState = 'off';
    this.aofRewriteScheduled = false;
    this.aofBuffer = '';
  }

  /**
   * Call after CONFIG SET stored a new value. Returns the reason to report when the change cannot be applied (Redis:
   * "ERR CONFIG SET failed (possibly related to argument 'appendonly') - <reason>"), else null.
   */
  onConfigChange(name: string): string | null {
    const key = name.toLowerCase();
    if (key === 'appendonly') {
      const want = this.cfg('appendonly') === 'yes';
      if (want && this.aofState === 'off') return this.startAppendOnly() ? null : 'Unable to turn on AOF. Check server logs.';
      if (!want && this.aofState !== 'off') this.stopAppendOnly();
    } else if (key === 'appendfsync' && this.cfg('appendfsync') === 'always') this.fsyncAof();
    return null;
  }

  // ---- cron --------------------------------------------------------------------------------------------------

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

  private runScheduled(): void {
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

  /** One serverCron tick: scheduled BGSAVE / rewrite, save points, auto AOF rewrite, everysec fsync, write retry. */
  cron(now = Date.now()): void {
    const sec = Math.floor(now / 1000);
    const retryOk = sec - Math.floor(this.lastBgsaveTry / 1000) > BGSAVE_RETRY_DELAY || this.lastBgsaveStatus === 'ok';
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

  // ---- INFO --------------------------------------------------------------------------------------------------

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
