import { CommandError } from '../errors';
import { RespMessages, unknownSubcommand } from '../messages';
import type { Reply } from '../resp';
import { OK, Status } from '../resp';
import type { RedisValue } from '../store/database';
import { Stream } from '../store/stream';
import { ZSet } from '../store/zset';
import { objectEncoding } from '../store/encoding';
import { parseCursor, scanPage } from '../store/scan';
import { INT64_MAX, INT64_MIN, matchGlob, parseInt64, parseInteger } from '../util';
import { hashHasFieldTtl } from './hashes';
import type { CommandContext, CommandSpec } from './types';
import { keysAt } from './types';

export function cloneValue(v: RedisValue): RedisValue {
  switch (v.type) {
    case 'string':
      return { type: 'string', value: v.value };
    case 'hash':
      return { type: 'hash', value: new Map(v.value) };
    case 'list':
      return { type: 'list', value: [...v.value] };
    case 'set':
      return { type: 'set', value: new Set(v.value) };
    case 'zset': {
      const z = new ZSet();
      for (const e of v.value.entries) z.add(e.member, e.score);
      return { type: 'zset', value: z };
    }
    case 'stream': {
      const s = new Stream();
      s.entries = v.value.entries.map((e) => ({ id: e.id, fields: [...e.fields] }));
      s.lastId = v.value.lastId;
      s.entriesAdded = v.value.entriesAdded;
      s.maxDeletedId = v.value.maxDeletedId;
      return { type: 'stream', value: s };
    }
  }
}

/** Parses SCAN-family options (MATCH, COUNT, TYPE, NOVALUES). */
export function parseScanOptions(args: string[], from: number): { match: string; type: string | null; noValues: boolean; count: number } {
  let match = '*';
  let type: string | null = null;
  let noValues = false;
  let count = 10;
  for (let i = from; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    if (opt === 'match' && i + 1 < args.length) match = args[++i];
    else if (opt === 'count' && i + 1 < args.length) {
      count = parseInteger(args[++i]);
      if (count < 1) throw new CommandError(RespMessages.SYNTAX);
    } else if (opt === 'type' && i + 1 < args.length) type = args[++i].toLowerCase();
    else if (opt === 'novalues') noValues = true;
    else throw new CommandError(RespMessages.SYNTAX);
  }
  return { match, type, noValues, count };
}

/**
 * Expire family. `unit` ms multiplier, `absolute` for *AT forms. Supports NX/XX/GT/LT.
 * Returns 1 when the timeout was set (or the key deleted because the time is in the past), else 0.
 */
function expire(ctx: CommandContext, args: string[], unit: number, absolute: boolean, command: string): Reply {
  const [key, raw] = args;
  const n = parseInt64(raw);
  let nx = false;
  let xx = false;
  let gt = false;
  let lt = false;
  for (const given of args.slice(2)) {
    const opt = given.toLowerCase();
    if (opt === 'nx') nx = true;
    else if (opt === 'xx') xx = true;
    else if (opt === 'gt') gt = true;
    else if (opt === 'lt') lt = true;
    else throw new CommandError(`ERR Unsupported option ${given}`);
  }
  if (nx && (xx || gt || lt)) throw new CommandError('ERR NX and XX, GT or LT options at the same time are not compatible');
  if (gt && lt) throw new CommandError('ERR GT and LT options at the same time are not compatible');
  // Like Redis, a time that overflows int64 once converted to absolute ms is an error.
  const ms = n * BigInt(unit);
  const atBig = absolute ? ms : ms + BigInt(Date.now());
  const invalid = new CommandError(`ERR invalid expire time in '${command}' command`);
  if (ms > INT64_MAX || ms < INT64_MIN || atBig > INT64_MAX || atBig < INT64_MIN) throw invalid;
  if (!ctx.db.has(key)) return 0;
  const at = Number(atBig);
  const current = ctx.db.getExpire(key);
  if (nx && current !== undefined) return 0;
  if (xx && current === undefined) return 0;
  if (gt && (current === undefined || at <= current)) return 0;
  if (lt && current !== undefined && at >= current) return 0;
  if (at <= Date.now()) {
    ctx.db.remove(key);
    return 1;
  }
  ctx.db.setExpire(key, at);
  return 1;
}

function ttl(ctx: CommandContext, key: string, unit: number, absolute: boolean): number {
  if (!ctx.db.has(key)) return -2;
  const at = ctx.db.getExpire(key);
  if (at === undefined) return -1;
  if (absolute) return unit === 1 ? at : Math.floor((at + 500) / 1000);
  return Math.max(0, Math.round((at - Date.now()) / unit));
}

function rename(ctx: CommandContext, args: string[], nx: boolean): Reply {
  const [from, to] = args;
  const v = ctx.db.lookup(from);
  if (!v) throw new CommandError(RespMessages.NO_SUCH_KEY);
  if (from === to) return nx ? 0 : OK;
  if (nx && ctx.db.has(to)) return 0;
  const at = ctx.db.getExpire(from);
  ctx.db.remove(from);
  ctx.db.set(to, v);
  if (at !== undefined) ctx.db.setExpire(to, at);
  return nx ? 1 : OK;
}

export const keyCommands: CommandSpec[] = [
  {
    name: 'del',
    arity: -2,
    flags: { write: true },
    keys: keysAt(0, -1),
    handler: (ctx, args) => args.reduce((n, k) => n + (ctx.db.lookup(k) && ctx.db.remove(k) ? 1 : 0), 0),
  },
  {
    name: 'unlink',
    arity: -2,
    flags: { write: true },
    keys: keysAt(0, -1),
    handler: (ctx, args) => args.reduce((n, k) => n + (ctx.db.lookup(k) && ctx.db.remove(k) ? 1 : 0), 0),
  },
  { name: 'exists', arity: -2, handler: (ctx, args) => args.reduce((n, k) => n + (ctx.db.has(k) ? 1 : 0), 0) },
  {
    name: 'touch',
    arity: -2,
    handler: (ctx, args) =>
      args.reduce((n, k) => {
        if (!ctx.db.peek(k)) return n;
        ctx.db.recordAccess(k);
        return n + 1;
      }, 0),
  },
  { name: 'type', arity: 2, handler: (ctx, args) => new Status(ctx.db.peek(args[0])?.type ?? 'none') },
  { name: 'rename', arity: 3, flags: { write: true }, keys: keysAt(0, 1), handler: (ctx, args) => rename(ctx, args, false) },
  { name: 'renamenx', arity: 3, flags: { write: true }, keys: keysAt(0, 1), handler: (ctx, args) => rename(ctx, args, true) },
  {
    name: 'copy',
    arity: -3,
    flags: { write: true },
    keys: keysAt(0, 1),
    handler: (ctx, args) => {
      const [src, dst] = args;
      let replace = false;
      let target = ctx.db;
      for (let i = 2; i < args.length; i++) {
        const opt = args[i].toLowerCase();
        if (opt === 'replace') replace = true;
        else if (opt === 'db' && i + 1 < args.length) {
          const idx = parseInteger(args[++i]);
          const db = ctx.server.databases[idx];
          if (!db) throw new CommandError(RespMessages.DB_INDEX);
          target = db;
        } else throw new CommandError(RespMessages.SYNTAX);
      }
      if (target === ctx.db && src === dst) throw new CommandError('ERR source and destination objects are the same');
      const v = ctx.db.lookup(src);
      if (!v) return 0;
      if (target.has(dst) && !replace) return 0;
      target.set(dst, cloneValue(v));
      const at = ctx.db.getExpire(src);
      if (at !== undefined) target.setExpire(dst, at);
      return 1;
    },
  },
  { name: 'keys', arity: 2, handler: (ctx, args) => ctx.db.keys().filter((k) => matchGlob(args[0], k)) },
  {
    name: 'scan',
    arity: -2,
    handler: (ctx, args) => {
      const cursor = parseCursor(args[0]);
      if (cursor === null) throw new CommandError('ERR invalid cursor');
      const { match, type, count } = parseScanOptions(args, 1);
      const { next, page } = scanPage(ctx.db.keys(), cursor, count);
      // MATCH and TYPE filter after the page is taken, so pages can be short or empty, as in Redis.
      return [String(next), page.filter((k) => matchGlob(match, k) && (!type || ctx.db.peek(k)?.type === type))];
    },
  },
  {
    name: 'randomkey',
    arity: 1,
    handler: (ctx) => {
      const keys = ctx.db.keys();
      return keys.length ? keys[Math.floor(Math.random() * keys.length)] : null;
    },
  },
  { name: 'expire', arity: -3, flags: { write: true }, keys: keysAt(0), handler: (ctx, args) => expire(ctx, args, 1000, false, 'expire') },
  { name: 'pexpire', arity: -3, flags: { write: true }, keys: keysAt(0), handler: (ctx, args) => expire(ctx, args, 1, false, 'pexpire') },
  { name: 'expireat', arity: -3, flags: { write: true }, keys: keysAt(0), handler: (ctx, args) => expire(ctx, args, 1000, true, 'expireat') },
  { name: 'pexpireat', arity: -3, flags: { write: true }, keys: keysAt(0), handler: (ctx, args) => expire(ctx, args, 1, true, 'pexpireat') },
  { name: 'ttl', arity: 2, handler: (ctx, args) => ttl(ctx, args[0], 1000, false) },
  { name: 'pttl', arity: 2, handler: (ctx, args) => ttl(ctx, args[0], 1, false) },
  { name: 'expiretime', arity: 2, handler: (ctx, args) => ttl(ctx, args[0], 1000, true) },
  { name: 'pexpiretime', arity: 2, handler: (ctx, args) => ttl(ctx, args[0], 1, true) },
  {
    name: 'persist',
    arity: 2,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => (ctx.db.has(args[0]) && ctx.db.persist(args[0]) ? 1 : 0),
  },
  {
    name: 'object',
    arity: -2,
    handler: (ctx, args) => {
      const sub = args[0].toLowerCase();
      if (sub === 'help') {
        return [
          'OBJECT <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
          'ENCODING <key>',
          '    Return the kind of internal representation used in order to store the value',
          '    associated with a <key>.',
          'FREQ <key>',
          '    Return the access frequency index of the <key>. The returned integer is',
          '    proportional to the logarithm of the recent access frequency of the key.',
          'IDLETIME <key>',
          '    Return the idle time of the <key>, that is the approximated number of',
          '    seconds elapsed since the last access to the key.',
          'REFCOUNT <key>',
          '    Return the number of references of the value associated with the specified',
          '    <key>.',
          'HELP',
          '    Print this help.',
        ].map((line) => new Status(line));
      }
      if (args.length !== 2) throw new CommandError(`ERR wrong number of arguments for 'object|${sub}' command`);
      const key = args[1];
      const v = ctx.db.peek(key);
      if (sub === 'encoding') return v ? objectEncoding(v, ctx.server.config, v.type === 'hash' && hashHasFieldTtl(v.value)) : null;
      if (sub === 'refcount') {
        if (!v) return null;
        // Small integers are shared objects in Redis (OBJ_SHARED_REFCOUNT = INT_MAX) unless an LRU/LFU maxmemory policy is set.
        const shared = v.type === 'string' && !v.raw && /^(0|[1-9]\d{0,3})$/.test(v.value) && ctx.server.config.get('maxmemory') === '0';
        return shared ? 2147483647 : 1;
      }
      if (sub === 'idletime') {
        if (!v) return null;
        if (ctx.server.config.lfu) throw new CommandError('ERR An LFU maxmemory policy is selected, idle time not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.');
        return ctx.db.idleSeconds(key);
      }
      if (sub === 'freq') {
        if (!v) return null;
        if (!ctx.server.config.lfu) throw new CommandError('ERR An LFU maxmemory policy is not selected, access frequency not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.');
        return ctx.db.frequency(key);
      }
      throw new CommandError(unknownSubcommand(args[0], 'object'));
    },
  },
];
