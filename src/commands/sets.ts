import { CommandError } from '../errors';
import { RespMessages } from '../messages';
import type { Reply } from '../resp';
import { RespSet } from '../resp';
import { matchGlob, parseInteger } from '../util';
import { isCompact, objectEncoding } from '../store/encoding';
import { parseCursor, scanPage } from '../store/scan';
import { parseScanOptions } from './keys';
import type { CommandContext, CommandSpec } from './types';
import { keysAt } from './types';

const W = { write: true } as const;

function set(ctx: CommandContext, key: string): Set<string> | undefined {
  return ctx.db.get(key, 'set');
}

/** Members in Redis's iteration order: an intset is kept sorted by value, other encodings in insertion order. */
function members(ctx: CommandContext, key: string, s: Set<string>): string[] {
  const value = ctx.db.peek(key);
  const all = [...s];
  if (value && objectEncoding(value, ctx.server.config) === 'intset') {
    all.sort((a, b) => {
      const x = BigInt(a);
      const y = BigInt(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  return all;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function combine(ctx: CommandContext, keys: string[], op: 'union' | 'inter' | 'diff'): Set<string> {
  const sets = keys.map((k) => set(ctx, k) ?? new Set<string>());
  if (op === 'union') return new Set(sets.flatMap((s) => [...s]));
  const [first, ...rest] = sets;
  const out = new Set<string>();
  for (const m of first) {
    if (op === 'inter' ? rest.every((s) => s.has(m)) : !rest.some((s) => s.has(m))) out.add(m);
  }
  return out;
}

function store(ctx: CommandContext, dst: string, members: Set<string>): number {
  if (members.size) ctx.db.set(dst, { type: 'set', value: members });
  else ctx.db.remove(dst);
  return members.size;
}

function sintercard(ctx: CommandContext, args: string[]): Reply {
  const n = parseInteger(args[0], 'ERR numkeys should be greater than 0');
  if (n <= 0) throw new CommandError('ERR numkeys should be greater than 0');
  const keys = args.slice(1, 1 + n);
  if (keys.length < n) throw new CommandError("ERR Number of keys can't be greater than number of args");
  let limit = 0;
  const rest = args.slice(1 + n);
  if (rest.length) {
    if (rest.length !== 2 || rest[0].toLowerCase() !== 'limit') throw new CommandError(RespMessages.SYNTAX);
    limit = parseInteger(rest[1], "ERR LIMIT can't be negative");
    if (limit < 0) throw new CommandError("ERR LIMIT can't be negative");
  }
  const size = combine(ctx, keys, 'inter').size;
  return limit > 0 ? Math.min(limit, size) : size;
}

export const setCommands: CommandSpec[] = [
  {
    name: 'sadd',
    arity: -3,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const s = ctx.db.getOrCreate(args[0], 'set', () => new Set());
      let added = 0;
      for (const m of args.slice(1)) {
        if (!s.has(m)) {
          s.add(m);
          added++;
        }
      }
      return added;
    },
  },
  {
    name: 'srem',
    arity: -3,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const s = set(ctx, args[0]);
      if (!s) return 0;
      let n = 0;
      for (const m of args.slice(1)) if (s.delete(m)) n++;
      ctx.db.removeIfEmpty(args[0]);
      return n;
    },
  },
  {
    name: 'smembers',
    arity: 2,
    handler: (ctx, args) => {
      const s = set(ctx, args[0]);
      return new RespSet(s ? members(ctx, args[0], s) : []);
    },
  },
  { name: 'sismember', arity: 3, handler: (ctx, args) => (set(ctx, args[0])?.has(args[1]) ? 1 : 0) },
  {
    name: 'smismember',
    arity: -3,
    handler: (ctx, args) => {
      const s = set(ctx, args[0]);
      return args.slice(1).map((m) => (s?.has(m) ? 1 : 0));
    },
  },
  { name: 'scard', arity: 2, handler: (ctx, args) => set(ctx, args[0])?.size ?? 0 },
  {
    name: 'spop',
    arity: -2,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const s = set(ctx, args[0]);
      if (args.length > 2) throw new CommandError(RespMessages.SYNTAX);
      const hasCount = args.length > 1;
      const count = hasCount ? parseInteger(args[1], RespMessages.COUNT_POSITIVE) : 1;
      if (count < 0) throw new CommandError(RespMessages.COUNT_POSITIVE);
      if (!s) return hasCount ? new RespSet([]) : null;
      const picked = shuffle([...s]).slice(0, count);
      for (const m of picked) s.delete(m);
      ctx.db.removeIfEmpty(args[0]);
      return hasCount ? new RespSet(picked) : (picked[0] ?? null);
    },
  },
  {
    name: 'srandmember',
    arity: -2,
    handler: (ctx, args) => {
      const members = [...(set(ctx, args[0]) ?? [])];
      if (args.length > 2) throw new CommandError(RespMessages.SYNTAX);
      if (args.length === 1) return members.length ? members[Math.floor(Math.random() * members.length)] : null;
      const count = parseInteger(args[1]);
      if (count >= 0) return shuffle(members).slice(0, count);
      return members.length ? Array.from({ length: -count }, () => members[Math.floor(Math.random() * members.length)]) : [];
    },
  },
  {
    name: 'smove',
    arity: 4,
    flags: W,
    keys: keysAt(0, 1),
    handler: (ctx, args) => {
      const [src, dst, member] = args;
      const s = set(ctx, src);
      set(ctx, dst); // WRONGTYPE check
      if (!s || !s.has(member)) return 0;
      s.delete(member);
      ctx.db.removeIfEmpty(src);
      ctx.db.getOrCreate(dst, 'set', () => new Set()).add(member);
      return 1;
    },
  },
  { name: 'sunion', arity: -2, handler: (ctx, args) => new RespSet([...combine(ctx, args, 'union')]) },
  { name: 'sinter', arity: -2, handler: (ctx, args) => new RespSet([...combine(ctx, args, 'inter')]) },
  { name: 'sdiff', arity: -2, handler: (ctx, args) => new RespSet([...combine(ctx, args, 'diff')]) },
  { name: 'sintercard', arity: -3, handler: sintercard },
  { name: 'sunionstore', arity: -3, flags: W, keys: keysAt(0), handler: (ctx, args) => store(ctx, args[0], combine(ctx, args.slice(1), 'union')) },
  { name: 'sinterstore', arity: -3, flags: W, keys: keysAt(0), handler: (ctx, args) => store(ctx, args[0], combine(ctx, args.slice(1), 'inter')) },
  { name: 'sdiffstore', arity: -3, flags: W, keys: keysAt(0), handler: (ctx, args) => store(ctx, args[0], combine(ctx, args.slice(1), 'diff')) },
  {
    name: 'sscan',
    arity: -3,
    handler: (ctx, args) => {
      const cursor = parseCursor(args[1]);
      if (cursor === null) throw new CommandError('ERR invalid cursor');
      const { match, count } = parseScanOptions(args, 2);
      const s = set(ctx, args[0]);
      if (!s) return ['0', []];
      const value = ctx.db.peek(args[0]);
      const compact = value !== undefined && isCompact(value, ctx.server.config);
      const { next, page } = compact ? { next: 0, page: members(ctx, args[0], s) } : scanPage(s, cursor, count);
      return [String(next), page.filter((m) => matchGlob(match, m))];
    },
  },
];
