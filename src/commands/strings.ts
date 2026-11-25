import { CommandError } from '../errors';
import { RespMessages } from '../messages';
import type { Reply } from '../resp';
import { OK } from '../resp';
import { INT64_MAX, INT64_MIN, formatFloat, intReply, parseFloatArg, parseInt64, parseInteger } from '../util';
import type { CommandContext, CommandSpec } from './types';
import { keysAt } from './types';

function getString(ctx: CommandContext, key: string): string | undefined {
  return ctx.db.get(key, 'string');
}

function putString(ctx: CommandContext, key: string, value: string, keepTtl = false, raw = false): void {
  ctx.db.set(key, raw ? { type: 'string', value, raw: true } : { type: 'string', value }, keepTtl);
}

function expireAt(ctx: CommandContext, key: string, at: number | undefined): void {
  if (at !== undefined) ctx.db.setExpire(key, at);
}

/** EX/PX/EXAT/PXAT value → absolute ms. Like Redis, values that overflow int64 once converted are invalid. */
export function parseTtl(raw: string, unit: number, absolute: boolean, command: string): number {
  const n = parseInt64(raw);
  const invalid = new CommandError(`${RespMessages.INVALID_EXPIRE} '${command}' command`);
  if (n <= 0n) throw invalid;
  const ms = n * BigInt(unit);
  const at = absolute ? ms : ms + BigInt(Date.now());
  if (ms > INT64_MAX || at > INT64_MAX) throw invalid;
  return Number(at);
}

/** proto-max-bulk-len check for commands that grow a string (SETRANGE, APPEND, SETBIT). */
export function checkStringSize(ctx: CommandContext, size: number): void {
  if (size > ctx.server.config.num('proto-max-bulk-len')) throw new CommandError('ERR string exceeds maximum allowed size (proto-max-bulk-len)');
}

function set(ctx: CommandContext, args: string[]): Reply {
  const [key, value] = args;
  let nx = false;
  let xx = false;
  let get = false;
  let keepTtl = false;
  let at: number | undefined;
  let ttlOptions = 0;
  for (let i = 2; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    const next = args[i + 1];
    if (opt === 'nx') nx = true;
    else if (opt === 'xx') xx = true;
    else if (opt === 'get') get = true;
    else if (opt === 'keepttl') {
      keepTtl = true;
      ttlOptions++;
    } else if ((opt === 'ex' || opt === 'px' || opt === 'exat' || opt === 'pxat') && next !== undefined) {
      const unit = opt === 'ex' || opt === 'exat' ? 1000 : 1;
      at = parseTtl(next, unit, opt.endsWith('at'), 'set');
      ttlOptions++;
      i++;
    } else throw new CommandError(RespMessages.SYNTAX);
  }
  if ((nx && xx) || ttlOptions > 1) throw new CommandError(RespMessages.SYNTAX);
  const old = get ? getString(ctx, key) : undefined;
  const exists = ctx.db.has(key);
  if ((nx && exists) || (xx && !exists)) {
    ctx.noop = true;
    return get ? (old ?? null) : null;
  }
  putString(ctx, key, value, keepTtl);
  expireAt(ctx, key, at);
  return get ? (old ?? null) : OK;
}

function incrBy(ctx: CommandContext, key: string, delta: bigint): Reply {
  const current = getString(ctx, key);
  const n = current === undefined ? 0n : parseInt64(current);
  const result = n + delta;
  if (result < INT64_MIN || result > INT64_MAX) throw new CommandError(RespMessages.INCR_OVERFLOW);
  putString(ctx, key, result.toString(), true);
  return intReply(result);
}

function getex(ctx: CommandContext, args: string[]): Reply {
  const [key] = args;
  const value = getString(ctx, key);
  if (value === undefined) return null;
  if (args.length === 1) return value;
  const opt = args[1].toLowerCase();
  if (opt === 'persist' && args.length === 2) ctx.db.persist(key);
  else if (['ex', 'px', 'exat', 'pxat'].includes(opt) && args.length === 3) {
    const unit = opt === 'ex' || opt === 'exat' ? 1000 : 1;
    ctx.db.setExpire(key, parseTtl(args[2], unit, opt.endsWith('at'), 'getex'));
  } else throw new CommandError(RespMessages.SYNTAX);
  return value;
}

export const stringCommands: CommandSpec[] = [
  { name: 'get', arity: 2, handler: (ctx, args) => getString(ctx, args[0]) ?? null },
  { name: 'set', arity: -3, flags: { write: true }, keys: keysAt(0), handler: set },
  {
    name: 'setex',
    arity: 4,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      const at = parseTtl(args[1], 1000, false, 'setex');
      putString(ctx, args[0], args[2]);
      expireAt(ctx, args[0], at);
      return OK;
    },
  },
  {
    name: 'psetex',
    arity: 4,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      const at = parseTtl(args[1], 1, false, 'psetex');
      putString(ctx, args[0], args[2]);
      expireAt(ctx, args[0], at);
      return OK;
    },
  },
  {
    name: 'setnx',
    arity: 3,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      if (ctx.db.has(args[0])) return 0;
      putString(ctx, args[0], args[1]);
      return 1;
    },
  },
  {
    name: 'getset',
    arity: 3,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      const old = getString(ctx, args[0]) ?? null;
      putString(ctx, args[0], args[1]);
      return old;
    },
  },
  {
    name: 'getdel',
    arity: 2,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      const v = getString(ctx, args[0]);
      if (v === undefined) return null;
      ctx.db.remove(args[0]);
      return v;
    },
  },
  { name: 'getex', arity: -2, flags: { write: true }, keys: keysAt(0), handler: getex },
  {
    name: 'mget',
    arity: -2,
    handler: (ctx, args) =>
      args.map((k) => {
        const v = ctx.db.lookup(k);
        return v?.type === 'string' ? v.value : null;
      }),
  },
  {
    name: 'mset',
    arity: -3,
    flags: { write: true },
    keys: keysAt(0, -1, 2),
    handler: (ctx, args) => {
      if (args.length % 2) throw new CommandError("ERR wrong number of arguments for 'mset' command");
      for (let i = 0; i < args.length; i += 2) putString(ctx, args[i], args[i + 1]);
      return OK;
    },
  },
  {
    name: 'msetnx',
    arity: -3,
    flags: { write: true },
    keys: keysAt(0, -1, 2),
    handler: (ctx, args) => {
      if (args.length % 2) throw new CommandError("ERR wrong number of arguments for 'msetnx' command");
      for (let i = 0; i < args.length; i += 2) if (ctx.db.has(args[i])) return 0;
      for (let i = 0; i < args.length; i += 2) putString(ctx, args[i], args[i + 1]);
      return 1;
    },
  },
  { name: 'incr', arity: 2, flags: { write: true }, keys: keysAt(0), handler: (ctx, args) => incrBy(ctx, args[0], 1n) },
  { name: 'decr', arity: 2, flags: { write: true }, keys: keysAt(0), handler: (ctx, args) => incrBy(ctx, args[0], -1n) },
  { name: 'incrby', arity: 3, flags: { write: true }, keys: keysAt(0), handler: (ctx, args) => incrBy(ctx, args[0], parseInt64(args[1])) },
  {
    name: 'decrby',
    arity: 3,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      const n = parseInt64(args[1]);
      if (n === INT64_MIN) throw new CommandError('ERR decrement would overflow');
      return incrBy(ctx, args[0], -n);
    },
  },
  {
    name: 'incrbyfloat',
    arity: 3,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      const current = getString(ctx, args[0]);
      const base = current === undefined ? 0 : parseFloatArg(current);
      const result = base + parseFloatArg(args[1]);
      if (!Number.isFinite(result)) throw new CommandError(RespMessages.NAN_OR_INF);
      const text = formatFloat(result);
      putString(ctx, args[0], text, true);
      return text;
    },
  },
  {
    name: 'append',
    arity: 3,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      const current = getString(ctx, args[0]) ?? '';
      checkStringSize(ctx, current.length + args[1].length);
      const value = current + args[1];
      putString(ctx, args[0], value, true, true);
      return value.length;
    },
  },
  { name: 'strlen', arity: 2, handler: (ctx, args) => (getString(ctx, args[0]) ?? '').length },
  {
    name: 'getrange',
    arity: 4,
    handler: (ctx, args) => {
      const v = getString(ctx, args[0]) ?? '';
      let start = parseInteger(args[1]);
      let end = parseInteger(args[2]);
      if (start < 0 && end < 0 && start > end) return '';
      if (start < 0) start = Math.max(0, v.length + start);
      if (end < 0) end = Math.max(0, v.length + end);
      if (end >= v.length) end = v.length - 1;
      if (start > end || !v.length) return '';
      return v.slice(start, end + 1);
    },
  },
  {
    name: 'setrange',
    arity: 4,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      const offset = parseInteger(args[1]);
      if (offset < 0) throw new CommandError('ERR offset is out of range');
      let v = getString(ctx, args[0]) ?? '';
      if (!args[2].length) return v.length;
      checkStringSize(ctx, offset + args[2].length);
      if (v.length < offset) v = v.padEnd(offset, '\0');
      v = v.slice(0, offset) + args[2] + v.slice(offset + args[2].length);
      putString(ctx, args[0], v, true, true);
      return v.length;
    },
  },
];
