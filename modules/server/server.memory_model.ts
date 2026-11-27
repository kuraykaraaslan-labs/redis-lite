import type { Database } from '@/modules/database/database.service';
import DatabaseService from '@/modules/database/database.service';
import type { RedisValue } from '@/modules/database/database.types';
import MemoryService, { MemoryTracker } from '@/modules/memory/memory.service';
import type { ClientMemory, DictKind, DictSnapshot, MemoryReport } from '@/modules/memory/memory.types';

import type { Client } from './server.client';
import type { RedisLiteServer } from './server.core';

/** Commands of these groups work on value dicts (sets, hashes, sorted sets; geo sets are sorted sets). */
const DICT_GROUPS = new Set(['set', 'hash', 'sorted-set', 'geo']);

/** Commands that read a value without looking anything up in its dict (they iterate, or read the size). */
const NO_DICT_ACCESS = new Set([
  'scard', 'smembers', 'sscan', 'sintercard', 'hlen', 'hgetall', 'hkeys', 'hvals', 'hscan', 'zcard', 'zrange', 'zrangebyscore',
  'zrevrange', 'zrevrangebyscore', 'zrangebylex', 'zrevrangebylex', 'zcount', 'zlexcount', 'zscan', 'zrangestore',
]);

/** Commands looking up one dict entry per argument after the key. */
const PER_ARGUMENT = new Set(['sadd', 'srem', 'smismember', 'hmget', 'hdel', 'zmscore', 'zrem']);

/** Lookups a write makes in the expires dict per key (read the TTL, drop it, set it). */
const EXPIRES_WRITE_LOOKUPS = 3;

/** dictGetFairRandomKey samples several buckets: about this many rehash steps per call. */
const RANDOM_PICK_STEPS = 12;

/** The server's used-memory model: incremental per-key accounting, Redis-style overheads and the memory peak. */
export class ServerMemoryModel {
  /** Incremental used-memory accounting. */
  readonly tracker: MemoryTracker;
  /** Identity of each database's main and expires dicts for the dict model (swapped by SWAPDB, renewed by a flush). */
  private keyspaceDicts: Array<{ main: object; expires: object }>;
  /** Identity of the cached-scripts dict and of the functions dict. */
  private scriptsDict = {};
  private functionsDict = {};
  /** When serverCron last ran on the keyspace dicts (ms). */
  private lastCron = 0;

  constructor(private readonly server: RedisLiteServer) {
    this.tracker = new MemoryTracker(server.databases, server.config);
    this.keyspaceDicts = server.databases.map(() => ({ main: {}, expires: {} }));
  }

  /** The value kind of a dict-backed value, or undefined. */
  private static dictKind(v: RedisValue | undefined): DictKind | undefined {
    if (!v) return undefined;
    return v.type === 'set' || v.type === 'hash' || v.type === 'zset' ? v.type : undefined;
  }

  private isHashtable(v: RedisValue): boolean {
    const enc = DatabaseService.objectEncoding(v, this.server.config);
    return enc === 'hashtable' || enc === 'skiplist';
  }

  /** Dict operations a command performs on its key number `keyIndex` (beyond the inserts / deletes it makes). */
  private static accesses(name: string, argv: string[], keyIndex: number): number {
    if (NO_DICT_ACCESS.has(name)) return 0;
    if (keyIndex > 0) return 1;
    if (PER_ARGUMENT.has(name)) return argv.length - 2;
    if (name === 'hset' || name === 'hmset') return (argv.length - 2) >> 1;
    if (name === 'zadd') {
      let i = 2;
      while (i < argv.length && /^(nx|xx|gt|lt|ch|incr)$/i.test(argv[i])) i++;
      return (argv.length - i) >> 1;
    }
    if ((name === 'srandmember' || name === 'spop') && argv.length === 2) return RANDOM_PICK_STEPS;
    return 1;
  }

  /** Where a compact value of this kind turns into a hash table (see MemoryService.dictAfterCommand). */
  private convertAt(kind: DictKind, value: RedisValue, size: number): (beforeSize: number) => number {
    const cfg = this.server.config;
    if (kind === 'set') {
      const max = cfg.num('set-max-intset-entries');
      if (size <= max) return (b) => b;
      // only called for a dict met for the first time: the scan over the members is paid once
      return (b) => {
        for (const m of value.value as Set<string>) if (!/^(0|-?[1-9]\d{0,18})$/.test(m)) return b;
        return max + 1;
      };
    }
    const max = cfg.num(kind === 'hash' ? 'hash-max-listpack-entries' : 'zset-max-listpack-entries');
    return (b) => (size > max ? Math.max(b, max) : b);
  }

  /** How many keys a command names by its legacy (first, last, step) key positions (reads have no key extractor). */
  static keyCount(range: readonly [number, number, number] | undefined, argc: number): number {
    if (!range || range[0] <= 0 || range[2] <= 0) return 0;
    const last = range[1] < 0 ? argc + range[1] : Math.min(range[1], argc - 1);
    return last < range[0] ? 0 : Math.floor((last - range[0]) / range[2]) + 1;
  }

  /** Whether a command works on value dicts (and is worth the before / after bookkeeping). */
  static touchesDicts(group: string | undefined): boolean {
    return group !== undefined && DICT_GROUPS.has(group);
  }

  /** What the command's keys hold before it runs. */
  dictsBefore(db: Database, keys: readonly string[]): DictSnapshot[] {
    return keys.map((key) => {
      const v = db.raw(key);
      const kind = ServerMemoryModel.dictKind(v);
      if (!v || !kind) return MemoryService.dictSnapshot(undefined, 0, false);
      return MemoryService.dictSnapshot(v.value as object, ServerMemoryModel.sizeOf(v), this.isHashtable(v));
    });
  }

  private static sizeOf(v: RedisValue): number {
    return v.type === 'zset' ? v.value.size : (v.value as Set<string> | Map<string, string>).size;
  }

  /** Replays the command on the value dicts of its keys (rehash steps, growth, shrinking). */
  dictsAfter(dbIndex: number, keys: readonly string[], before: readonly DictSnapshot[], name: string, argv: string[]): void {
    const db = this.server.databases[dbIndex];
    for (let i = 0; i < keys.length; i++) {
      const v = db.raw(keys[i]);
      const kind = ServerMemoryModel.dictKind(v);
      if (!v || !kind) continue;
      const size = ServerMemoryModel.sizeOf(v);
      const ht = this.isHashtable(v);
      const accesses = ServerMemoryModel.accesses(name, argv, i);
      const convertAt = ht ? this.convertAt(kind, v, size) : (b: number) => b;
      if (MemoryService.dictAfterCommand(before[i], v.value as object, size, ht, kind, accesses, convertAt)) this.tracker.changed(dbIndex, keys[i]);
    }
  }

  // ──────────────────────────────────────────────
  // Keyspace dicts
  // ──────────────────────────────────────────────

  /** serverCron's dict work (shrinking, active rehashing), at most once per cron period, before the new changes. */
  private keyspaceCron(): void {
    const now = Date.now();
    // serverCron runs at least every 100 ms (hz 10); the config is read only when a run is due
    if (now - this.lastCron < 10) return;
    const cfg = this.server.config;
    if (now - this.lastCron < 1000 / Math.max(1, cfg.num('hz'))) return;
    this.lastCron = now;
    const active = cfg.get('activerehashing') === 'yes';
    for (const d of this.keyspaceDicts) {
      MemoryService.dictCron(d.main, active);
      MemoryService.dictCron(d.expires, active);
    }
  }

  /**
   * Brings the keyspace dicts of database `i` up to date; `accesses`: keys the last command looked up there. A write
   * also probes the expires dict to drop / set the TTL (about three lookups per key).
   */
  private syncKeyspace(i: number, accesses: number, write = false): void {
    const db = this.server.databases[i];
    const d = this.keyspaceDicts[i];
    const expires = db.expiresCount;
    // a write looks its keys up twice (the lookup, then the insert / TTL update); a delete unlinks without a lookup
    MemoryService.dictSync(d.main, db.storedKeys, 'keyspace', write ? accesses * 2 : accesses, 2);
    MemoryService.dictSync(d.expires, expires, 'plain', expires ? accesses * (write ? EXPIRES_WRITE_LOOKUPS : 1) : 0);
  }

  /** After a command: rehash steps of its lookups, and the dicts a flush / SWAPDB / DEBUG RELOAD replaced. */
  keyspaceAfter(dbIndex: number, name: string, argv: readonly string[], keys: number, write: boolean): void {
    this.keyspaceCron();
    const sub = argv[1]?.toLowerCase();
    if (name === 'flushall' || (name === 'debug' && sub === 'reload')) {
      this.keyspaceDicts = this.keyspaceDicts.map(() => ({ main: {}, expires: {} }));
      if (name === 'debug') this.server.databases.forEach((db, i) => this.preallocateKeyspace(i));
    } else if (name === 'flushdb') this.keyspaceDicts[dbIndex] = { main: {}, expires: {} };
    else if (name === 'swapdb') {
      const a = Number(argv[1]);
      const b = Number(argv[2]);
      const d = this.keyspaceDicts;
      if (d[a] && d[b]) [d[a], d[b]] = [d[b], d[a]];
    }
    this.syncKeyspace(dbIndex, keys, write);
  }

  /** RDB loading sizes the dicts for the keys it is about to load (no rehashing). */
  private preallocateKeyspace(i: number): void {
    const db = this.server.databases[i];
    const d = this.keyspaceDicts[i];
    MemoryService.dictAfterCommand(MemoryService.dictSnapshot(d.main, db.storedKeys, true), d.main, db.storedKeys, true, 'keyspace', 0, (b) => b);
    MemoryService.dictAfterCommand(MemoryService.dictSnapshot(d.expires, db.expiresCount, true), d.expires, db.expiresCount, true, 'plain', 0, (b) => b);
  }

  /** Table sizes of database `i`'s dicts (DEBUG HTSTATS). */
  keyspaceTables(i: number): { main: ReturnType<typeof MemoryService.dictTables>; expires: ReturnType<typeof MemoryService.dictTables> } {
    this.keyspaceCron();
    this.syncKeyspace(i, 0);
    const db = this.server.databases[i];
    const d = this.keyspaceDicts[i];
    return { main: MemoryService.dictTables(d.main, db.storedKeys), expires: MemoryService.dictTables(d.expires, db.expiresCount) };
  }

  // ──────────────────────────────────────────────
  // Clients, scripts, functions
  // ──────────────────────────────────────────────

  /** CLIENT LIST memory figures of a client (getClientMemoryUsage). */
  clientMemory(c: Client): ClientMemory {
    let queryLen = 0;
    const argv = c.currentArgv;
    if (argv) {
      queryLen = 3 + String(argv.length).length;
      for (const a of argv) queryLen += 5 + String(a.length).length + a.length;
    }
    return MemoryService.clientMemory({
      queryBuf: c.queryBuf,
      queryLen,
      argv,
      multi: c.multi,
      channels: c.channels.size,
      patterns: c.patterns.size,
      shardChannels: c.shardChannels.size,
    });
  }

  private scriptCaches(): { lua: number; functions: number } {
    const scripts = this.server.scripts;
    if (!scripts.size) this.scriptsDict = {};
    MemoryService.dictSync(this.scriptsDict, scripts.size, 'plain');
    const libraries = [...(this.server.lua?.libraries.values() ?? [])];
    let functions = 0;
    for (const lib of libraries) functions += lib.functions.length;
    if (!functions) this.functionsDict = {};
    MemoryService.dictSync(this.functionsDict, functions, 'plain');
    return {
      lua: MemoryService.luaCaches(scripts, MemoryService.dictSlots(this.scriptsDict, scripts.size)),
      functions: MemoryService.functionsCaches(libraries, MemoryService.dictSlots(this.functionsDict, functions)),
    };
  }

  /** used_memory and friends (getMemoryOverheadData over the whole dataset); also tracks used_memory_peak. */
  memoryReport(): MemoryReport {
    const server = this.server;
    this.keyspaceCron();
    const databases = this.tracker.snapshots().map((db) => {
      this.syncKeyspace(db.id, 0);
      const d = this.keyspaceDicts[db.id];
      const t = db.totals;
      return { ...db, mainSlots: MemoryService.dictSlots(d.main, t?.keys ?? 0), expiresSlots: MemoryService.dictSlots(d.expires, t?.expires ?? 0) };
    });
    let clientsNormal = 0;
    let clientsSlaves = 0;
    for (const c of server.clients) {
      const mem = this.clientMemory(c).totMem;
      if (c.replica) clientsSlaves += mem;
      else clientsNormal += mem;
    }
    const caches = this.scriptCaches();
    let report = MemoryService.computeMemory({
      databases,
      clientsNormal,
      clientsSlaves,
      luaCaches: caches.lua,
      functionsCaches: caches.functions,
      replicationBacklog: server.replication?.backlog?.size ?? 0,
      sizes: {
        listMaxListpackSize: server.config.num('list-max-listpack-size'),
        streamNodeMaxEntries: server.config.num('stream-node-max-entries'),
        streamNodeMaxBytes: server.config.num('stream-node-max-bytes'),
      },
    });
    if (report.usedMemory > server.memoryPeak) {
      server.memoryPeak = report.usedMemory;
      server.memoryPeakTime = Math.floor(Date.now() / 1000);
    }
    // the report's own peak is max(previous peak, used) at computation time; refresh it with the tracked peak
    if (report.peak !== server.memoryPeak) {
      report = { ...report, peak: server.memoryPeak, peakPercentage: Math.fround((report.usedMemory * 100) / server.memoryPeak) };
    }
    return report;
  }

  /** used_memory as maxmemory sees it. */
  usedMemoryForEviction(): number {
    return MemoryService.memoryForEviction(this.memoryReport());
  }
}
