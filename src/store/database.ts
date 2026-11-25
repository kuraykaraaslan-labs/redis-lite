import { CommandError } from '../errors';
import { RespMessages } from '../messages';
import type { ServerConfig } from '../server/config';
import type { Stream } from './stream';
import type { ZSet } from './zset';

export type RedisValue =
  /** `raw`: the value went through APPEND/SETRANGE/SETBIT/…, which Redis always leaves raw-encoded. */
  | { type: 'string'; value: string; raw?: boolean }
  | { type: 'hash'; value: Map<string, string> }
  | { type: 'list'; value: string[] }
  | { type: 'set'; value: Set<string> }
  | { type: 'zset'; value: ZSet }
  | { type: 'stream'; value: Stream };

interface ValueMap {
  string: string;
  hash: Map<string, string>;
  list: string[];
  set: Set<string>;
  zset: ZSet;
  stream: Stream;
}

export type ValueType = keyof ValueMap;
type ValueOf<T extends ValueType> = ValueMap[T];

/** Per-key access metadata, like the `lru` field of a Redis object (LRU clock or LFU counter + decay time). */
interface Access {
  /** Last access, ms (LRU). */
  at: number;
  /** LFU logarithmic counter (0..255). */
  counter: number;
  /** LFU last decrement time, minutes. */
  decrementedAt: number;
}

const LFU_INIT_VAL = 5;

/** One logical database (`SELECT n`): key → typed value, plus absolute expiry times in ms. */
export class Database {
  private data = new Map<string, RedisValue>();
  private expires = new Map<string, number>();
  private access = new Map<string, Access>();
  /** False while a client with CLIENT NO-TOUCH runs a command. */
  touchOnRead = true;

  constructor(
    private readonly onExpired: (key: string) => void,
    private readonly config: ServerConfig,
  ) {}

  get size(): number {
    this.sweep(Date.now(), Infinity);
    return this.data.size;
  }

  get expiresCount(): number {
    return this.expires.size;
  }

  /** The value without updating its access time (Redis LOOKUP_NOTOUCH): OBJECT, TYPE, SCAN, … */
  peek(key: string): RedisValue | undefined {
    const at = this.expires.get(key);
    if (at !== undefined && at <= Date.now()) {
      this.remove(key);
      this.onExpired(key);
      return undefined;
    }
    return this.data.get(key);
  }

  /** The value, or undefined when missing or expired (an expired key is deleted on access). Updates LRU/LFU. */
  lookup(key: string): RedisValue | undefined {
    const v = this.peek(key);
    if (v && this.touchOnRead) this.recordAccess(key);
    return v;
  }

  has(key: string): boolean {
    return this.lookup(key) !== undefined;
  }

  /** The value of `key` when it has `type`; undefined when missing; WRONGTYPE when it has another type. */
  get<T extends ValueType>(key: string, type: T): ValueOf<T> | undefined {
    const v = this.lookup(key);
    if (!v) return undefined;
    if (v.type !== type) throw new CommandError(RespMessages.WRONGTYPE);
    return v.value as ValueOf<T>;
  }

  /** Like `get`, but creates an empty value of `type` when the key is missing. */
  getOrCreate<T extends ValueType>(key: string, type: T, create: () => ValueOf<T>): ValueOf<T> {
    const existing = this.get(key, type);
    if (existing !== undefined) return existing;
    const value = create();
    this.data.set(key, { type, value } as RedisValue);
    this.access.set(key, this.newAccess());
    return value;
  }

  /** Stores `value`. Clears the TTL unless `keepTtl`. Like Redis, an overwrite keeps the LFU counter under an LFU policy. */
  set(key: string, value: RedisValue, keepTtl = false): void {
    const existed = this.peek(key) !== undefined;
    this.data.set(key, value);
    if (!keepTtl) this.expires.delete(key);
    if (!existed || !this.config.lfu) this.access.set(key, this.newAccess());
  }

  remove(key: string): boolean {
    this.expires.delete(key);
    this.access.delete(key);
    return this.data.delete(key);
  }

  /** Deletes the key when it holds an empty aggregate (Redis never keeps empty hashes/lists/sets/zsets). */
  removeIfEmpty(key: string): void {
    const v = this.data.get(key);
    if (!v) return;
    const empty =
      (v.type === 'hash' && v.value.size === 0) ||
      (v.type === 'list' && v.value.length === 0) ||
      (v.type === 'set' && v.value.size === 0) ||
      (v.type === 'zset' && v.value.size === 0);
    if (empty) this.remove(key);
  }

  /** Absolute expiry (ms) or undefined. */
  getExpire(key: string): number | undefined {
    return this.peek(key) ? this.expires.get(key) : undefined;
  }

  setExpire(key: string, at: number): void {
    this.expires.set(key, at);
  }

  persist(key: string): boolean {
    return this.expires.delete(key);
  }

  keys(): string[] {
    const now = Date.now();
    const out: string[] = [];
    for (const key of this.data.keys()) {
      const at = this.expires.get(key);
      if (at === undefined || at > now) out.push(key);
    }
    return out;
  }

  swapWith(other: Database): void {
    [this.data, other.data] = [other.data, this.data];
    [this.expires, other.expires] = [other.expires, this.expires];
    [this.access, other.access] = [other.access, this.access];
  }

  flush(): void {
    this.data.clear();
    this.expires.clear();
    this.access.clear();
  }

  /** Active expiry: deletes up to `limit` expired keys. */
  sweep(now: number, limit = 1000): void {
    let n = 0;
    for (const [key, at] of this.expires) {
      if (at <= now) {
        this.remove(key);
        this.onExpired(key);
        if (++n >= limit) break;
      }
    }
  }

  // ---- LRU / LFU ------------------------------------------------------------------------------------------------

  private newAccess(): Access {
    const now = Date.now();
    return { at: now, counter: LFU_INIT_VAL, decrementedAt: Math.floor(now / 60000) };
  }

  /** TOUCH and every normal read/write: LRU → refresh time; LFU → decay, then logarithmic increment. */
  recordAccess(key: string): void {
    const a = this.access.get(key) ?? this.newAccess();
    const now = Date.now();
    a.at = now;
    if (this.config.lfu) {
      this.decay(a, now);
      a.counter = lfuLogIncr(a.counter, this.config.num('lfu-log-factor'));
    }
    this.access.set(key, a);
  }

  private decay(a: Access, now: number): void {
    const decayTime = this.config.num('lfu-decay-time');
    const minutes = Math.floor(now / 60000);
    const elapsed = (minutes - a.decrementedAt + 65536) % 65536;
    const periods = decayTime ? Math.floor(elapsed / decayTime) : 0;
    if (periods) {
      a.counter = Math.max(0, a.counter - periods);
      a.decrementedAt = minutes;
    }
  }

  /** RESTORE IDLETIME: backdates the last access. */
  setIdle(key: string, seconds: number): void {
    const a = this.access.get(key) ?? this.newAccess();
    a.at = Date.now() - seconds * 1000;
    this.access.set(key, a);
  }

  /** RESTORE FREQ: sets the LFU counter. */
  setFrequency(key: string, counter: number): void {
    const a = this.access.get(key) ?? this.newAccess();
    a.counter = counter;
    a.decrementedAt = Math.floor(Date.now() / 60000);
    this.access.set(key, a);
  }

  /** OBJECT IDLETIME, in seconds. */
  idleSeconds(key: string): number {
    const a = this.access.get(key);
    return a ? Math.floor((Date.now() - a.at) / 1000) : 0;
  }

  /** OBJECT FREQ: the LFU counter after decay (not stored back, as in Redis). */
  frequency(key: string): number {
    const a = this.access.get(key);
    if (!a) return 0;
    const copy = { ...a };
    this.decay(copy, Date.now());
    return copy.counter;
  }
}

/** Redis LFULogIncr: the counter grows with probability 1 / ((counter - LFU_INIT_VAL) * factor + 1). */
function lfuLogIncr(counter: number, factor: number): number {
  if (counter >= 255) return 255;
  const base = Math.max(0, counter - LFU_INIT_VAL);
  const p = 1 / (base * factor + 1);
  return Math.random() < p ? counter + 1 : counter;
}
