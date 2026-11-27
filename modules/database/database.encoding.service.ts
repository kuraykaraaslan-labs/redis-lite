import type { ServerConfig } from '@/modules/server/server.service';

import type { RedisValue } from './database.types';

/**
 * Redis 7.0 object encodings (what OBJECT ENCODING reports) and the rules Redis uses to move between them.
 * Aggregate conversions are sticky like in Redis (a hash never goes back from hashtable to listpack). Every list is a
 * quicklist in 7.0, and a set is an intset or a hashtable (7.0 has no listpack sets).
 */
export default class DatabaseEncodingService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** The encoding an aggregate reached, keyed by its in-memory value (encodings only move up, see the class doc). */
  private static readonly sticky = new WeakMap<object, string>();

  private static readonly RANK: Record<string, number> = {
    intset: 0,
    listpack: 1,
    quicklist: 2,
    hashtable: 2,
    skiplist: 2,
  };

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static backlenSize(len: number): number {
    if (len < 128) return 1;
    if (len < 16384) return 2;
    if (len < 2097152) return 3;
    if (len < 268435456) return 4;
    return 5;
  }

  private static naturalEncoding(v: RedisValue, config: ServerConfig): string {
    const self = DatabaseEncodingService;
    switch (v.type) {
      case 'string':
        if (v.raw) return 'raw';
        if (!v.noInt && self.isRedisInteger(v.value)) return 'int';
        return v.value.length <= 44 ? 'embstr' : 'raw';
      case 'hash': {
        const max = config.num('hash-max-listpack-entries');
        const maxValue = config.num('hash-max-listpack-value');
        if (v.value.size > max) return 'hashtable';
        for (const [f, val] of v.value) if (f.length > maxValue || val.length > maxValue) return 'hashtable';
        return 'listpack';
      }
      case 'list':
        return 'quicklist';
      case 'set': {
        if (v.value.size > config.num('set-max-intset-entries')) return 'hashtable';
        for (const m of v.value) if (!self.isRedisInteger(m)) return 'hashtable';
        return 'intset';
      }
      case 'zset': {
        const maxValue = config.num('zset-max-listpack-value');
        if (v.value.size > config.num('zset-max-listpack-entries')) return 'skiplist';
        for (const e of v.value.entries) if (e.member.length > maxValue) return 'skiplist';
        return 'listpack';
      }
      case 'stream':
        return 'stream';
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Redis string2ll: the exact integer forms Redis accepts (no '+', no leading zeros, no spaces, fits int64). */
  static isRedisInteger(s: string): boolean {
    const len = s.length;
    if (len === 0 || len > 20) return false;
    // Fast rejection: integers start with a digit or '-'.
    const c = s.charCodeAt(0);
    if (c !== 45 && (c < 48 || c > 57)) return false;
    if (!/^(0|-?[1-9]\d*)$/.test(s)) return false;
    if (len < 19) return true;
    const n = BigInt(s);
    return n >= -(2n ** 63n) && n <= 2n ** 63n - 1n;
  }

  /** Bytes one element takes inside a listpack (encoding + data + backlen), as Redis encodes it. */
  static listpackEntrySize(value: string): number {
    let body: number;
    if (DatabaseEncodingService.isRedisInteger(value)) {
      const n = Number(value);
      if (n >= 0 && n <= 127) body = 1;
      else if (n >= -4096 && n <= 4095) body = 2;
      else if (n >= -32768 && n <= 32767) body = 3;
      else if (n >= -8388608 && n <= 8388607) body = 4;
      else if (n >= -2147483648 && n <= 2147483647) body = 5;
      else body = 9;
    } else if (value.length < 64) body = 1 + value.length;
    else if (value.length < 4096) body = 2 + value.length;
    else body = 5 + value.length;
    return body + DatabaseEncodingService.backlenSize(body);
  }

  /** Total listpack bytes: 6-byte header + entries + 1-byte terminator. */
  static listpackSize(values: Iterable<string>): number {
    let total = 7;
    for (const v of values) total += DatabaseEncodingService.listpackEntrySize(v);
    return total;
  }

  /**
   * Re-evaluates the encoding after a write, applying Redis's one-way conversion rules.
   * Cost is bounded: once an aggregate reached its full encoding (hashtable / skiplist) nothing is scanned again,
   * and compact encodings are small by definition.
   */
  static updateEncoding(v: RedisValue, config: ServerConfig): void {
    const self = DatabaseEncodingService;
    if (v.type === 'string' || v.type === 'stream' || v.type === 'list') return;
    const holder = v.value as object;
    const current = self.sticky.get(holder);
    if (current === 'hashtable' || current === 'skiplist') return;
    const natural = self.naturalEncoding(v, config);
    if (current === undefined) {
      self.sticky.set(holder, natural);
      return;
    }
    if ((self.RANK[natural] ?? 0) > (self.RANK[current] ?? 0)) self.sticky.set(holder, natural);
  }

  /** OBJECT ENCODING: the current encoding (fixed on first use for aggregates). */
  static objectEncoding(v: RedisValue, config: ServerConfig): string {
    const self = DatabaseEncodingService;
    if (v.type === 'string' || v.type === 'stream' || v.type === 'list') return self.naturalEncoding(v, config);
    const current = self.sticky.get(v.value as object);
    if (current !== undefined) return current;
    const natural = self.naturalEncoding(v, config);
    self.sticky.set(v.value as object, natural);
    return natural;
  }

  /** The encoding an aggregate already reached, if it was ever evaluated (no config needed: RDB writers use it). */
  static knownEncoding(v: RedisValue): string | undefined {
    return typeof v.value === 'object' ? DatabaseEncodingService.sticky.get(v.value as object) : undefined;
  }

  /** Copies the encoding of one aggregate to another (COPY / DUMP+RESTORE keep Redis's encoding choice). */
  static copyEncoding(from: RedisValue, to: RedisValue): void {
    const enc = DatabaseEncodingService.sticky.get(from.value as object);
    if (enc !== undefined && typeof to.value === 'object') DatabaseEncodingService.sticky.set(to.value as object, enc);
  }

  /** True when the aggregate is in a compact encoding that SCAN-family commands return in a single call. */
  static isCompact(v: RedisValue, config: ServerConfig): boolean {
    const enc = DatabaseEncodingService.objectEncoding(v, config);
    return enc === 'listpack' || enc === 'intset';
  }
}
