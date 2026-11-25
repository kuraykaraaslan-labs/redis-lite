import type { ServerConfig } from '../server/config';
import type { RedisValue } from './database';

/**
 * Redis object encodings (what OBJECT ENCODING reports) and the rules Redis uses to move between them.
 * Aggregate conversions are sticky like in Redis (a hash never goes back from hashtable to listpack), except lists,
 * which Redis converts back from quicklist to listpack once they shrink to half the limit.
 */

const sticky = new WeakMap<object, string>();

/** Redis string2ll: the exact integer forms Redis accepts (no '+', no leading zeros, no spaces, fits int64). */
export function isRedisInteger(s: string): boolean {
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

// ---- listpack sizes ---------------------------------------------------------------------------------------------

function backlenSize(len: number): number {
  if (len < 128) return 1;
  if (len < 16384) return 2;
  if (len < 2097152) return 3;
  if (len < 268435456) return 4;
  return 5;
}

/** Bytes one element takes inside a listpack (encoding + data + backlen), as Redis encodes it. */
export function listpackEntrySize(value: string): number {
  let body: number;
  if (isRedisInteger(value)) {
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
  return body + backlenSize(body);
}

/** Total listpack bytes: 6-byte header + entries + 1-byte terminator. */
export function listpackSize(values: Iterable<string>): number {
  let total = 7;
  for (const v of values) total += listpackEntrySize(v);
  return total;
}

// ---- encodings --------------------------------------------------------------------------------------------------

const RANK: Record<string, number> = {
  intset: 0,
  listpack: 1,
  listpackex: 1,
  quicklist: 2,
  hashtable: 2,
  skiplist: 2,
};

/** List size limit for list-max-listpack-size: positive = entries, negative = bytes (-1 4KB … -5 64KB). */
function listLimit(config: ServerConfig): { entries: number; bytes: number } {
  const fill = config.num('list-max-listpack-size');
  if (fill >= 0) return { entries: fill, bytes: Infinity };
  const bytes = [4096, 8192, 16384, 32768, 65536][Math.min(4, -fill - 1)];
  return { entries: Infinity, bytes };
}

function naturalEncoding(v: RedisValue, config: ServerConfig, hasFieldTtl: boolean): string {
  switch (v.type) {
    case 'string':
      if (v.raw) return 'raw';
      if (isRedisInteger(v.value)) return 'int';
      return v.value.length <= 44 ? 'embstr' : 'raw';
    case 'hash': {
      const max = config.num('hash-max-listpack-entries');
      const maxValue = config.num('hash-max-listpack-value');
      if (v.value.size > max) return 'hashtable';
      for (const [f, val] of v.value) if (f.length > maxValue || val.length > maxValue) return 'hashtable';
      return hasFieldTtl ? 'listpackex' : 'listpack';
    }
    case 'list': {
      const limit = listLimit(config);
      if (v.value.length > limit.entries) return 'quicklist';
      if (limit.bytes !== Infinity && listpackSize(v.value) > limit.bytes) return 'quicklist';
      return 'listpack';
    }
    case 'set': {
      const all = [...v.value];
      if (all.every(isRedisInteger) && all.length <= config.num('set-max-intset-entries')) return 'intset';
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

/** Smallest possible listpack bytes for n entries (2 bytes each + header/terminator). */
function minListpackBytes(n: number): number {
  return 7 + 2 * n;
}

/**
 * Re-evaluates the encoding after a write, applying Redis's one-way conversion rules.
 * Cost is bounded: once an aggregate reached its full encoding (hashtable / skiplist) nothing is scanned again,
 * and compact encodings are small by definition. Lists are only rescanned when they could fit a listpack again.
 */
export function updateEncoding(v: RedisValue, config: ServerConfig, hasFieldTtl = false): void {
  if (v.type === 'string' || v.type === 'stream') return;
  const holder = v.value as object;
  const current = sticky.get(holder);
  if (current === 'hashtable' || current === 'skiplist') return;
  if (current === 'quicklist' && v.type === 'list') {
    const limit = listLimit(config);
    const n = v.value.length;
    if (n > limit.entries / 2 || (limit.bytes !== Infinity && minListpackBytes(n) > limit.bytes / 2)) return;
  }
  if (current === 'listpack' && v.type === 'list') {
    const limit = listLimit(config);
    const n = v.value.length;
    // Definitely too big for a listpack: convert without scanning.
    if (n > limit.entries || (limit.bytes !== Infinity && minListpackBytes(n) > limit.bytes)) {
      sticky.set(holder, 'quicklist');
      return;
    }
  }
  const natural = naturalEncoding(v, config, hasFieldTtl);
  if (current === undefined) {
    sticky.set(holder, natural);
    return;
  }
  if (v.type === 'list' && current === 'quicklist') {
    // Redis turns a quicklist back into a listpack once it fits in half of the limit.
    const limit = listLimit(config);
    const halfEntries = limit.entries === Infinity ? Infinity : limit.entries / 2;
    const fits = v.value.length <= halfEntries && (limit.bytes === Infinity || listpackSize(v.value) <= limit.bytes / 2);
    if (fits) sticky.set(holder, 'listpack');
    return;
  }
  if (v.type === 'hash' && (current === 'listpack' || current === 'listpackex') && natural !== 'hashtable') {
    sticky.set(holder, natural);
    return;
  }
  if ((RANK[natural] ?? 0) > (RANK[current] ?? 0)) sticky.set(holder, natural);
}

export function objectEncoding(v: RedisValue, config: ServerConfig, hasFieldTtl = false): string {
  if (v.type === 'string' || v.type === 'stream') return naturalEncoding(v, config, hasFieldTtl);
  const current = sticky.get(v.value as object);
  if (current !== undefined) return current;
  const natural = naturalEncoding(v, config, hasFieldTtl);
  sticky.set(v.value as object, natural);
  return natural;
}

/** Copies the encoding of one aggregate to another (COPY / DUMP+RESTORE keep Redis's encoding choice). */
export function copyEncoding(from: RedisValue, to: RedisValue): void {
  const enc = sticky.get(from.value as object);
  if (enc !== undefined && typeof to.value === 'object') sticky.set(to.value as object, enc);
}

/** True when the aggregate is in a compact encoding that SCAN-family commands return in a single call. */
export function isCompact(v: RedisValue, config: ServerConfig): boolean {
  const enc = objectEncoding(v, config);
  return enc === 'listpack' || enc === 'listpackex' || enc === 'intset';
}
