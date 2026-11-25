import type { ServerConfig } from '@/modules/server/server.service';

import type { ListLimit, RedisValue } from './database.types';

/**
 * Redis object encodings (what OBJECT ENCODING reports) and the rules Redis uses to move between them.
 * Aggregate conversions are sticky like in Redis (a hash never goes back from hashtable to listpack), except lists,
 * which Redis converts back from quicklist to listpack once they shrink to half the limit.
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
    listpackex: 1,
    quicklist: 2,
    hashtable: 2,
    skiplist: 2,
  };

  /** list-max-listpack-size -1 … -5: 4KB … 64KB. */
  private static readonly LIST_BYTE_LIMITS = [4096, 8192, 16384, 32768, 65536];

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

  /** List size limit for list-max-listpack-size: positive = entries, negative = bytes (-1 4KB … -5 64KB). */
  private static listLimit(config: ServerConfig): ListLimit {
    const fill = config.num('list-max-listpack-size');
    if (fill >= 0) return { entries: fill, bytes: Infinity };
    const bytes = DatabaseEncodingService.LIST_BYTE_LIMITS[Math.min(4, -fill - 1)];
    return { entries: Infinity, bytes };
  }

  /** Smallest possible listpack bytes for n entries (2 bytes each + header/terminator). */
  private static minListpackBytes(n: number): number {
    return 7 + 2 * n;
  }

  private static naturalEncoding(v: RedisValue, config: ServerConfig, hasFieldTtl: boolean): string {
    const self = DatabaseEncodingService;
    switch (v.type) {
      case 'string':
        if (v.raw) return 'raw';
        if (self.isRedisInteger(v.value)) return 'int';
        return v.value.length <= 44 ? 'embstr' : 'raw';
      case 'hash': {
        const max = config.num('hash-max-listpack-entries');
        const maxValue = config.num('hash-max-listpack-value');
        if (v.value.size > max) return 'hashtable';
        for (const [f, val] of v.value) if (f.length > maxValue || val.length > maxValue) return 'hashtable';
        return hasFieldTtl ? 'listpackex' : 'listpack';
      }
      case 'list': {
        const limit = self.listLimit(config);
        if (v.value.length > limit.entries) return 'quicklist';
        if (limit.bytes !== Infinity && self.listpackSize(v.value) > limit.bytes) return 'quicklist';
        return 'listpack';
      }
      case 'set': {
        const all = [...v.value];
        if (all.every((m) => self.isRedisInteger(m)) && all.length <= config.num('set-max-intset-entries')) return 'intset';
        const maxValue = config.num('set-max-listpack-value');
        if (all.length <= config.num('set-max-listpack-entries') && all.every((m) => m.length <= maxValue)) return 'listpack';
        return 'hashtable';
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
   * and compact encodings are small by definition. Lists are only rescanned when they could fit a listpack again.
   */
  static updateEncoding(v: RedisValue, config: ServerConfig, hasFieldTtl = false): void {
    const self = DatabaseEncodingService;
    if (v.type === 'string' || v.type === 'stream') return;
    const holder = v.value as object;
    const current = self.sticky.get(holder);
    if (current === 'hashtable' || current === 'skiplist') return;
    if (current === 'quicklist' && v.type === 'list') {
      const limit = self.listLimit(config);
      const n = v.value.length;
      if (n > limit.entries / 2 || (limit.bytes !== Infinity && self.minListpackBytes(n) > limit.bytes / 2)) return;
    }
    if (current === 'listpack' && v.type === 'list') {
      const limit = self.listLimit(config);
      const n = v.value.length;
      // Definitely too big for a listpack: convert without scanning.
      if (n > limit.entries || (limit.bytes !== Infinity && self.minListpackBytes(n) > limit.bytes)) {
        self.sticky.set(holder, 'quicklist');
        return;
      }
    }
    const natural = self.naturalEncoding(v, config, hasFieldTtl);
    if (current === undefined) {
      self.sticky.set(holder, natural);
      return;
    }
    if (v.type === 'list' && current === 'quicklist') {
      // Redis turns a quicklist back into a listpack once it fits in half of the limit.
      const limit = self.listLimit(config);
      const halfEntries = limit.entries === Infinity ? Infinity : limit.entries / 2;
      const fits = v.value.length <= halfEntries && (limit.bytes === Infinity || self.listpackSize(v.value) <= limit.bytes / 2);
      if (fits) self.sticky.set(holder, 'listpack');
      return;
    }
    if (v.type === 'hash' && (current === 'listpack' || current === 'listpackex') && natural !== 'hashtable') {
      self.sticky.set(holder, natural);
      return;
    }
    if ((self.RANK[natural] ?? 0) > (self.RANK[current] ?? 0)) self.sticky.set(holder, natural);
  }

  /** OBJECT ENCODING: the current encoding (fixed on first use for aggregates). */
  static objectEncoding(v: RedisValue, config: ServerConfig, hasFieldTtl = false): string {
    const self = DatabaseEncodingService;
    if (v.type === 'string' || v.type === 'stream') return self.naturalEncoding(v, config, hasFieldTtl);
    const current = self.sticky.get(v.value as object);
    if (current !== undefined) return current;
    const natural = self.naturalEncoding(v, config, hasFieldTtl);
    self.sticky.set(v.value as object, natural);
    return natural;
  }

  /** Copies the encoding of one aggregate to another (COPY / DUMP+RESTORE keep Redis's encoding choice). */
  static copyEncoding(from: RedisValue, to: RedisValue): void {
    const enc = DatabaseEncodingService.sticky.get(from.value as object);
    if (enc !== undefined && typeof to.value === 'object') DatabaseEncodingService.sticky.set(to.value as object, enc);
  }

  /** True when the aggregate is in a compact encoding that SCAN-family commands return in a single call. */
  static isCompact(v: RedisValue, config: ServerConfig): boolean {
    const enc = DatabaseEncodingService.objectEncoding(v, config);
    return enc === 'listpack' || enc === 'listpackex' || enc === 'intset';
  }
}
