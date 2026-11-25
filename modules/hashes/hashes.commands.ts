import { CommandError } from '@/libs/app-error';
import { RespMessages, wrongArity } from '@/libs/resp/messages';
import type { Reply } from '@/libs/resp';
import { OK, RespMap, RespPairs } from '@/libs/resp';
import { formatFloat, INT64_MAX, INT64_MIN, intReply, isInt64, isInteger, parseFloatArg, parseInt64, parseInteger } from '@/libs/number';
import { matchGlob } from '@/libs/glob';

import { isCompact } from '@/modules/database/database.encoding';
import { parseCursor, scanPage } from '@/modules/database/database.scan';
import { parseScanOptions } from '@/modules/keys/keys.commands';
import type { CommandContext, CommandSpec } from '@/modules/command/command.types';
import { keysAt } from '@/modules/command/command.handler';

/** Per-field expiry (Redis 7.4 hash field TTL): hash map → field → absolute ms. Expired fields are dropped on access. */
const fieldExpires = new WeakMap<Map<string, string>, Map<string, number>>();

/** Field TTLs of a hash (absolute ms), for DUMP. */
export function hashFieldExpires(h: Map<string, string>): Map<string, number> | undefined {
  const ttl = fieldExpires.get(h);
  return ttl && ttl.size ? new Map(ttl) : undefined;
}

/** Restores field TTLs (RESTORE); fields whose time has passed are dropped on next access. */
export function setHashFieldExpires(h: Map<string, string>, ttl: Map<string, number>): void {
  if (ttl.size) fieldExpires.set(h, new Map(ttl));
}

/** True when any field of this hash has a TTL (Redis then uses the listpackex / hashtable-with-metadata encodings). */
export function hashHasFieldTtl(h: Map<string, string>): boolean {
  return (fieldExpires.get(h)?.size ?? 0) > 0;
}

function purgeExpiredFields(ctx: CommandContext, key: string, h: Map<string, string>): void {
  const ttl = fieldExpires.get(h);
  if (!ttl || !ttl.size) return;
  const now = Date.now();
  let expired = 0;
  for (const [field, at] of ttl) {
    if (at <= now) {
      ttl.delete(field);
      h.delete(field);
      expired++;
    }
  }
  if (!expired) return;
  ctx.db.removeIfEmpty(key);
  ctx.server.fieldsExpired(ctx.client.dbIndex, key, h.size === 0);
}

function hash(ctx: CommandContext, key: string): Map<string, string> | undefined {
  const h = ctx.db.get(key, 'hash');
  if (!h) return undefined;
  purgeExpiredFields(ctx, key, h);
  return h.size ? h : undefined;
}

function hashForWrite(ctx: CommandContext, key: string): Map<string, string> {
  hash(ctx, key);
  return ctx.db.getOrCreate(key, 'hash', () => new Map());
}

function clearFieldTtl(h: Map<string, string>, field: string): void {
  fieldExpires.get(h)?.delete(field);
}

function setFieldTtl(h: Map<string, string>, field: string, at: number): void {
  let ttl = fieldExpires.get(h);
  if (!ttl) fieldExpires.set(h, (ttl = new Map()));
  ttl.set(field, at);
}

/** Parses `FIELDS numfields field...` starting at `i`; returns the fields (and pairs when `withValues`). */
function parseFields(args: string[], i: number, withValues = false): string[] {
  if ((args[i] ?? '').toLowerCase() !== 'fields') throw new CommandError('ERR Mandatory argument FIELDS is missing or not at the right position');
  const n = parseInteger(args[i + 1] ?? '', 'ERR Number of fields must be a positive integer');
  if (n <= 0) throw new CommandError('ERR Number of fields must be a positive integer');
  const rest = args.slice(i + 2);
  if (rest.length !== (withValues ? n * 2 : n)) throw new CommandError('ERR The `numfields` parameter must match the number of arguments');
  return rest;
}

/** HEXPIRE family: one result per field (-2 no field, 0 condition not met, 1 set, 2 deleted because the time is in the past). */
function hexpire(ctx: CommandContext, args: string[], unit: number, absolute: boolean): Reply {
  const key = args[0];
  const n = parseInteger(args[1]);
  if (n < 0) throw new CommandError('ERR invalid expire time, must be >= 0');
  let i = 2;
  let cond: string | null = null;
  const opt = (args[i] ?? '').toLowerCase();
  if (['nx', 'xx', 'gt', 'lt'].includes(opt)) {
    cond = opt;
    i++;
  }
  const fields = parseFields(args, i);
  const h = hash(ctx, key);
  if (!h) return fields.map(() => -2);
  const at = absolute ? n * unit : Date.now() + n * unit;
  const out = fields.map((f) => {
    if (!h.has(f)) return -2;
    const current = fieldExpires.get(h)?.get(f);
    if (cond === 'nx' && current !== undefined) return 0;
    if (cond === 'xx' && current === undefined) return 0;
    if (cond === 'gt' && (current === undefined || at <= current)) return 0;
    if (cond === 'lt' && current !== undefined && at >= current) return 0;
    if (at <= Date.now()) {
      h.delete(f);
      clearFieldTtl(h, f);
      return 2;
    }
    setFieldTtl(h, f, at);
    return 1;
  });
  ctx.db.removeIfEmpty(key);
  return out;
}

/** HTTL family: -2 no field, -1 no TTL, else remaining (or absolute) time in `unit`. */
function httl(ctx: CommandContext, args: string[], unit: number, absolute: boolean): Reply {
  const fields = parseFields(args, 1);
  const h = hash(ctx, args[0]);
  return fields.map((f) => {
    if (!h?.has(f)) return -2;
    const at = fieldExpires.get(h)?.get(f);
    if (at === undefined) return -1;
    return absolute ? Math.floor(at / unit) : Math.max(0, Math.round((at - Date.now()) / unit));
  });
}

/** `EX s | PX ms | EXAT ts | PXAT ms-ts` at args[i] → absolute ms, or null when the token is not one of them. */
function parseFieldExpiry(args: string[], i: number): number | null {
  const opt = (args[i] ?? '').toLowerCase();
  if (!['ex', 'px', 'exat', 'pxat'].includes(opt)) return null;
  const n = parseInteger(args[i + 1] ?? '');
  if (n <= 0) throw new CommandError("ERR invalid expire time in 'hgetex' command");
  const unit = opt === 'ex' || opt === 'exat' ? 1000 : 1;
  return opt.endsWith('at') ? n * unit : Date.now() + n * unit;
}

function hset(ctx: CommandContext, args: string[], name: string): number {
  if (args.length < 3 || args.length % 2 === 0) throw new CommandError(wrongArity(name));
  const h = hashForWrite(ctx, args[0]);
  let added = 0;
  for (let i = 1; i < args.length; i += 2) {
    if (!h.has(args[i])) added++;
    h.set(args[i], args[i + 1]);
    clearFieldTtl(h, args[i]);
  }
  return added;
}

const W = { write: true } as const;

export const hashCommands: CommandSpec[] = [
  { name: 'hexpire', arity: -6, flags: W, keys: keysAt(0), handler: (ctx, args) => hexpire(ctx, args, 1000, false) },
  { name: 'hpexpire', arity: -6, flags: W, keys: keysAt(0), handler: (ctx, args) => hexpire(ctx, args, 1, false) },
  { name: 'hexpireat', arity: -6, flags: W, keys: keysAt(0), handler: (ctx, args) => hexpire(ctx, args, 1000, true) },
  { name: 'hpexpireat', arity: -6, flags: W, keys: keysAt(0), handler: (ctx, args) => hexpire(ctx, args, 1, true) },
  { name: 'httl', arity: -5, handler: (ctx, args) => httl(ctx, args, 1000, false) },
  { name: 'hpttl', arity: -5, handler: (ctx, args) => httl(ctx, args, 1, false) },
  { name: 'hexpiretime', arity: -5, handler: (ctx, args) => httl(ctx, args, 1000, true) },
  { name: 'hpexpiretime', arity: -5, handler: (ctx, args) => httl(ctx, args, 1, true) },
  {
    name: 'hpersist',
    arity: -5,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const fields = parseFields(args, 1);
      const h = hash(ctx, args[0]);
      return fields.map((f) => {
        if (!h?.has(f)) return -2;
        const ttl = fieldExpires.get(h);
        return ttl?.delete(f) ? 1 : -1;
      });
    },
  },
  {
    name: 'hgetdel',
    arity: -5,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const fields = parseFields(args, 1);
      const h = hash(ctx, args[0]);
      const out = fields.map((f) => {
        const v = h?.get(f);
        if (v === undefined || !h) return null;
        h.delete(f);
        clearFieldTtl(h, f);
        return v;
      });
      ctx.db.removeIfEmpty(args[0]);
      return out;
    },
  },
  {
    name: 'hgetex',
    arity: -5,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      let i = 1;
      let persist = false;
      const at = parseFieldExpiry(args, i);
      if (at !== null) i += 2;
      else if ((args[i] ?? '').toLowerCase() === 'persist') {
        persist = true;
        i++;
      }
      const fields = parseFields(args, i);
      const h = hash(ctx, args[0]);
      return fields.map((f) => {
        const v = h?.get(f);
        if (v === undefined || !h) return null;
        if (persist) clearFieldTtl(h, f);
        else if (at !== null) setFieldTtl(h, f, at);
        return v;
      });
    },
  },
  {
    name: 'hsetex',
    arity: -6,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      let i = 1;
      let fnx = false;
      let fxx = false;
      let keepTtl = false;
      let at: number | null = null;
      let expiryOptions = 0;
      for (;;) {
        const opt = (args[i] ?? '').toLowerCase();
        if (opt === 'fnx') {
          if (fxx) throw new CommandError('ERR Only one of FXX or FNX arguments can be specified');
          fnx = true;
        } else if (opt === 'fxx') {
          if (fnx) throw new CommandError('ERR Only one of FXX or FNX arguments can be specified');
          fxx = true;
        } else if (opt === 'keepttl') {
          keepTtl = true;
          expiryOptions++;
        } else {
          const parsed = parseFieldExpiry(args, i);
          if (parsed === null) break;
          at = parsed;
          expiryOptions++;
          i++;
        }
        if (expiryOptions > 1) throw new CommandError('ERR Only one of EX, PX, EXAT, PXAT or KEEPTTL arguments can be specified');
        i++;
      }
      const pairs = parseFields(args, i, true);
      const existing = hash(ctx, args[0]);
      const fieldNames = pairs.filter((_, j) => j % 2 === 0);
      if (fnx && fieldNames.some((f) => existing?.has(f))) return 0;
      if (fxx && !fieldNames.every((f) => existing?.has(f))) return 0;
      const h = hashForWrite(ctx, args[0]);
      for (let j = 0; j < pairs.length; j += 2) {
        h.set(pairs[j], pairs[j + 1]);
        if (at !== null) setFieldTtl(h, pairs[j], at);
        else if (!keepTtl) clearFieldTtl(h, pairs[j]);
      }
      return 1;
    },
  },
  { name: 'hset', arity: -4, flags: W, keys: keysAt(0), handler: (ctx, args) => hset(ctx, args, 'hset') },
  {
    name: 'hmset',
    arity: -4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      hset(ctx, args, 'hmset');
      return OK;
    },
  },
  {
    name: 'hsetnx',
    arity: 4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const h = hashForWrite(ctx, args[0]);
      if (h.has(args[1])) return 0;
      h.set(args[1], args[2]);
      return 1;
    },
  },
  { name: 'hget', arity: 3, handler: (ctx, args) => hash(ctx, args[0])?.get(args[1]) ?? null },
  {
    name: 'hmget',
    arity: -3,
    handler: (ctx, args) => {
      const h = hash(ctx, args[0]);
      return args.slice(1).map((f) => h?.get(f) ?? null);
    },
  },
  {
    name: 'hgetall',
    arity: 2,
    handler: (ctx, args) => {
      return new RespMap([...(hash(ctx, args[0]) ?? [])]);
    },
  },
  {
    name: 'hdel',
    arity: -3,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const h = hash(ctx, args[0]);
      if (!h) return 0;
      let n = 0;
      for (const f of args.slice(1)) {
        if (h.delete(f)) n++;
        clearFieldTtl(h, f);
      }
      ctx.db.removeIfEmpty(args[0]);
      return n;
    },
  },
  { name: 'hexists', arity: 3, handler: (ctx, args) => (hash(ctx, args[0])?.has(args[1]) ? 1 : 0) },
  { name: 'hlen', arity: 2, handler: (ctx, args) => hash(ctx, args[0])?.size ?? 0 },
  { name: 'hkeys', arity: 2, handler: (ctx, args) => [...(hash(ctx, args[0])?.keys() ?? [])] },
  { name: 'hvals', arity: 2, handler: (ctx, args) => [...(hash(ctx, args[0])?.values() ?? [])] },
  { name: 'hstrlen', arity: 3, handler: (ctx, args) => hash(ctx, args[0])?.get(args[1])?.length ?? 0 },
  {
    name: 'hincrby',
    arity: 4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const delta = parseInt64(args[2]);
      const h = hashForWrite(ctx, args[0]);
      const cur = h.get(args[1]);
      if (cur !== undefined && !isInt64(cur)) throw new CommandError(RespMessages.HASH_NOT_INTEGER);
      const result = (cur === undefined ? 0n : BigInt(cur)) + delta;
      if (result < INT64_MIN || result > INT64_MAX) throw new CommandError(RespMessages.INCR_OVERFLOW);
      h.set(args[1], result.toString());
      return intReply(result);
    },
  },
  {
    name: 'hincrbyfloat',
    arity: 4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const delta = parseFloatArg(args[2]);
      const h = hashForWrite(ctx, args[0]);
      const cur = h.get(args[1]);
      const base = cur === undefined ? 0 : parseFloatArg(cur, RespMessages.HASH_NOT_FLOAT);
      const result = base + delta;
      if (!Number.isFinite(result)) throw new CommandError(RespMessages.NAN_OR_INF);
      const text = formatFloat(result);
      h.set(args[1], text);
      return text;
    },
  },
  {
    name: 'hscan',
    arity: -3,
    handler: (ctx, args) => {
      const cursor = parseCursor(args[1]);
      if (cursor === null) throw new CommandError('ERR invalid cursor');
      const { match, noValues, count } = parseScanOptions(args, 2);
      const h = hash(ctx, args[0]);
      if (!h) return ['0', []];
      const value = ctx.db.peek(args[0]);
      const compact = value !== undefined && isCompact(value, ctx.server.config);
      const { next, page } = compact ? { next: 0, page: [...h.keys()] } : scanPage(h.keys(), cursor, count);
      const out: string[] = [];
      for (const f of page) {
        if (!matchGlob(match, f)) continue;
        if (noValues) out.push(f);
        else out.push(f, h.get(f) ?? '');
      }
      return [String(next), out];
    },
  },
  {
    name: 'hrandfield',
    arity: -2,
    handler: (ctx, args) => {
      const h = hash(ctx, args[0]);
      const fields = [...(h?.keys() ?? [])];
      if (args.length === 1) return fields.length ? fields[Math.floor(Math.random() * fields.length)] : null;
      const count = parseInteger(args[1]);
      if (args.length > 3 || (args.length === 3 && args[2].toLowerCase() !== 'withvalues')) throw new CommandError(RespMessages.SYNTAX);
      const withValues = args.length === 3;
      const picked = count >= 0 ? fields.sort(() => Math.random() - 0.5).slice(0, count) : Array.from({ length: fields.length ? -count : 0 }, () => fields[Math.floor(Math.random() * fields.length)]);
      return withValues ? new RespPairs(picked.map((f) => [f, h?.get(f) ?? ''])) : picked;
    },
  },
];
