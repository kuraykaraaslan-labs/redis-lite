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
  | { kind: 'int'; min: bigint; max: bigint }
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
    else return { error: "Invalid event class character. Use 'Ag$lshzxeKEtmdn'." };
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

/** save: "<seconds> <changes> ..." pairs, or "" to disable. */
function normalizeSave(value: string): string | { error: string } {
  const parts = value.split(' ').filter(Boolean);
  if (parts.length % 2 || parts.some((p) => !/^\d+$/.test(p))) return { error: 'Invalid save parameters' };
  return parts.map((p) => String(Number(p))).join(' ');
}

export const CONFIG_DEFS: Record<string, ConfigDef> = {
  'active-expire-effort': int(1, 1n, 10n),
  activedefrag: bool('no'),
  'acl-pubsub-default': oneOf('resetchannels', ['allchannels', 'resetchannels']),
  aclfile: str('', true),
  'acllog-max-len': int(128, 0n, LONG_MAX),
  'aof-use-rdb-preamble': bool('yes'),
  appendfilename: str('appendonly.aof', true),
  appenddirname: str('appendonlydir', true),
  appendfsync: oneOf('everysec', ['always', 'everysec', 'no']),
  appendonly: bool('no'),
  bind: str('* -::*', true),
  'busy-reply-threshold': { ...int(5000, 0n, LONG_MAX), aliases: ['lua-time-limit'] },
  'client-output-buffer-limit': str('normal 0 0 0 slave 268435456 67108864 60 pubsub 33554432 8388608 60'),
  'cluster-enabled': bool('no', true),
  'crash-log-enabled': bool('yes'),
  daemonize: bool('no', true),
  databases: int(16, 1n, INT_MAX, true),
  dbfilename: str('dump.rdb'),
  dir: str(process.cwd()),
  'dynamic-hz': bool('yes'),
  'hash-max-listpack-entries': { ...int(128, 0n, LONG_MAX), aliases: ['hash-max-ziplist-entries'] },
  'hash-max-listpack-value': { ...mem(64), aliases: ['hash-max-ziplist-value'] },
  'hll-sparse-max-bytes': mem(3000),
  hz: int(10, 0n, INT_MAX),
  'io-threads': int(1, 1n, 128n, true),
  'latency-monitor-threshold': int(0, 0n, LONG_MAX),
  'latency-tracking': bool('yes'),
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
  'maxmemory-clients': mem(0),
  'maxmemory-eviction-tenacity': int(10, 0n, 100n),
  'maxmemory-policy': oneOf('noeviction', MAXMEMORY_POLICIES),
  'maxmemory-samples': int(5, 1n, 64n),
  'min-replicas-max-lag': int(10, 0n, INT_MAX),
  'min-replicas-to-write': int(0, 0n, INT_MAX),
  'notify-keyspace-events': { type: { kind: 'special', normalize: normalizeKeyspaceEvents }, default: '' },
  port: int(6379, 0n, 65535n, true),
  'proto-max-bulk-len': mem(536870912, 1024n * 1024n, LONG_MAX),
  'protected-mode': bool('yes'),
  'rdbchecksum': bool('yes', true),
  rdbcompression: bool('yes'),
  'repl-backlog-size': mem(1048576, 1n, LONG_MAX),
  'replica-lazy-flush': { ...bool('no'), aliases: ['slave-lazy-flush'] },
  'replica-read-only': { ...bool('yes'), aliases: ['slave-read-only'] },
  'replica-serve-stale-data': { ...bool('yes'), aliases: ['slave-serve-stale-data'] },
  requirepass: str(''),
  save: { type: { kind: 'special', normalize: normalizeSave }, default: '3600 1 300 100 60 10000' },
  'set-max-intset-entries': int(512, 0n, LONG_MAX),
  'set-max-listpack-entries': int(128, 0n, LONG_MAX),
  'set-max-listpack-value': mem(64),
  'slowlog-log-slower-than': int(10000, -1n, LONG_MAX),
  'slowlog-max-len': int(128, 0n, LONG_MAX),
  'stop-writes-on-bgsave-error': bool('yes'),
  'stream-node-max-bytes': mem(4096),
  'stream-node-max-entries': int(100, 0n, LONG_MAX),
  'tcp-backlog': int(511, 0n, INT_MAX, true),
  'tcp-keepalive': int(300, 0n, INT_MAX),
  timeout: int(0, 0n, INT_MAX),
  'tracking-table-max-keys': int(1000000, 0n, LONG_MAX),
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
    return this.values.get(ServerConfig.canonical(name));
  }

  num(name: string): number {
    return Number(this.get(name) ?? '0');
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
        return v === 'yes' || v === 'no' ? { value: v } : { error: "argument must be 'yes' or 'no'" };
      }
      case 'enum': {
        const v = value.toLowerCase();
        return t.values.includes(v) ? { value: v } : { error: `argument(s) must be one of the following: ${t.values.join(', ')}` };
      }
      case 'int': {
        if (!/^(0|-?[1-9]\d*)$/.test(value)) return { error: "argument couldn't be parsed into an integer" };
        const n = BigInt(value);
        if (n < LONG_MIN || n > LONG_MAX) return { error: "argument couldn't be parsed into an integer" };
        if (n < t.min || n > t.max) return { error: `argument must be between ${t.min} and ${t.max} inclusive` };
        return { value: n.toString() };
      }
      case 'memory': {
        const n = parseMemory(value);
        if (n === null || n > LONG_MAX) return { error: 'argument must be a memory value' };
        if (n < t.min || n > t.max) return { error: `argument must be between ${t.min} and ${t.max} inclusive` };
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
  }

  entries(): Array<[string, string]> {
    return [...this.values.entries()];
  }

  get lfu(): boolean {
    return (this.get('maxmemory-policy') ?? '').includes('lfu');
  }
}
