import { formatMessage } from '@/libs/message-format';
import { toFloat } from '@/libs/number';

import TimeseriesService from '@/modules/timeseries/timeseries.service';
import TimeseriesMessages from '@/modules/timeseries/timeseries.messages';

import ServerMessages from './server.messages';

/**
 * Live server configuration (CONFIG GET / SET). Values are kept as Redis prints them in CONFIG GET (memory values in bytes,
 * booleans as yes/no, enums lowercase). Types, bounds, defaults and error texts follow Redis 8 (src/config.c).
 */

const INT_MAX = 2147483647n;
const INT_MIN = -2147483648n;
const LONG_MAX = 9223372036854775807n;
const LONG_MIN = -9223372036854775808n;

type ConfigType =
  | { kind: 'bool' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'int'; min: bigint; max: bigint; clamp?: [bigint, bigint] }
  | { kind: 'memory'; min: bigint; max: bigint }
  | { kind: 'string' }
  | { kind: 'special'; normalize: (value: string) => string | { error: string } };

interface ConfigDef {
  type: ConfigType;
  default: string;
  immutable?: boolean;
  aliases?: string[];
}

const bool = (def: 'yes' | 'no', immutable = false): ConfigDef => ({ type: { kind: 'bool' }, default: def, immutable });
const int = (def: number, min: bigint, max: bigint, immutable = false): ConfigDef => ({ type: { kind: 'int', min, max }, default: String(def), immutable });
const mem = (def: number, min = 0n, max = LONG_MAX): ConfigDef => ({ type: { kind: 'memory', min, max }, default: String(def) });
const str = (def: string, immutable = false): ConfigDef => ({ type: { kind: 'string' }, default: def, immutable });
/** An integer accepted in `min`..`max` and then stored clamped to `clamp` (hz: 0..INT_MAX accepted, kept in 1..500). */
const clamped = (def: number, min: bigint, max: bigint, clamp: [bigint, bigint]): ConfigDef => ({ type: { kind: 'int', min, max, clamp }, default: String(def) });
const oneOf = (def: string, values: string[], immutable = false): ConfigDef => ({ type: { kind: 'enum', values }, default: def, immutable });

const MAXMEMORY_POLICIES = ['volatile-lru', 'volatile-lfu', 'volatile-random', 'volatile-ttl', 'allkeys-lru', 'allkeys-lfu', 'allkeys-random', 'noeviction'];

/** notify-keyspace-events: Redis keyspaceEventsStringToFlags() / keyspaceEventsFlagsToString(). */
function normalizeKeyspaceEvents(value: string): string | { error: string } {
  const classes = 'g$lshzxetdmn';
  const all = 'g$lshzxetd';
  const set = new Set<string>();
  for (const ch of value) {
    if (ch === 'A') for (const c of all) set.add(c);
    else if (classes.includes(ch) || ch === 'K' || ch === 'E') set.add(ch);
    else return { error: ServerMessages.CONFIG_KEYSPACE_EVENTS };
  }
  let out = '';
  if ([...all].every((c) => set.has(c))) out = 'A';
  else for (const c of all) if (set.has(c)) out += c;
  if (set.has('m')) out += 'm';
  if (set.has('n')) out += 'n';
  if (set.has('K')) out += 'K';
  if (set.has('E')) out += 'E';
  return out;
}

/** maxmemory-clients: a memory value, or a percentage of maxmemory (`10%`, at most 100; `0%` is stored as 0). */
function normalizeMemoryOrPercent(value: string): string | { error: string } {
  const pct = /^(\d+)%$/.exec(value);
  if (pct) {
    const n = BigInt(pct[1]);
    if (n > 100n) return { error: ServerMessages.CONFIG_PERCENT_RANGE };
    return n === 0n ? '0' : `${n}%`;
  }
  const n = parseMemory(value);
  return n === null || n > LONG_MAX ? { error: ServerMessages.CONFIG_MEMORY_OR_PERCENT } : n.toString();
}

/** latency-tracking-info-percentiles: space-separated percentiles, each 0..100 (printed in their shortest form). */
function normalizePercentiles(value: string): string | { error: string } {
  const parts = value.split(' ').filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const n = toFloat(p);
    if (n === null || n < 0 || n > 100) return { error: ServerMessages.CONFIG_PERCENTILES };
    out.push(String(n));
  }
  return out.join(' ');
}

/** save: "<seconds> <changes> ..." pairs, or "" to disable. */
function normalizeSave(value: string): string | { error: string } {
  const parts = value.split(' ').filter(Boolean);
  if (parts.length % 2 || parts.some((p) => !/^\d+$/.test(p))) return { error: ServerMessages.CONFIG_SAVE };
  return parts.map((p) => String(Number(p))).join(' ');
}

/** ts-ignore-max-val-diff: a non-negative double. */
function normalizeNonNegativeDouble(value: string): string | { error: string } {
  const n = toFloat(value);
  return n === null || n < 0 || n === Infinity ? { error: TimeseriesMessages.BAD_IGNORE_MAX_VAL_DIFF } : value;
}

/** ts-compaction-policy: `aggregator:bucket:retention[:align]` rules separated by `;`, or "". */
function normalizeCompactionPolicy(value: string): string | { error: string } {
  return TimeseriesService.parseCompactionPolicy(value) === null ? { error: TimeseriesMessages.BAD_COMPACTION_POLICY } : value;
}

/** replicaof: `<masterip> <masterport>` (or empty). */
function normalizeReplicaOf(value: string): string | { error: string } {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length !== 2 || !/^\d+$/.test(parts[1]) || Number(parts[1]) > 65535) return { error: ServerMessages.CONFIG_REPLICAOF };
  return `${parts[0]} ${parts[1]}`;
}

const TS_DUPLICATE_POLICIES = ['block', 'first', 'last', 'min', 'max', 'sum'];

export const CONFIG_DEFS: Record<string, ConfigDef> = {
  'active-defrag-cycle-max': int(25, 1n, 99n),
  'active-defrag-cycle-min': int(1, 1n, 99n),
  'active-defrag-ignore-bytes': mem(104857600, 1n),
  'active-defrag-max-scan-fields': int(1000, 1n, LONG_MAX),
  'active-defrag-threshold-lower': int(10, 0n, 1000n),
  'active-defrag-threshold-upper': int(100, 0n, 1000n),
  'active-expire-effort': int(1, 1n, 10n),
  activedefrag: bool('no'),
  activerehashing: bool('yes'),
  'always-show-logo': bool('no', true),
  'acl-pubsub-default': oneOf('resetchannels', ['allchannels', 'resetchannels']),
  aclfile: str('', true),
  'acllog-max-len': int(128, 0n, LONG_MAX),
  'aof-disable-auto-gc': bool('no'),
  'aof-load-truncated': bool('yes'),
  'aof-rewrite-incremental-fsync': bool('yes'),
  'aof-timestamp-enabled': bool('no'),
  'aof-use-rdb-preamble': bool('yes'),
  appendfilename: str('appendonly.aof', true),
  appenddirname: str('appendonlydir', true),
  appendfsync: oneOf('everysec', ['everysec', 'always', 'no']),
  appendonly: bool('no'),
  bind: str('* -::*', true),
  'auto-aof-rewrite-min-size': mem(67108864),
  'auto-aof-rewrite-percentage': int(100, 0n, INT_MAX),
  'busy-reply-threshold': { ...int(5000, 0n, LONG_MAX), aliases: ['lua-time-limit'] },
  'client-query-buffer-limit': mem(1073741824, 1024n * 1024n),
  'client-output-buffer-limit': str('normal 0 0 0 slave 268435456 67108864 60 pubsub 33554432 8388608 60'),
  'cluster-enabled': bool('no', true),
  'crash-log-enabled': bool('yes'),
  'crash-memcheck-enabled': bool('yes'),
  daemonize: bool('no', true),
  databases: int(16, 1n, INT_MAX, true),
  dbfilename: str('dump.rdb'),
  dir: str(process.cwd()),
  'dynamic-hz': bool('yes'),
  // DEBUG is always available in redis-lite, as with `enable-debug-command yes`
  'enable-debug-command': oneOf('yes', ['no', 'yes', 'local'], true),
  'enable-module-command': oneOf('no', ['no', 'yes', 'local'], true),
  'enable-protected-configs': oneOf('no', ['no', 'yes', 'local'], true),
  'hash-max-listpack-entries': { ...int(512, 0n, LONG_MAX), aliases: ['hash-max-ziplist-entries'] },
  'hash-max-listpack-value': { ...mem(64), aliases: ['hash-max-ziplist-value'] },
  'hll-sparse-max-bytes': mem(3000),
  hz: clamped(10, 0n, INT_MAX, [1n, 500n]),
  'io-threads': int(1, 1n, 128n, true),
  'latency-monitor-threshold': int(0, 0n, LONG_MAX),
  'latency-tracking': bool('yes'),
  'latency-tracking-info-percentiles': { type: { kind: 'special', normalize: normalizePercentiles }, default: '50 99 99.9' },
  'lazyfree-lazy-eviction': bool('no'),
  'lazyfree-lazy-expire': bool('no'),
  'lazyfree-lazy-server-del': bool('no'),
  'lazyfree-lazy-user-del': bool('no'),
  'lazyfree-lazy-user-flush': bool('no'),
  'lfu-decay-time': int(1, 0n, INT_MAX),
  'lfu-log-factor': int(10, 0n, INT_MAX),
  'list-compress-depth': int(0, 0n, INT_MAX),
  'list-max-listpack-size': { ...int(-2, INT_MIN, INT_MAX), aliases: ['list-max-ziplist-size'] },
  logfile: str('', true),
  loglevel: oneOf('notice', ['debug', 'verbose', 'notice', 'warning', 'nothing']),
  maxclients: int(10000, 1n, LONG_MAX),
  maxmemory: mem(0),
  'maxmemory-clients': { type: { kind: 'special', normalize: normalizeMemoryOrPercent }, default: '0' },
  'maxmemory-eviction-tenacity': int(10, 0n, 100n),
  'maxmemory-policy': oneOf('noeviction', MAXMEMORY_POLICIES),
  'maxmemory-samples': int(5, 1n, 64n),
  masterauth: str(''),
  masteruser: str(''),
  'min-replicas-max-lag': { ...int(10, 0n, INT_MAX), aliases: ['min-slaves-max-lag'] },
  'min-replicas-to-write': { ...int(0, 0n, INT_MAX), aliases: ['min-slaves-to-write'] },
  'no-appendfsync-on-rewrite': bool('no'),
  'notify-keyspace-events': { type: { kind: 'special', normalize: normalizeKeyspaceEvents }, default: '' },
  port: int(6379, 0n, 65535n),
  'proto-max-bulk-len': mem(536870912, 1024n * 1024n, LONG_MAX),
  'protected-mode': bool('yes'),
  'rdbchecksum': bool('yes', true),
  rdbcompression: bool('yes'),
  'rdb-del-sync-files': bool('no'),
  'rdb-save-incremental-fsync': bool('yes'),
  'repl-backlog-size': mem(1048576, 1n, LONG_MAX),
  'repl-backlog-ttl': int(3600, 0n, INT_MAX),
  'repl-disable-tcp-nodelay': bool('no'),
  'repl-diskless-load': oneOf('disabled', ['disabled', 'on-empty-db', 'swapdb']),
  'repl-diskless-sync': bool('yes'),
  'repl-diskless-sync-delay': int(5, 0n, INT_MAX),
  'repl-diskless-sync-max-replicas': int(0, 0n, INT_MAX),
  'repl-ping-replica-period': { ...int(10, 1n, INT_MAX), aliases: ['repl-ping-slave-period'] },
  'repl-timeout': int(60, 1n, INT_MAX),
  'replica-announce-ip': { ...str(''), aliases: ['slave-announce-ip'] },
  'replica-announce-port': { ...int(0, 0n, 65535n), aliases: ['slave-announce-port'] },
  'replica-announced': bool('yes'),
  'replica-ignore-disk-write-errors': bool('no'),
  'replica-ignore-maxmemory': { ...bool('yes'), aliases: ['slave-ignore-maxmemory'] },
  'replica-lazy-flush': { ...bool('no'), aliases: ['slave-lazy-flush'] },
  'replica-priority': { ...int(100, 0n, INT_MAX), aliases: ['slave-priority'] },
  'replica-read-only': { ...bool('yes'), aliases: ['slave-read-only'] },
  'replica-serve-stale-data': { ...bool('yes'), aliases: ['slave-serve-stale-data'] },
  // `host port` of the master (the replicaof directive); REPLICAOF changes it, CONFIG SET cannot
  replicaof: { type: { kind: 'special', normalize: normalizeReplicaOf }, default: '', immutable: true, aliases: ['slaveof'] },
  requirepass: str(''),
  'sanitize-dump-payload': oneOf('no', ['no', 'yes', 'clients']),
  save: { type: { kind: 'special', normalize: normalizeSave }, default: '3600 1 300 100 60 10000' },
  'set-max-intset-entries': int(512, 0n, LONG_MAX),
  'set-max-listpack-entries': int(128, 0n, LONG_MAX),
  'set-max-listpack-value': mem(64),
  'shutdown-timeout': int(10, 0n, INT_MAX),
  'slowlog-log-slower-than': int(10000, -1n, LONG_MAX),
  'slowlog-max-len': int(128, 0n, LONG_MAX),
  'stop-writes-on-bgsave-error': bool('yes'),
  'stream-node-max-bytes': mem(4096),
  'stream-node-max-entries': int(100, 0n, LONG_MAX),
  'tcp-backlog': int(511, 0n, INT_MAX, true),
  'tcp-keepalive': int(300, 0n, INT_MAX),
  timeout: int(0, 0n, INT_MAX),
  'tracking-table-max-keys': int(1000000, 0n, LONG_MAX),
  // time series module (Redis 8 module configs)
  'ts-chunk-size-bytes': int(4096, 48n, 1048576n),
  'ts-compaction-policy': { type: { kind: 'special', normalize: normalizeCompactionPolicy }, default: '' },
  'ts-duplicate-policy': oneOf('block', TS_DUPLICATE_POLICIES),
  'ts-encoding': oneOf('compressed', ['compressed', 'uncompressed']),
  'ts-ignore-max-time-diff': int(0, 0n, LONG_MAX),
  'ts-ignore-max-val-diff': { type: { kind: 'special', normalize: normalizeNonNegativeDouble }, default: '0' },
  'ts-num-threads': int(3, 1n, 16n, true),
  'ts-retention-policy': int(0, 0n, LONG_MAX),
  unixsocket: str('', true),
  'zset-max-listpack-entries': { ...int(128, 0n, LONG_MAX), aliases: ['zset-max-ziplist-entries'] },
  'zset-max-listpack-value': { ...mem(64), aliases: ['zset-max-ziplist-value'] },
};

/** Alias → real name (old ziplist / slave names Redis still accepts). */
const ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(CONFIG_DEFS).flatMap(([name, def]) => (def.aliases ?? []).map((alias) => [alias, name])),
);

/** Kept for callers that only need the default values. */
export const CONFIG_DEFAULTS: Record<string, string> = Object.fromEntries(Object.entries(CONFIG_DEFS).map(([k, d]) => [k, d.default]));

/** Redis memtoull(): a byte count with an optional b / k / kb / m / mb / g / gb unit (case-insensitive). */
export function parseMemory(value: string): bigint | null {
  const m = /^(\d+)(b|k|kb|m|mb|g|gb)?$/i.exec(value);
  if (!m) return null;
  const mul: Record<string, bigint> = { b: 1n, k: 1000n, kb: 1024n, m: 1000000n, mb: 1048576n, g: 1000000000n, gb: 1073741824n };
  return BigInt(m[1]) * mul[(m[2] ?? 'b').toLowerCase()];
}

export class ServerConfig {
  private readonly values = new Map<string, string>(Object.entries(CONFIG_DEFAULTS));
  /**
   * Hot-path caches, by the name as the caller spells it (no canonicalisation, no number parsing per read). Only names
   * that are already canonical or a known alias are cached, so user-supplied spellings cannot grow them past the config
   * table. Every write goes through `set`, which empties them (CONFIG SET, config file load, startup options).
   */
  private readonly getCache = new Map<string, string>();
  private readonly numCache = new Map<string, number>();
  private lfuCache: boolean | null = null;

  constructor(fixed: Record<string, string>) {
    for (const [k, v] of Object.entries(fixed)) this.values.set(ServerConfig.canonical(k), v);
  }

  static canonical(name: string): string {
    const lower = name.toLowerCase();
    return ALIASES[lower] ?? lower;
  }

  /** Every config name and alias (CONFIG GET globbing). */
  static allNames(): string[] {
    return [...Object.keys(CONFIG_DEFS), ...Object.keys(ALIASES)];
  }

  get(name: string): string | undefined {
    const cache = this.getCache;
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const canonical = ServerConfig.canonical(name);
    const value = this.values.get(canonical);
    if (value !== undefined && (canonical === name || ALIASES[name] !== undefined)) cache.set(name, value);
    return value;
  }

  num(name: string): number {
    const hit = this.numCache.get(name);
    if (hit !== undefined) return hit;
    const value = Number(this.get(name) ?? '0');
    if (this.getCache.has(name)) this.numCache.set(name, value);
    return value;
  }

  has(name: string): boolean {
    return this.values.has(ServerConfig.canonical(name));
  }

  isImmutable(name: string): boolean {
    return Boolean(CONFIG_DEFS[ServerConfig.canonical(name)]?.immutable);
  }

  /** Validates a CONFIG SET value: the value to store, or the reason Redis gives for refusing it. */
  validate(name: string, value: string): { value: string } | { error: string } {
    const def = CONFIG_DEFS[ServerConfig.canonical(name)];
    if (!def) return { value };
    const t = def.type;
    switch (t.kind) {
      case 'bool': {
        const v = value.toLowerCase();
        return v === 'yes' || v === 'no' ? { value: v } : { error: ServerMessages.CONFIG_BOOL };
      }
      case 'enum': {
        const v = value.toLowerCase();
        return t.values.includes(v) ? { value: v } : { error: formatMessage(ServerMessages.CONFIG_ENUM, { values: t.values.join(', ') }) };
      }
      case 'int': {
        if (!/^(0|-?[1-9]\d*)$/.test(value)) return { error: ServerMessages.CONFIG_INT };
        const n = BigInt(value);
        if (n < LONG_MIN || n > LONG_MAX) return { error: ServerMessages.CONFIG_INT };
        if (n < t.min || n > t.max) return { error: formatMessage(ServerMessages.CONFIG_RANGE, { min: t.min.toString(), max: t.max.toString() }) };
        if (t.clamp) return { value: (n < t.clamp[0] ? t.clamp[0] : n > t.clamp[1] ? t.clamp[1] : n).toString() };
        return { value: n.toString() };
      }
      case 'memory': {
        const n = parseMemory(value);
        if (n === null || n > LONG_MAX) return { error: ServerMessages.CONFIG_MEMORY };
        if (n < t.min || n > t.max) return { error: formatMessage(ServerMessages.CONFIG_RANGE, { min: t.min.toString(), max: t.max.toString() }) };
        return { value: n.toString() };
      }
      case 'string':
        return { value };
      case 'special': {
        const r = t.normalize(value);
        return typeof r === 'string' ? { value: r } : r;
      }
    }
  }

  set(name: string, value: string): void {
    this.values.set(ServerConfig.canonical(name), value);
    this.getCache.clear();
    this.numCache.clear();
    this.lfuCache = null;
  }

  entries(): Array<[string, string]> {
    return [...this.values.entries()];
  }

  get lfu(): boolean {
    return (this.lfuCache ??= (this.get('maxmemory-policy') ?? '').includes('lfu'));
  }
}
