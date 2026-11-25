/**
 * Live server configuration (CONFIG GET / SET). Values are kept as Redis prints them.
 * Phase B extends this to the full Redis config table; the entries here are the ones behaviour already depends on.
 */
export const CONFIG_DEFAULTS: Record<string, string> = {
  'maxmemory-policy': 'noeviction',
  maxmemory: '0',
  'maxmemory-samples': '5',
  'lfu-log-factor': '10',
  'lfu-decay-time': '1',
  'hash-max-listpack-entries': '128',
  'hash-max-listpack-value': '64',
  'set-max-intset-entries': '512',
  'set-max-listpack-entries': '128',
  'set-max-listpack-value': '64',
  'zset-max-listpack-entries': '128',
  'zset-max-listpack-value': '64',
  'list-max-listpack-size': '-2',
  'list-compress-depth': '0',
  'stream-node-max-entries': '100',
  'stream-node-max-bytes': '4096',
  'hll-sparse-max-bytes': '3000',
  'notify-keyspace-events': '',
  appendonly: 'no',
  save: '3600 1 300 100 60 10000',
  timeout: '0',
  'lua-time-limit': '5000',
  'busy-reply-threshold': '5000',
  'proto-max-bulk-len': '536870912',
  'slowlog-log-slower-than': '10000',
  'slowlog-max-len': '128',
  'latency-monitor-threshold': '0',
  'active-expire-effort': '1',
  'lazyfree-lazy-user-del': 'no',
};

/** Aliases Redis still accepts (old ziplist names). */
const ALIASES: Record<string, string> = {
  'hash-max-ziplist-entries': 'hash-max-listpack-entries',
  'hash-max-ziplist-value': 'hash-max-listpack-value',
  'zset-max-ziplist-entries': 'zset-max-listpack-entries',
  'zset-max-ziplist-value': 'zset-max-listpack-value',
  'list-max-ziplist-size': 'list-max-listpack-size',
};

export class ServerConfig {
  private readonly values = new Map<string, string>(Object.entries(CONFIG_DEFAULTS));

  constructor(fixed: Record<string, string>) {
    for (const [k, v] of Object.entries(fixed)) this.values.set(k, v);
  }

  static canonical(name: string): string {
    const lower = name.toLowerCase();
    return ALIASES[lower] ?? lower;
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
