import { CommandError } from '../errors';
import { RespMessages, wrongArity } from '../messages';
import type { Reply } from '../resp';
import { NULL_ARRAY, OK } from '../resp';
import { normalizeRange, parseInteger } from '../util';
import { blockingCommand, parseTimeoutSeconds } from './blocking';
import type { CommandContext, CommandSpec } from './types';
import { keysAt } from './types';

const W = { write: true } as const;

function list(ctx: CommandContext, key: string): string[] | undefined {
  return ctx.db.get(key, 'list');
}

function push(ctx: CommandContext, args: string[], left: boolean, onlyIfExists: boolean): number {
  const [key, ...values] = args;
  if (onlyIfExists && !list(ctx, key)) return 0;
  const l = ctx.db.getOrCreate(key, 'list', () => []);
  for (const v of values) {
    if (left) l.unshift(v);
    else l.push(v);
  }
  return l.length;
}

/** LPOP/RPOP with optional count. */
function pop(ctx: CommandContext, args: string[], left: boolean): Reply {
  const [key] = args;
  if (args.length > 2) throw new CommandError(wrongArity(left ? 'lpop' : 'rpop'));
  const hasCount = args.length > 1;
  const count = hasCount ? parseInteger(args[1], RespMessages.COUNT_POSITIVE) : 1;
  if (count < 0) throw new CommandError(RespMessages.COUNT_POSITIVE);
  const l = list(ctx, key);
  if (!l) return hasCount ? NULL_ARRAY : null;
  const out = left ? l.splice(0, count) : l.splice(Math.max(0, l.length - count), count).reverse();
  ctx.db.removeIfEmpty(key);
  return hasCount ? out : (out[0] ?? null);
}

function parseSide(raw: string): 'left' | 'right' {
  const s = raw.toLowerCase();
  if (s === 'left' || s === 'right') return s;
  throw new CommandError(RespMessages.SYNTAX);
}

/** LMOVE core; returns the moved element or undefined when the source is empty. Touches both keys. */
function move(ctx: CommandContext, src: string, dst: string, from: 'left' | 'right', to: 'left' | 'right'): string | undefined {
  const s = list(ctx, src);
  if (!s || !s.length) return undefined;
  const d = list(ctx, dst); // WRONGTYPE check before popping
  if (!d && ctx.db.lookup(dst)) throw new CommandError(RespMessages.WRONGTYPE);
  const value = (from === 'left' ? s.shift() : s.pop()) as string;
  ctx.db.removeIfEmpty(src);
  const target = ctx.db.getOrCreate(dst, 'list', () => []);
  if (to === 'left') target.unshift(value);
  else target.push(value);
  ctx.server.touch(ctx.client.dbIndex, src);
  ctx.server.touch(ctx.client.dbIndex, dst);
  return value;
}

/** BLPOP/BRPOP: first non-empty key wins. */
function bpop(ctx: CommandContext, args: string[], left: boolean) {
  const keys = args.slice(0, -1);
  const timeout = parseTimeoutSeconds(args[args.length - 1]);
  return blockingCommand(ctx, keys, timeout, () => {
    for (const key of keys) {
      const l = list(ctx, key);
      if (!l || !l.length) continue;
      const value = (left ? l.shift() : l.pop()) as string;
      ctx.db.removeIfEmpty(key);
      ctx.server.touch(ctx.client.dbIndex, key);
      return [key, value];
    }
    return undefined;
  });
}

/** `numkeys key... LEFT|RIGHT [COUNT n]`. */
function parseLmpop(args: string[]): { keys: string[]; left: boolean; count: number } {
  const n = parseInteger(args[0]);
  if (n <= 0) throw new CommandError('ERR numkeys should be greater than 0');
  const keys = args.slice(1, 1 + n);
  const side = (args[1 + n] ?? '').toLowerCase();
  if (keys.length < n || (side !== 'left' && side !== 'right')) throw new CommandError(RespMessages.SYNTAX);
  let count = 1;
  if (args.length > 2 + n) {
    if (args[2 + n].toLowerCase() !== 'count' || args.length !== 4 + n) throw new CommandError(RespMessages.SYNTAX);
    count = parseInteger(args[3 + n]);
    if (count <= 0) throw new CommandError('ERR count should be greater than 0');
  }
  return { keys, left: side === 'left', count };
}

function lmpopAttempt(ctx: CommandContext, keys: string[], left: boolean, count: number): Reply | undefined {
  for (const key of keys) {
    const l = list(ctx, key);
    if (!l || !l.length) continue;
    const out = left ? l.splice(0, count) : l.splice(Math.max(0, l.length - count), count).reverse();
    ctx.db.removeIfEmpty(key);
    ctx.server.touch(ctx.client.dbIndex, key);
    return [key, out];
  }
  return undefined;
}

export const listCommands: CommandSpec[] = [
  {
    name: 'lmpop',
    arity: -4,
    flags: W,
    keys: (args) => args.slice(1, 1 + (Number(args[0]) || 0)),
    handler: (ctx, args) => {
      const { keys, left, count } = parseLmpop(args);
      return lmpopAttempt(ctx, keys, left, count) ?? NULL_ARRAY;
    },
  },
  {
    name: 'blmpop',
    arity: -5,
    flags: W,
    keys: (args) => args.slice(2, 2 + (Number(args[1]) || 0)),
    handler: (ctx, args) => {
      const timeout = parseTimeoutSeconds(args[0]);
      const { keys, left, count } = parseLmpop(args.slice(1));
      return blockingCommand(ctx, keys, timeout, () => lmpopAttempt(ctx, keys, left, count));
    },
  },
  { name: 'lpush', arity: -3, flags: W, keys: keysAt(0), handler: (ctx, args) => push(ctx, args, true, false) },
  { name: 'rpush', arity: -3, flags: W, keys: keysAt(0), handler: (ctx, args) => push(ctx, args, false, false) },
  { name: 'lpushx', arity: -3, flags: W, keys: keysAt(0), handler: (ctx, args) => push(ctx, args, true, true) },
  { name: 'rpushx', arity: -3, flags: W, keys: keysAt(0), handler: (ctx, args) => push(ctx, args, false, true) },
  { name: 'lpop', arity: -2, flags: W, keys: keysAt(0), handler: (ctx, args) => pop(ctx, args, true) },
  { name: 'rpop', arity: -2, flags: W, keys: keysAt(0), handler: (ctx, args) => pop(ctx, args, false) },
  { name: 'llen', arity: 2, handler: (ctx, args) => list(ctx, args[0])?.length ?? 0 },
  {
    name: 'lrange',
    arity: 4,
    handler: (ctx, args) => {
      const l = list(ctx, args[0]) ?? [];
      const r = normalizeRange(parseInteger(args[1]), parseInteger(args[2]), l.length);
      return r ? l.slice(r[0], r[1] + 1) : [];
    },
  },
  {
    name: 'lindex',
    arity: 3,
    handler: (ctx, args) => {
      const l = list(ctx, args[0]) ?? [];
      const i = parseInteger(args[1]);
      return l[i < 0 ? l.length + i : i] ?? null;
    },
  },
  {
    name: 'lset',
    arity: 4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const l = list(ctx, args[0]);
      if (!l) throw new CommandError(RespMessages.NO_SUCH_KEY);
      const raw = parseInteger(args[1]);
      const i = raw < 0 ? l.length + raw : raw;
      if (i < 0 || i >= l.length) throw new CommandError(RespMessages.INDEX_OUT_OF_RANGE);
      l[i] = args[2];
      return OK;
    },
  },
  {
    name: 'lrem',
    arity: 4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const l = list(ctx, args[0]);
      if (!l) return 0;
      const count = parseInteger(args[1]);
      const value = args[2];
      let removed = 0;
      const limit = count === 0 ? Infinity : Math.abs(count);
      if (count >= 0) {
        for (let i = 0; i < l.length && removed < limit; ) {
          if (l[i] === value) {
            l.splice(i, 1);
            removed++;
          } else i++;
        }
      } else {
        for (let i = l.length - 1; i >= 0 && removed < limit; i--) {
          if (l[i] === value) {
            l.splice(i, 1);
            removed++;
          }
        }
      }
      ctx.db.removeIfEmpty(args[0]);
      return removed;
    },
  },
  {
    name: 'ltrim',
    arity: 4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const l = list(ctx, args[0]);
      if (!l) return OK;
      const r = normalizeRange(parseInteger(args[1]), parseInteger(args[2]), l.length);
      const kept = r ? l.slice(r[0], r[1] + 1) : [];
      l.splice(0, l.length, ...kept);
      ctx.db.removeIfEmpty(args[0]);
      return OK;
    },
  },
  {
    name: 'linsert',
    arity: 5,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const where = args[1].toLowerCase();
      if (where !== 'before' && where !== 'after') throw new CommandError(RespMessages.SYNTAX);
      const l = list(ctx, args[0]);
      if (!l) return 0;
      const i = l.indexOf(args[2]);
      if (i < 0) return -1;
      l.splice(where === 'before' ? i : i + 1, 0, args[3]);
      return l.length;
    },
  },
  {
    name: 'lpos',
    arity: -3,
    handler: (ctx, args) => {
      const l = list(ctx, args[0]) ?? [];
      let rank = 1;
      let count: number | null = null;
      let maxlen = 0;
      for (let i = 2; i < args.length; i += 2) {
        const opt = args[i].toLowerCase();
        if (i + 1 >= args.length || !['rank', 'count', 'maxlen'].includes(opt)) throw new CommandError(RespMessages.SYNTAX);
        const n = parseInteger(args[i + 1]);
        if (opt === 'rank') {
          if (n === 0) throw new CommandError("ERR RANK can't be zero: use 1 to start from the first match, 2 from the second ... or use negative to start from the end of the list");
          rank = n;
        } else if (opt === 'count') {
          if (n < 0) throw new CommandError("ERR COUNT can't be negative");
          count = n;
        } else if (opt === 'maxlen') {
          if (n < 0) throw new CommandError("ERR MAXLEN can't be negative");
          maxlen = n;
        }
        else throw new CommandError(RespMessages.SYNTAX);
      }
      const matches: number[] = [];
      const want = count === null ? 1 : count === 0 ? Infinity : count;
      let skip = Math.abs(rank) - 1;
      const forward = rank > 0;
      for (let step = 0; step < l.length && (maxlen === 0 || step < maxlen) && matches.length < want; step++) {
        const i = forward ? step : l.length - 1 - step;
        if (l[i] !== args[1]) continue;
        if (skip > 0) {
          skip--;
          continue;
        }
        matches.push(i);
      }
      return count === null ? (matches[0] ?? null) : matches;
    },
  },
  {
    name: 'lmove',
    arity: 5,
    flags: W,
    keys: keysAt(0, 1),
    handler: (ctx, args) => move(ctx, args[0], args[1], parseSide(args[2]), parseSide(args[3])) ?? null,
  },
  {
    name: 'rpoplpush',
    arity: 3,
    flags: W,
    keys: keysAt(0, 1),
    handler: (ctx, args) => move(ctx, args[0], args[1], 'right', 'left') ?? null,
  },
  { name: 'blpop', arity: -3, flags: W, keys: keysAt(0, -2), handler: (ctx, args) => bpop(ctx, args, true) },
  { name: 'brpop', arity: -3, flags: W, keys: keysAt(0, -2), handler: (ctx, args) => bpop(ctx, args, false) },
  {
    name: 'blmove',
    arity: 6,
    flags: W,
    keys: keysAt(0, 1),
    handler: (ctx, args) => {
      const from = parseSide(args[2]);
      const to = parseSide(args[3]);
      const timeout = parseTimeoutSeconds(args[4]);
      // Timing out answers a null array, but inside MULTI / scripts the non-blocking form's null bulk (Redis quirk).
      return blockingCommand(ctx, [args[0]], timeout, () => move(ctx, args[0], args[1], from, to), NULL_ARRAY, null);
    },
  },
  {
    name: 'brpoplpush',
    arity: 4,
    flags: W,
    keys: keysAt(0, 1),
    handler: (ctx, args) => {
      const timeout = parseTimeoutSeconds(args[2]);
      return blockingCommand(ctx, [args[0]], timeout, () => move(ctx, args[0], args[1], 'right', 'left'), NULL_ARRAY, null);
    },
  },
];
