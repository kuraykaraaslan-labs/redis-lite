import { CommandError } from '../errors';
import { RespMessages } from '../messages';
import type { Reply } from '../resp';
import { NULL_ARRAY, RespDouble, RespPairs } from '../resp';
import type { LexBound, ScoreBound, ZEntry } from '../store/zset';
import { ZSet } from '../store/zset';
import { formatFloat, matchGlob, normalizeRange, parseFloatArg, parseInteger, toFloat } from '../util';
import { blockingCommand, parseTimeoutSeconds } from './blocking';
import { isCompact } from '../store/encoding';
import { parseCursor, scanPage } from '../store/scan';
import type { CommandContext, CommandSpec } from './types';
import { keysAt } from './types';

const W = { write: true } as const;

function zset(ctx: CommandContext, key: string): ZSet | undefined {
  return ctx.db.get(key, 'zset');
}

export function parseScoreBound(raw: string): ScoreBound {
  const exclusive = raw.startsWith('(');
  const n = toFloat(exclusive ? raw.slice(1) : raw);
  if (n === null) throw new CommandError(RespMessages.MIN_MAX_NOT_FLOAT);
  return { value: n, exclusive };
}

function parseLexBound(raw: string): LexBound {
  if (raw === '-') return { kind: 'min' };
  if (raw === '+') return { kind: 'max' };
  if (raw.startsWith('[')) return { kind: 'value', value: raw.slice(1), exclusive: false };
  if (raw.startsWith('(')) return { kind: 'value', value: raw.slice(1), exclusive: true };
  throw new CommandError(RespMessages.MIN_MAX_NOT_STRING);
}

function withScores(entries: ZEntry[], scores: boolean): Reply {
  return scores ? new RespPairs(entries.map((e) => [e.member, new RespDouble(e.score)])) : entries.map((e) => e.member);
}

function zadd(ctx: CommandContext, args: string[]): Reply {
  const key = args[0];
  let i = 1;
  const f = { nx: false, xx: false, gt: false, lt: false, ch: false, incr: false };
  for (; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    if (opt in f) f[opt as keyof typeof f] = true;
    else break;
  }
  const rest = args.slice(i);
  if (!rest.length || rest.length % 2) throw new CommandError(RespMessages.SYNTAX);
  if (f.nx && f.xx) throw new CommandError(RespMessages.XX_NX);
  if ((f.gt && f.nx) || (f.lt && f.nx) || (f.gt && f.lt)) throw new CommandError(RespMessages.GT_LT_NX);
  if (f.incr && rest.length !== 2) throw new CommandError(RespMessages.INCR_ONE_PAIR);
  const pairs: Array<[number, string]> = [];
  for (let j = 0; j < rest.length; j += 2) pairs.push([parseFloatArg(rest[j]), rest[j + 1]]);

  const existing = zset(ctx, key);
  if (!existing && f.xx) return f.incr ? null : 0;
  const z = existing ?? ctx.db.getOrCreate(key, 'zset', () => new ZSet());
  let added = 0;
  let changed = 0;
  let incrResult: number | null = null;
  for (const [score, member] of pairs) {
    const cur = z.scores.get(member);
    if (cur === undefined) {
      if (f.xx) continue;
      z.add(member, score);
      added++;
      incrResult = score;
      continue;
    }
    if (f.nx) continue;
    const next = f.incr ? cur + score : score;
    if (Number.isNaN(next)) throw new CommandError(RespMessages.SCORE_NAN);
    if ((f.gt && next <= cur) || (f.lt && next >= cur)) continue;
    incrResult = next;
    if (next !== cur) {
      z.add(member, next);
      changed++;
    }
  }
  ctx.db.removeIfEmpty(key);
  if (!added && !changed) ctx.noop = true;
  if (f.incr) return incrResult === null ? null : new RespDouble(incrResult);
  return f.ch ? added + changed : added;
}

interface RangeOptions {
  by: 'rank' | 'score' | 'lex';
  rev: boolean;
  limit: [number, number] | null;
  scores: boolean;
}

/** A range already parsed from its two arguments (bounds as min/max, i.e. already un-swapped for REV). */
type ParsedRange =
  | { by: 'rank'; start: number; stop: number }
  | { by: 'score'; min: ScoreBound; max: ScoreBound }
  | { by: 'lex'; min: LexBound; max: LexBound };

/** Parses `start stop` like Redis's zrangeGenericCommand step 2 (for REV score/lex ranges the args arrive as max, min). */
function parseRange(start: string, stop: string, o: RangeOptions): ParsedRange {
  const [a, b] = o.rev && o.by !== 'rank' ? [stop, start] : [start, stop];
  if (o.by === 'rank') return { by: 'rank', start: parseInteger(a), stop: parseInteger(b) };
  if (o.by === 'score') {
    const min = parseScoreBound(a);
    return { by: 'score', min, max: parseScoreBound(b) };
  }
  const min = parseLexBound(a);
  return { by: 'lex', min, max: parseLexBound(b) };
}

/** ZRANGE core shared by every range variant. */
function range(z: ZSet | undefined, r: ParsedRange, o: RangeOptions): ZEntry[] {
  if (!z) return [];
  let items: ZEntry[];
  if (r.by === 'rank') {
    const n = normalizeRange(r.start, r.stop, z.size);
    if (!n) return [];
    items = o.rev ? z.entries.slice(z.size - 1 - n[1], z.size - n[0]).reverse() : z.entries.slice(n[0], n[1] + 1);
  } else {
    const [lo, hi] = r.by === 'score' ? z.scoreWindow(r.min, r.max) : z.lexWindow(r.min, r.max);
    items = z.entries.slice(lo, hi);
    if (o.rev) items.reverse();
  }
  if (o.limit) {
    const [offset, count] = o.limit;
    if (offset < 0) return [];
    items = count < 0 ? items.slice(offset) : items.slice(offset, offset + count);
  }
  return items;
}

/**
 * Option parsing of zrangeGenericCommand: BYSCORE/BYLEX are accepted only when the command did not fix the range
 * type (ZRANGE, ZRANGESTORE) and only once; REV likewise; WITHSCORES never for the STORE form.
 */
function parseRangeOptions(args: string[], from: number, fixed: { by?: RangeOptions['by']; rev?: boolean }, store: boolean): RangeOptions {
  let by: RangeOptions['by'] | undefined = fixed.by;
  let rev: boolean | undefined = fixed.rev;
  let limit: [number, number] | null = null;
  let scores = false;
  for (let i = from; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    const left = args.length - i - 1;
    if (!store && opt === 'withscores') scores = true;
    else if (opt === 'limit' && left >= 2) {
      limit = [parseInteger(args[i + 1]), parseInteger(args[i + 2])];
      i += 2;
    } else if (rev === undefined && opt === 'rev') rev = true;
    else if (by === undefined && opt === 'bylex') by = 'lex';
    else if (by === undefined && opt === 'byscore') by = 'score';
    else throw new CommandError(RespMessages.SYNTAX);
  }
  const o: RangeOptions = { by: by ?? 'rank', rev: rev ?? false, limit, scores };
  if (o.limit && o.by === 'rank') throw new CommandError('ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX');
  if (o.scores && o.by === 'lex') throw new CommandError('ERR syntax error, WITHSCORES not supported in combination with BYLEX');
  return o;
}

function rangeCommand(fixed: { by?: RangeOptions['by']; rev?: boolean }) {
  return (ctx: CommandContext, args: string[]): Reply => {
    const o = parseRangeOptions(args, 3, fixed, false);
    const r = parseRange(args[1], args[2], o);
    return withScores(range(zset(ctx, args[0]), r, o), o.scores);
  };
}

function removeEntries(ctx: CommandContext, key: string, entries: ZEntry[]): number {
  const z = zset(ctx, key);
  if (!z) return 0;
  for (const e of [...entries]) z.remove(e.member);
  ctx.db.removeIfEmpty(key);
  return entries.length;
}

function popEntries(ctx: CommandContext, key: string, count: number, max: boolean): ZEntry[] {
  const z = zset(ctx, key);
  if (!z) return [];
  const picked = max ? z.entries.slice(-count).reverse() : z.entries.slice(0, count);
  for (const e of picked) z.remove(e.member);
  ctx.db.removeIfEmpty(key);
  return picked;
}

function zpop(ctx: CommandContext, args: string[], max: boolean): Reply {
  if (args.length > 2) throw new CommandError(RespMessages.SYNTAX);
  const count = args.length > 1 ? parseInteger(args[1], RespMessages.COUNT_POSITIVE) : 1;
  if (count < 0) throw new CommandError(RespMessages.COUNT_POSITIVE);
  const popped = popEntries(ctx, args[0], count, max);
  // Without COUNT, RESP3 gets a flat [member, score]; with COUNT, [member, score] pairs.
  if (args.length === 1) return popped.flatMap((e) => [e.member, new RespDouble(e.score)]);
  return withScores(popped, true);
}

function bzpop(ctx: CommandContext, args: string[], max: boolean) {
  const keys = args.slice(0, -1);
  const timeout = parseTimeoutSeconds(args[args.length - 1]);
  return blockingCommand(ctx, keys, timeout, () => {
    for (const key of keys) {
      const [e] = popEntries(ctx, key, 1, max);
      if (!e) continue;
      ctx.server.touch(ctx.client.dbIndex, key);
      return [key, e.member, new RespDouble(e.score)];
    }
    return undefined;
  });
}

/**
 * Shared parsing of `numkeys key... [WEIGHTS w...] [AGGREGATE SUM|MIN|MAX] [WITHSCORES] [LIMIT n]`, following
 * Redis's zunionInterDiffGenericCommand: keys are looked up (WRONGTYPE) before the options are parsed, and an
 * option is only recognised when enough arguments remain for it.
 */
function combine(
  ctx: CommandContext,
  args: string[],
  op: 'union' | 'inter' | 'diff',
  command: string,
  mode: { withScores: boolean; cardinality: boolean },
): { z: ZSet; withScores: boolean; limit: number } {
  const n = parseInteger(args[0]);
  if (n < 1) throw new CommandError(`ERR at least 1 input key is needed for '${command}' command`);
  if (n > args.length - 1) throw new CommandError(RespMessages.SYNTAX);
  const keys = args.slice(1, 1 + n);
  const sources = keys.map((k) => {
    const v = ctx.db.lookup(k);
    if (!v) return new Map<string, number>();
    if (v.type === 'zset') return v.value.scores;
    if (v.type === 'set') return new Map([...v.value].map((m) => [m, 1]));
    throw new CommandError(RespMessages.WRONGTYPE);
  });
  const weights = keys.map(() => 1);
  let aggregate: 'sum' | 'min' | 'max' = 'sum';
  let withScores = false;
  let limit = 0;
  const weighted = op !== 'diff' && !mode.cardinality;
  for (let i = 1 + n; i < args.length; ) {
    const opt = args[i].toLowerCase();
    const remaining = args.length - i;
    if (weighted && remaining >= n + 1 && opt === 'weights') {
      for (let j = 0; j < n; j++) weights[j] = parseFloatArg(args[i + 1 + j], 'ERR weight value is not a float');
      i += n + 1;
    } else if (weighted && remaining >= 2 && opt === 'aggregate') {
      const a = args[i + 1].toLowerCase();
      if (a !== 'sum' && a !== 'min' && a !== 'max') throw new CommandError(RespMessages.SYNTAX);
      aggregate = a;
      i += 2;
    } else if (mode.withScores && !mode.cardinality && opt === 'withscores') {
      withScores = true;
      i += 1;
    } else if (mode.cardinality && remaining >= 2 && opt === 'limit') {
      limit = parseInteger(args[i + 1], "ERR LIMIT can't be negative");
      if (limit < 0) throw new CommandError("ERR LIMIT can't be negative");
      i += 2;
    } else throw new CommandError(RespMessages.SYNTAX);
  }
  const acc = new Map<string, number>();
  if (op === 'diff') {
    for (const [m, s] of sources[0]) if (!sources.slice(1).some((src) => src.has(m))) acc.set(m, s);
  } else {
    sources.forEach((src, j) => {
      for (const [m, s] of src) {
        const w = s * weights[j];
        const cur = acc.get(m);
        if (cur === undefined) acc.set(m, w);
        else acc.set(m, aggregate === 'sum' ? cur + w : aggregate === 'min' ? Math.min(cur, w) : Math.max(cur, w));
      }
    });
    if (op === 'inter') for (const m of [...acc.keys()]) if (!sources.every((s) => s.has(m))) acc.delete(m);
  }
  const z = new ZSet();
  for (const [m, s] of acc) z.add(m, Number.isNaN(s) ? 0 : s);
  return { z, withScores, limit };
}

function combineStore(ctx: CommandContext, args: string[], op: 'union' | 'inter' | 'diff', command: string): Reply {
  const { z } = combine(ctx, args.slice(1), op, command, { withScores: false, cardinality: false });
  if (z.size) ctx.db.set(args[0], { type: 'zset', value: z });
  else ctx.db.remove(args[0]);
  return z.size;
}

function combineReply(ctx: CommandContext, args: string[], op: 'union' | 'inter' | 'diff', command: string): Reply {
  const { z, withScores: scores } = combine(ctx, args, op, command, { withScores: true, cardinality: false });
  return withScores(z.entries, scores);
}

/** `numkeys key... MIN|MAX [COUNT n]` → keys, side, count. */
function parseMpop(args: string[]): { keys: string[]; max: boolean; count: number } {
  const n = parseInteger(args[0]);
  if (n <= 0) throw new CommandError('ERR numkeys should be greater than 0');
  const keys = args.slice(1, 1 + n);
  const side = (args[1 + n] ?? '').toLowerCase();
  if (keys.length < n || (side !== 'min' && side !== 'max')) throw new CommandError(RespMessages.SYNTAX);
  let count = 1;
  if (args.length > 2 + n) {
    if (args[2 + n].toLowerCase() !== 'count' || args.length !== 4 + n) throw new CommandError(RespMessages.SYNTAX);
    count = parseInteger(args[3 + n]);
    if (count <= 0) throw new CommandError('ERR count should be greater than 0');
  }
  return { keys, max: side === 'max', count };
}

function mpopAttempt(ctx: CommandContext, keys: string[], max: boolean, count: number): Reply | undefined {
  for (const key of keys) {
    const popped = popEntries(ctx, key, count, max);
    if (!popped.length) continue;
    ctx.server.touch(ctx.client.dbIndex, key);
    return [key, popped.map((e) => [e.member, new RespDouble(e.score)])];
  }
  return undefined;
}

/** ZRANK/ZREVRANK `key member [WITHSCORE]`; a miss with WITHSCORE is a null array, without it a null bulk. */
function zrank(ctx: CommandContext, args: string[], reverse: boolean): Reply {
  if (args.length > 3) throw new CommandError(`ERR wrong number of arguments for '${reverse ? 'zrevrank' : 'zrank'}' command`);
  let withScore = false;
  if (args.length === 3) {
    if (args[2].toLowerCase() !== 'withscore') throw new CommandError(RespMessages.SYNTAX);
    withScore = true;
  }
  const z = zset(ctx, args[0]);
  const r = z?.rank(args[1]) ?? null;
  if (r === null || !z) return withScore ? NULL_ARRAY : null;
  const rank = reverse ? z.size - 1 - r : r;
  return withScore ? [rank, new RespDouble(z.scores.get(args[1]) ?? 0)] : rank;
}

/** ZSCAN options as scanGenericCommand accepts them for a sorted set: MATCH, COUNT and NOSCORES (Redis 8.0). */
function parseZscanOptions(args: string[], from: number): { match: string; count: number; noScores: boolean } {
  let match = '*';
  let count = 10;
  let noScores = false;
  for (let i = from; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    if (opt === 'count' && i + 1 < args.length) {
      count = parseInteger(args[++i]);
      if (count < 1) throw new CommandError(RespMessages.SYNTAX);
    } else if (opt === 'match' && i + 1 < args.length) match = args[++i];
    else if (opt === 'noscores') noScores = true;
    else throw new CommandError(RespMessages.SYNTAX);
  }
  return { match, count, noScores };
}

export const zsetCommands: CommandSpec[] = [
  { name: 'zadd', arity: -4, flags: W, keys: keysAt(0), handler: zadd },
  {
    name: 'zincrby',
    arity: 4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const delta = parseFloatArg(args[1]);
      const z = ctx.db.getOrCreate(args[0], 'zset', () => new ZSet());
      const next = (z.scores.get(args[2]) ?? 0) + delta;
      if (Number.isNaN(next)) throw new CommandError(RespMessages.SCORE_NAN);
      z.add(args[2], next);
      return new RespDouble(next);
    },
  },
  {
    name: 'zrem',
    arity: -3,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const z = zset(ctx, args[0]);
      if (!z) return 0;
      let n = 0;
      for (const m of args.slice(1)) if (z.remove(m)) n++;
      ctx.db.removeIfEmpty(args[0]);
      return n;
    },
  },
  { name: 'zcard', arity: 2, handler: (ctx, args) => zset(ctx, args[0])?.size ?? 0 },
  {
    name: 'zscore',
    arity: 3,
    handler: (ctx, args) => {
      const s = zset(ctx, args[0])?.scores.get(args[1]);
      return s === undefined ? null : new RespDouble(s);
    },
  },
  {
    name: 'zmscore',
    arity: -3,
    handler: (ctx, args) => {
      const z = zset(ctx, args[0]);
      return args.slice(1).map((m) => {
        const s = z?.scores.get(m);
        return s === undefined ? null : new RespDouble(s);
      });
    },
  },
  {
    name: 'zcount',
    arity: 4,
    handler: (ctx, args) => {
      const z = zset(ctx, args[0]);
      if (!z) return 0;
      const [lo, hi] = z.scoreWindow(parseScoreBound(args[1]), parseScoreBound(args[2]));
      return hi - lo;
    },
  },
  {
    name: 'zlexcount',
    arity: 4,
    handler: (ctx, args) => {
      const z = zset(ctx, args[0]);
      if (!z) return 0;
      const [lo, hi] = z.lexWindow(parseLexBound(args[1]), parseLexBound(args[2]));
      return hi - lo;
    },
  },
  { name: 'zrange', arity: -4, handler: rangeCommand({}) },
  { name: 'zrevrange', arity: -4, handler: rangeCommand({ by: 'rank', rev: true }) },
  { name: 'zrangebyscore', arity: -4, handler: rangeCommand({ by: 'score', rev: false }) },
  { name: 'zrevrangebyscore', arity: -4, handler: rangeCommand({ by: 'score', rev: true }) },
  { name: 'zrangebylex', arity: -4, handler: rangeCommand({ by: 'lex', rev: false }) },
  { name: 'zrevrangebylex', arity: -4, handler: rangeCommand({ by: 'lex', rev: true }) },
  {
    name: 'zrangestore',
    arity: -5,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const o = parseRangeOptions(args, 4, {}, true);
      const items = range(zset(ctx, args[1]), parseRange(args[2], args[3], o), o);
      const z = new ZSet();
      for (const e of items) z.add(e.member, e.score);
      if (z.size) ctx.db.set(args[0], { type: 'zset', value: z });
      else ctx.db.remove(args[0]);
      return z.size;
    },
  },
  { name: 'zrank', arity: -3, handler: (ctx, args) => zrank(ctx, args, false) },
  { name: 'zrevrank', arity: -3, handler: (ctx, args) => zrank(ctx, args, true) },
  {
    name: 'zremrangebyscore',
    arity: 4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const min = parseScoreBound(args[1]);
      const max = parseScoreBound(args[2]);
      const z = zset(ctx, args[0]);
      if (!z) return 0;
      const [lo, hi] = z.scoreWindow(min, max);
      return removeEntries(ctx, args[0], z.entries.slice(lo, hi));
    },
  },
  {
    name: 'zremrangebyrank',
    arity: 4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const start = parseInteger(args[1]);
      const stop = parseInteger(args[2]);
      const z = zset(ctx, args[0]);
      if (!z) return 0;
      const r = normalizeRange(start, stop, z.size);
      return r ? removeEntries(ctx, args[0], z.entries.slice(r[0], r[1] + 1)) : 0;
    },
  },
  {
    name: 'zremrangebylex',
    arity: 4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const min = parseLexBound(args[1]);
      const max = parseLexBound(args[2]);
      const z = zset(ctx, args[0]);
      if (!z) return 0;
      const [lo, hi] = z.lexWindow(min, max);
      return removeEntries(ctx, args[0], z.entries.slice(lo, hi));
    },
  },
  { name: 'zpopmin', arity: -2, flags: W, keys: keysAt(0), handler: (ctx, args) => zpop(ctx, args, false) },
  { name: 'zpopmax', arity: -2, flags: W, keys: keysAt(0), handler: (ctx, args) => zpop(ctx, args, true) },
  { name: 'bzpopmin', arity: -3, flags: W, keys: keysAt(0, -2), handler: (ctx, args) => bzpop(ctx, args, false) },
  { name: 'bzpopmax', arity: -3, flags: W, keys: keysAt(0, -2), handler: (ctx, args) => bzpop(ctx, args, true) },
  { name: 'zunionstore', arity: -4, flags: W, keys: keysAt(0), handler: (ctx, args) => combineStore(ctx, args, 'union', 'zunionstore') },
  { name: 'zinterstore', arity: -4, flags: W, keys: keysAt(0), handler: (ctx, args) => combineStore(ctx, args, 'inter', 'zinterstore') },
  { name: 'zdiffstore', arity: -4, flags: W, keys: keysAt(0), handler: (ctx, args) => combineStore(ctx, args, 'diff', 'zdiffstore') },
  { name: 'zunion', arity: -3, handler: (ctx, args) => combineReply(ctx, args, 'union', 'zunion') },
  { name: 'zinter', arity: -3, handler: (ctx, args) => combineReply(ctx, args, 'inter', 'zinter') },
  { name: 'zdiff', arity: -3, handler: (ctx, args) => combineReply(ctx, args, 'diff', 'zdiff') },
  {
    name: 'zintercard',
    arity: -3,
    handler: (ctx, args) => {
      const { z, limit } = combine(ctx, args, 'inter', 'zintercard', { withScores: false, cardinality: true });
      return limit > 0 ? Math.min(limit, z.size) : z.size;
    },
  },
  {
    name: 'zmpop',
    arity: -4,
    flags: W,
    keys: (args) => args.slice(1, 1 + (Number(args[0]) || 0)),
    handler: (ctx, args) => {
      const { keys, max, count } = parseMpop(args);
      return mpopAttempt(ctx, keys, max, count) ?? NULL_ARRAY;
    },
  },
  {
    name: 'bzmpop',
    arity: -5,
    flags: W,
    keys: (args) => args.slice(2, 2 + (Number(args[1]) || 0)),
    handler: (ctx, args) => {
      const timeout = parseTimeoutSeconds(args[0]);
      const { keys, max, count } = parseMpop(args.slice(1));
      return blockingCommand(ctx, keys, timeout, () => mpopAttempt(ctx, keys, max, count));
    },
  },
  {
    name: 'zscan',
    arity: -3,
    handler: (ctx, args) => {
      // Redis order: cursor, then key lookup (missing → empty scan, WRONGTYPE), then the options.
      const cursor = parseCursor(args[1]);
      if (cursor === null) throw new CommandError('ERR invalid cursor');
      const z = zset(ctx, args[0]);
      if (!z) return ['0', []];
      const { match, count, noScores } = parseZscanOptions(args, 2);
      const value = ctx.db.peek(args[0]);
      const compact = value !== undefined && isCompact(value, ctx.server.config);
      const { next, page } = compact ? { next: 0, page: z.entries.map((e) => e.member) } : scanPage(z.scores.keys(), cursor, count);
      const out: string[] = [];
      for (const m of page) {
        if (!matchGlob(match, m)) continue;
        out.push(m);
        if (!noScores) out.push(formatFloat(z.scores.get(m) ?? 0));
      }
      return [String(next), out];
    },
  },
  {
    name: 'zrandmember',
    arity: -2,
    handler: (ctx, args) => {
      const entries = zset(ctx, args[0])?.entries ?? [];
      if (args.length === 1) return entries.length ? entries[Math.floor(Math.random() * entries.length)].member : null;
      const count = parseInteger(args[1]);
      if (args.length > 3 || (args.length === 3 && args[2].toLowerCase() !== 'withscores')) throw new CommandError(RespMessages.SYNTAX);
      const scores = args.length === 3;
      const picked = count >= 0 ? [...entries].sort(() => Math.random() - 0.5).slice(0, count) : entries.length ? Array.from({ length: -count }, () => entries[Math.floor(Math.random() * entries.length)]) : [];
      return withScores(picked, scores);
    },
  },
];
