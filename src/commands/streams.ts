import { CommandError } from '../errors';
import { RespMessages, unknownSubcommand } from '../messages';
import type { Reply } from '../resp';
import { NULL_ARRAY, OK, RespError, RespMap } from '../resp';
import type { Consumer, ConsumerGroup, PendingEntry, StreamEntry, StreamId } from '../store/stream';
import { MAX_ID, Stream, U64_MAX, ZERO_ID, compareIds, idToString, nextId, parseStreamId, parseU64, prevId } from '../store/stream';
import { parseInteger } from '../util';
import { blockingCommand } from './blocking';
import type { CommandContext, CommandSpec, HandlerResult } from './types';
import { keysAt } from './types';

const W = { write: true } as const;

function stream(ctx: CommandContext, key: string): Stream | undefined {
  return ctx.db.get(key, 'stream');
}

function entryReply(e: StreamEntry): Reply {
  return [idToString(e.id), e.fields];
}

function arityError(name: string): CommandError {
  return new CommandError(`ERR wrong number of arguments for '${name}' command`);
}

/** Redis addReplySubcommandSyntaxError. */
function subcommandSyntaxError(sub: string, cmd: string): CommandError {
  return new CommandError(`ERR unknown subcommand or wrong number of arguments for '${sub}'. Try ${cmd.toUpperCase()} HELP.`);
}

/** Checks a container subcommand's arity (Redis counts the command name: argc = args.length + 1). */
function checkSubArity(cmd: string, sub: string, args: string[], arities: Record<string, number>): void {
  const arity = arities[sub];
  const argc = args.length + 1;
  if (arity > 0 ? argc !== arity : argc < -arity) throw arityError(`${cmd}|${sub}`);
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Strict id (`ms` or `ms-seq`; `-` and `+` rejected). */
function requireId(raw: string, defaultSeq = 0n): StreamId {
  const id = parseStreamId(raw, defaultSeq);
  if (!id) throw new CommandError(RespMessages.STREAM_ID_INVALID);
  return id;
}

/** Interval bound as in streamParseIntervalIDOrReply: `-`, `+`, `(id` (exclusive) or an id. */
function parseInterval(raw: string, defaultSeq: bigint): { id: StreamId; exclusive: boolean } {
  if (raw.length > 1 && raw.startsWith('(')) return { id: requireId(raw.slice(1), defaultSeq), exclusive: true };
  if (raw === '-') return { id: ZERO_ID, exclusive: false };
  if (raw === '+') return { id: MAX_ID, exclusive: false };
  return { id: requireId(raw, defaultSeq), exclusive: false };
}

function rangeStart(raw: string): StreamId {
  const { id, exclusive } = parseInterval(raw, 0n);
  if (!exclusive) return id;
  const next = nextId(id);
  if (!next) throw new CommandError('ERR invalid start ID for the interval');
  return next;
}

function rangeEnd(raw: string): StreamId {
  const { id, exclusive } = parseInterval(raw, U64_MAX);
  if (!exclusive) return id;
  const prev = prevId(id);
  if (!prev) throw new CommandError('ERR invalid end ID for the interval');
  return prev;
}

function nogroup(key: string, group: string): CommandError {
  return new CommandError(`NOGROUP No such key '${key}' or consumer group '${group}'`);
}

function nogroupForKey(key: string, group: string): CommandError {
  return new CommandError(`NOGROUP No such consumer group '${group}' for key name '${key}'`);
}

function getGroup(ctx: CommandContext, key: string, name: string): { s: Stream; g: ConsumerGroup } {
  const s = stream(ctx, key);
  const g = s?.groups.get(name);
  if (!s || !g) throw nogroup(key, name);
  return { s, g };
}

function getConsumer(g: ConsumerGroup, name: string): Consumer {
  let c = g.consumers.get(name);
  if (!c) {
    c = { name, seenTime: Date.now(), activeTime: -1, pending: new Map() };
    g.consumers.set(name, c);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Consumer group read counters and lag (t_stream.c)
// ---------------------------------------------------------------------------

function firstId(s: Stream): StreamId {
  return s.entries[0]?.id ?? ZERO_ID;
}

/** streamRangeHasTombstones: whether a deleted entry may lie in [start, end]. */
function rangeHasTombstones(s: Stream, start: StreamId, end: StreamId = MAX_ID): boolean {
  if (!s.length || compareIds(s.maxDeletedId, ZERO_ID) === 0) return false;
  if (compareIds(firstId(s), s.maxDeletedId) > 0) return false;
  return compareIds(start, s.maxDeletedId) <= 0 && compareIds(s.maxDeletedId, end) <= 0;
}

/** streamEstimateDistanceFromFirstEverEntry: the logical read counter of `id`, or null when unknown. */
function estimateEntriesRead(s: Stream, id: StreamId): number | null {
  if (!s.entriesAdded) return 0;
  if (!s.length && compareIds(id, s.lastId) < 1) return s.entriesAdded;
  const cmpLast = compareIds(id, s.lastId);
  if (cmpLast === 0) return s.entriesAdded;
  if (cmpLast > 0) return null;
  const cmpFirst = compareIds(id, firstId(s));
  if (compareIds(s.maxDeletedId, ZERO_ID) === 0 || compareIds(s.maxDeletedId, firstId(s)) < 0) {
    if (cmpFirst < 0) return s.entriesAdded - s.length;
    if (cmpFirst === 0) return s.entriesAdded - s.length + 1;
  }
  return null;
}

/** streamReplyWithCGLag: the group's lag, or null when it cannot be computed. */
function lagOf(s: Stream, g: ConsumerGroup): number | null {
  if (!s.entriesAdded) return 0;
  if (g.entriesRead !== null && !rangeHasTombstones(s, g.lastId)) return s.entriesAdded - g.entriesRead;
  const read = estimateEntriesRead(s, g.lastId);
  return read === null ? null : s.entriesAdded - read;
}

/** Advances the group's last-delivered id to `id`, keeping entries-read as Redis does. */
function advanceGroup(s: Stream, g: ConsumerGroup, id: StreamId): void {
  if (compareIds(id, g.lastId) <= 0) return;
  if (g.entriesRead !== null && !rangeHasTombstones(s, g.lastId)) g.entriesRead++;
  else if (s.entriesAdded) g.entriesRead = estimateEntriesRead(s, id);
  g.lastId = id;
}

// ---------------------------------------------------------------------------
// XADD / XTRIM argument parsing (streamParseAddOrTrimArgsOrReply)
// ---------------------------------------------------------------------------

interface AddTrimArgs {
  strategy: 'maxlen' | 'minid' | null;
  maxlen: number;
  minid: StreamId;
  approx: boolean;
  /** 0 = no limit. */
  limit: number;
  noMkStream: boolean;
  /** XADD: explicit id (null = `*`). */
  id: StreamId | null;
  /** XADD: false for `<ms>-*`. */
  seqGiven: boolean;
  /** Index of the first field (XADD) or args.length (XTRIM). */
  next: number;
}

function parseAddTrim(ctx: CommandContext, args: string[], xadd: boolean): AddTrimArgs {
  const a: AddTrimArgs = { strategy: null, maxlen: 0, minid: ZERO_ID, approx: false, limit: 0, noMkStream: false, id: null, seqGiven: true, next: args.length };
  let limitGiven = false;
  let i = 1;
  for (; i < args.length; i++) {
    const more = args.length - 1 - i;
    const opt = args[i].toLowerCase();
    if (xadd && args[i] === '*') {
      break;
    } else if ((opt === 'maxlen' || opt === 'minid') && more) {
      if (a.strategy) throw new CommandError('ERR syntax error, MAXLEN and MINID options at the same time are not compatible');
      a.approx = false;
      const next = args[i + 1];
      if (more >= 2 && next === '~') {
        a.approx = true;
        i++;
      } else if (more >= 2 && next === '=') {
        i++;
      }
      if (opt === 'maxlen') {
        a.maxlen = parseInteger(args[i + 1]);
        if (a.maxlen < 0) throw new CommandError('ERR The MAXLEN argument must be >= 0.');
      } else {
        a.minid = requireId(args[i + 1]);
      }
      i++;
      a.strategy = opt;
    } else if (opt === 'limit' && more) {
      a.limit = parseInteger(args[i + 1]);
      if (a.limit < 0) throw new CommandError('ERR The LIMIT argument must be >= 0.');
      limitGiven = true;
      i++;
    } else if (xadd && opt === 'nomkstream') {
      a.noMkStream = true;
    } else if (xadd) {
      const m = /^(.*)-\*$/s.exec(args[i]);
      if (m) {
        const ms = parseU64(m[1]);
        if (ms === null) throw new CommandError(RespMessages.STREAM_ID_INVALID);
        a.id = { ms, seq: 0n };
        a.seqGiven = false;
      } else {
        a.id = requireId(args[i]);
      }
      break;
    } else {
      throw new CommandError(RespMessages.SYNTAX);
    }
  }
  a.next = i + 1;
  if (a.limit && !a.strategy) throw new CommandError('ERR syntax error, LIMIT cannot be used without specifying a trimming strategy');
  if (!xadd && !a.strategy) throw new CommandError('ERR syntax error, XTRIM must be called with a trimming strategy');
  if (limitGiven) {
    if (!a.approx) throw new CommandError('ERR syntax error, LIMIT cannot be used without the special ~ option');
  } else if (a.approx) {
    a.limit = 100 * ctx.server.config.num('stream-node-max-entries');
    if (a.limit <= 0 || a.limit > 1_000_000_000) a.limit = 10000;
  } else {
    a.limit = 0;
  }
  return a;
}

function applyTrim(s: Stream, a: AddTrimArgs): number {
  if (!a.strategy) return 0;
  return s.trimNodes(a.strategy, a.maxlen, a.minid, a.approx, a.limit);
}

function xadd(ctx: CommandContext, args: string[]): Reply {
  const key = args[0];
  const a = parseAddTrim(ctx, args, true);
  const nfields = args.length - a.next;
  if (nfields < 2 || nfields % 2) throw arityError('xadd');
  if (a.id && a.seqGiven && compareIds(a.id, ZERO_ID) === 0) throw new CommandError(RespMessages.STREAM_ID_ZERO);

  const existing = stream(ctx, key);
  if (!existing && a.noMkStream) return null;
  const s = existing ?? new Stream();
  if (compareIds(s.lastId, MAX_ID) === 0) throw new CommandError('ERR The stream has exhausted the last possible ID, unable to add more items');

  let id: StreamId;
  if (!a.id) {
    const now = BigInt(Date.now());
    id = now > s.lastId.ms ? { ms: now, seq: 0n } : (nextId(s.lastId) as StreamId);
  } else if (!a.seqGiven) {
    if (s.lastId.ms === a.id.ms) {
      if (s.lastId.seq === U64_MAX) throw new CommandError(RespMessages.STREAM_ID_SMALL);
      id = { ms: a.id.ms, seq: s.lastId.seq + 1n };
    } else {
      id = a.id;
    }
  } else {
    id = a.id;
  }
  if (compareIds(id, s.lastId) <= 0) throw new CommandError(RespMessages.STREAM_ID_SMALL);

  if (!existing) ctx.db.set(key, { type: 'stream', value: s });
  const cfg = ctx.server.config;
  s.append({ id, fields: args.slice(a.next) }, cfg.num('stream-node-max-entries'), cfg.num('stream-node-max-bytes'));
  s.lastId = id;
  s.entriesAdded++;
  applyTrim(s, a);
  return idToString(id);
}

function xtrim(ctx: CommandContext, args: string[]): Reply {
  const a = parseAddTrim(ctx, args, false);
  const s = stream(ctx, args[0]);
  return s ? applyTrim(s, a) : 0;
}

function xrange(ctx: CommandContext, args: string[], rev: boolean): Reply {
  const start = rangeStart(rev ? args[2] : args[1]);
  const end = rangeEnd(rev ? args[1] : args[2]);
  let count = -1;
  for (let j = 3; j < args.length; j++) {
    if (args[j].toLowerCase() === 'count' && j + 1 < args.length) {
      count = Math.max(0, parseInteger(args[++j]));
    } else {
      throw new CommandError(RespMessages.SYNTAX);
    }
  }
  if (count === 0) return [];
  const s = stream(ctx, args[0]);
  if (!s || compareIds(start, end) > 0) return [];
  const limit = count < 0 ? undefined : count;
  if (!rev) return s.range(start, end, limit).map(entryReply);
  const all = s.range(start, end).reverse();
  return (limit !== undefined ? all.slice(0, limit) : all).map(entryReply);
}

// ---------------------------------------------------------------------------
// XREAD / XREADGROUP
// ---------------------------------------------------------------------------

interface ReadOptions {
  count: number | undefined;
  block: number | null;
  noAck: boolean;
  group: string | null;
  consumer: string;
  keys: string[];
  ids: string[];
}

/** The option loop of xreadCommand (shared by XREAD and XREADGROUP). */
function parseRead(args: string[], xreadgroup: boolean): ReadOptions {
  const o: ReadOptions = { count: undefined, block: null, noAck: false, group: null, consumer: '', keys: [], ids: [] };
  let streamsAt = -1;
  for (let i = 0; i < args.length; i++) {
    const more = args.length - 1 - i;
    const opt = args[i].toLowerCase();
    if (opt === 'block' && more) {
      const ms = parseInteger(args[++i], 'ERR timeout is not an integer or out of range');
      if (ms < 0) throw new CommandError(RespMessages.TIMEOUT_NEGATIVE);
      o.block = ms;
    } else if (opt === 'count' && more) {
      o.count = Math.max(0, parseInteger(args[++i])) || undefined;
    } else if (opt === 'streams' && more) {
      streamsAt = i + 1;
      if ((args.length - streamsAt) % 2) throw new CommandError(xreadgroup ? RespMessages.UNBALANCED_XREADGROUP : RespMessages.UNBALANCED_XREAD);
      break;
    } else if (opt === 'group' && more >= 2) {
      if (!xreadgroup) throw new CommandError('ERR The GROUP option is only supported by XREADGROUP. You called XREAD instead.');
      o.group = args[i + 1];
      o.consumer = args[i + 2];
      i += 2;
    } else if (opt === 'noack') {
      if (!xreadgroup) throw new CommandError('ERR The NOACK option is only supported by XREADGROUP. You called XREAD instead.');
      o.noAck = true;
    } else {
      throw new CommandError(RespMessages.SYNTAX);
    }
  }
  if (streamsAt < 0) throw new CommandError(RespMessages.SYNTAX);
  if (xreadgroup && o.group === null) throw new CommandError('ERR Missing GROUP option for XREADGROUP');
  const n = (args.length - streamsAt) / 2;
  o.keys = args.slice(streamsAt, streamsAt + n);
  o.ids = args.slice(streamsAt + n);
  return o;
}

function xread(ctx: CommandContext, args: string[]): HandlerResult {
  const o = parseRead(args, false);
  // `$` resolves once, at call time: only entries added after the call count.
  const after = o.keys.map((key, j): StreamId => {
    const s = stream(ctx, key);
    const raw = o.ids[j];
    if (raw === '$') return s?.lastId ?? ZERO_ID;
    if (raw === '+') return s && s.length ? (prevId(s.entries[s.length - 1].id) ?? ZERO_ID) : (s?.lastId ?? ZERO_ID);
    if (raw === '>') throw new CommandError('ERR The > ID can be specified only when calling XREADGROUP using the GROUP <group> <consumer> option.');
    return requireId(raw);
  });
  const attempt = (): Reply | undefined => {
    const out: Array<[Reply, Reply]> = [];
    o.keys.forEach((key, j) => {
      let s: Stream | undefined;
      try {
        s = stream(ctx, key);
      } catch {
        return;
      }
      if (!s) return;
      const entries = s.after(after[j], o.count);
      if (entries.length) out.push([key, entries.map(entryReply)]);
    });
    return out.length ? new RespMap(out, true) : undefined;
  };
  if (o.block === null) return attempt() ?? NULL_ARRAY;
  return blockingCommand(ctx, o.keys, o.block, attempt);
}

/** Adds (or reassigns) a PEL entry for `e` delivered through `>`. */
function deliverNew(g: ConsumerGroup, c: Consumer, e: StreamEntry, now: number): void {
  const k = idToString(e.id);
  const prev = g.pending.get(k);
  if (prev) {
    g.consumers.get(prev.consumer)?.pending.delete(k);
    prev.consumer = c.name;
    prev.deliveryTime = now;
    prev.deliveryCount = 1;
    c.pending.set(k, prev);
    return;
  }
  const p: PendingEntry = { id: e.id, consumer: c.name, deliveryTime: now, deliveryCount: 1 };
  g.pending.set(k, p);
  c.pending.set(k, p);
}

function xreadgroup(ctx: CommandContext, args: string[]): HandlerResult {
  const o = parseRead(args, true);
  const groupName = o.group as string;
  const consumerName = o.consumer;
  // Per stream, in order: type, group, then the id.
  const from = o.keys.map((key, j): StreamId | null => {
    const s = stream(ctx, key);
    if (!s || !s.groups.has(groupName)) {
      throw new CommandError(`NOGROUP No such key '${key}' or consumer group '${groupName}' in XREADGROUP with GROUP option`);
    }
    const raw = o.ids[j];
    if (raw === '$') throw new CommandError(RespMessages.XREADGROUP_DOLLAR);
    if (raw === '>') return null;
    return requireId(raw);
  });

  /** `blocked`: re-run after the client was parked (the key or group may be gone by now). */
  const attempt = (blocking: boolean, blocked: boolean): Reply | undefined => {
    const out: Array<[Reply, Reply]> = [];
    const now = Date.now();
    let served = false;
    for (const [j, key] of o.keys.entries()) {
      let s: Stream | undefined;
      try {
        s = stream(ctx, key);
      } catch {
        s = undefined;
      }
      if (!s) {
        if (blocked) return new RespError('UNBLOCKED the stream key no longer exists');
        continue;
      }
      const g = s.groups.get(groupName);
      if (!g) {
        if (blocked) return new RespError('NOGROUP the consumer group this client was blocked on no longer exists');
        continue;
      }
      const c = getConsumer(g, consumerName);
      c.seenTime = now;
      const start = from[j];
      if (start === null) {
        const entries = s.after(g.lastId, o.count);
        if (!entries.length) continue;
        for (const e of entries) {
          advanceGroup(s, g, e.id);
          if (!o.noAck) deliverNew(g, c, e, now);
          c.activeTime = now;
        }
        served = true;
        ctx.server.touch(ctx.client.dbIndex, key);
        out.push([key, entries.map(entryReply)]);
      } else {
        // History: this consumer's pending entries after the given id. Deleted entries come back as [id, nil].
        const pending = [...c.pending.values()].filter((p) => compareIds(p.id, start) > 0).sort((a, b) => compareIds(a.id, b.id));
        const picked = o.count ? pending.slice(0, o.count) : pending;
        served = true;
        out.push([
          key,
          picked.map((p): Reply => {
            const e = s.find(p.id);
            if (!e) return [idToString(p.id), NULL_ARRAY];
            p.deliveryTime = now;
            p.deliveryCount++;
            return entryReply(e);
          }),
        ]);
      }
    }
    if (!served && blocking) return undefined;
    return served ? new RespMap(out, true) : NULL_ARRAY;
  };

  if (o.block === null || from.some((id) => id !== null)) return attempt(false, false) ?? NULL_ARRAY;
  let calls = 0;
  return blockingCommand(ctx, o.keys, o.block, () => attempt(true, calls++ > 0));
}

// ---------------------------------------------------------------------------
// XACK / XPENDING / XCLAIM / XAUTOCLAIM
// ---------------------------------------------------------------------------

function xack(ctx: CommandContext, args: string[]): Reply {
  const s = stream(ctx, args[0]);
  const ids = args.slice(2).map((raw) => requireId(raw));
  const g = s?.groups.get(args[1]);
  if (!g) return 0;
  let n = 0;
  for (const id of ids) {
    const k = idToString(id);
    const p = g.pending.get(k);
    if (!p) continue;
    g.pending.delete(k);
    g.consumers.get(p.consumer)?.pending.delete(k);
    n++;
  }
  return n;
}

function xpending(ctx: CommandContext, args: string[]): Reply {
  const argc = args.length + 1;
  if (argc > 3 && argc < 6) throw new CommandError(RespMessages.SYNTAX);
  let minIdle = 0;
  let start = ZERO_ID;
  let end = MAX_ID;
  let count = 0;
  let consumer: string | undefined;
  if (argc >= 6) {
    let i = 2;
    if (args[2].toLowerCase() === 'idle') {
      minIdle = parseInteger(args[3]);
      if (argc < 8) throw new CommandError(RespMessages.SYNTAX);
      i += 2;
    }
    count = Math.max(0, parseInteger(args[i + 2]));
    start = rangeStart(args[i]);
    end = rangeEnd(args[i + 1]);
    consumer = args[i + 3];
  }
  const { g } = getGroup(ctx, args[0], args[1]);
  const all = [...g.pending.values()].sort((a, b) => compareIds(a.id, b.id));
  if (argc === 3) {
    if (!all.length) return [0, null, null, NULL_ARRAY];
    const perConsumer: Reply[] = [];
    for (const c of [...g.consumers.values()].sort(byName)) {
      if (c.pending.size) perConsumer.push([c.name, String(c.pending.size)]);
    }
    return [all.length, idToString(all[0].id), idToString(all[all.length - 1].id), perConsumer];
  }
  if (consumer !== undefined && !g.consumers.has(consumer)) return [];
  const now = Date.now();
  const out: Reply[] = [];
  for (const p of all) {
    if (out.length >= count) break;
    if (compareIds(p.id, start) < 0) continue;
    if (compareIds(p.id, end) > 0) break;
    if (consumer !== undefined && p.consumer !== consumer) continue;
    const idle = now - p.deliveryTime;
    if (minIdle && idle < minIdle) continue;
    out.push([idToString(p.id), p.consumer, idle, p.deliveryCount]);
  }
  return out;
}

function dropPending(g: ConsumerGroup, p: PendingEntry): void {
  const k = idToString(p.id);
  g.pending.delete(k);
  g.consumers.get(p.consumer)?.pending.delete(k);
}

/** Moves a pending entry to `c` (no-op on ownership when it is already c's). */
function moveTo(g: ConsumerGroup, c: Consumer, p: PendingEntry): void {
  const k = idToString(p.id);
  if (p.consumer !== c.name) {
    if (p.consumer) g.consumers.get(p.consumer)?.pending.delete(k);
    p.consumer = c.name;
  }
  c.pending.set(k, p);
}

function xclaim(ctx: CommandContext, args: string[]): Reply {
  const [key, groupName, consumerName, rawIdle] = args;
  const { s, g } = getGroup(ctx, key, groupName);
  const minIdle = Math.max(0, parseInteger(rawIdle, 'ERR Invalid min-idle-time argument for XCLAIM'));
  const ids: StreamId[] = [];
  let i = 4;
  for (; i < args.length; i++) {
    const id = parseStreamId(args[i]);
    if (!id) break;
    ids.push(id);
  }
  const now = Date.now();
  let deliveryTime = -1;
  let retryCount = -1;
  let force = false;
  let justId = false;
  let lastId = ZERO_ID;
  for (; i < args.length; i++) {
    const more = args.length - 1 - i;
    const opt = args[i].toLowerCase();
    if (opt === 'force') force = true;
    else if (opt === 'justid') justId = true;
    else if (opt === 'idle' && more) deliveryTime = now - parseInteger(args[++i], 'ERR Invalid IDLE option argument for XCLAIM');
    else if (opt === 'time' && more) deliveryTime = parseInteger(args[++i], 'ERR Invalid TIME option argument for XCLAIM');
    else if (opt === 'retrycount' && more) retryCount = parseInteger(args[++i], 'ERR Invalid RETRYCOUNT option argument for XCLAIM');
    else if (opt === 'lastid' && more) lastId = requireId(args[++i]);
    else throw new CommandError(`ERR Unrecognized XCLAIM option '${args[i]}'`);
  }
  if (deliveryTime < 0 || deliveryTime > now) deliveryTime = now;
  if (compareIds(lastId, g.lastId) > 0) g.lastId = lastId;

  const out: Reply[] = [];
  for (const id of ids) {
    const k = idToString(id);
    let p = g.pending.get(k);
    const e = s.find(id);
    if (!e) {
      if (p) dropPending(g, p);
      continue;
    }
    if (force && !p) {
      p = { id, consumer: '', deliveryTime: now, deliveryCount: 1 };
      g.pending.set(k, p);
    }
    if (!p) continue;
    if (p.consumer && minIdle && now - p.deliveryTime < minIdle) continue;
    const c = getConsumer(g, consumerName);
    moveTo(g, c, p);
    p.deliveryTime = deliveryTime;
    if (retryCount >= 0) p.deliveryCount = retryCount;
    else if (!justId) p.deliveryCount++;
    out.push(justId ? k : entryReply(e));
    c.activeTime = now;
  }
  return out;
}

function xautoclaim(ctx: CommandContext, args: string[]): Reply {
  const [key, groupName, consumerName, rawIdle, rawStart] = args;
  const minIdle = Math.max(0, parseInteger(rawIdle, 'ERR Invalid min-idle-time argument for XAUTOCLAIM'));
  const start = rangeStart(rawStart);
  let count = 100;
  let justId = false;
  for (let i = 5; i < args.length; i++) {
    const more = args.length - 1 - i;
    const opt = args[i].toLowerCase();
    if (opt === 'count' && more) {
      count = parseInteger(args[++i], 'ERR COUNT must be > 0');
      if (count < 1 || count > Number.MAX_SAFE_INTEGER / 16) throw new CommandError('ERR COUNT must be > 0');
    } else if (opt === 'justid') justId = true;
    else throw new CommandError(RespMessages.SYNTAX);
  }
  const { s, g } = getGroup(ctx, key, groupName);
  const now = Date.now();
  const candidates = [...g.pending.values()].filter((p) => compareIds(p.id, start) >= 0).sort((a, b) => compareIds(a.id, b.id));
  const claimed: Reply[] = [];
  const deleted: string[] = [];
  let attempts = count * 10;
  let pos = 0;
  while (attempts-- > 0 && count > 0 && pos < candidates.length) {
    const p = candidates[pos++];
    const k = idToString(p.id);
    const e = s.find(p.id);
    if (!e) {
      dropPending(g, p);
      deleted.push(k);
      count--;
      continue;
    }
    if (minIdle && now - p.deliveryTime < minIdle) continue;
    const c = getConsumer(g, consumerName);
    moveTo(g, c, p);
    p.deliveryTime = now;
    if (!justId) p.deliveryCount++;
    claimed.push(justId ? k : entryReply(e));
    c.activeTime = now;
    count--;
  }
  const next = pos < candidates.length ? candidates[pos].id : ZERO_ID;
  return [idToString(next), claimed, deleted];
}

// ---------------------------------------------------------------------------
// XGROUP
// ---------------------------------------------------------------------------

const XGROUP_ARITY: Record<string, number> = { create: -5, setid: -5, destroy: 4, createconsumer: 5, delconsumer: 5, help: 2 };

const XGROUP_HELP = [
  'XGROUP <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
  'CREATE <key> <groupname> <id|$> [option]',
  '    Create a new consumer group. Options are:',
  '    * MKSTREAM',
  '      Create the empty stream if it does not exist.',
  '    * ENTRIESREAD entries_read',
  '      Set the group\'s entries_read counter (internal use).',
  'CREATECONSUMER <key> <groupname> <consumer>',
  '    Create a new consumer in the specified group.',
  'DELCONSUMER <key> <groupname> <consumer>',
  '    Remove the specified consumer.',
  'DESTROY <key> <groupname>',
  '    Remove the specified group.',
  'SETID <key> <groupname> <id|$> [ENTRIESREAD entries_read]',
  '    Set the current group ID and entries_read counter.',
  'HELP',
  '    Print this help.',
];

function parseEntriesRead(raw: string): number | null {
  const n = parseInteger(raw);
  if (n < 0 && n !== -1) throw new CommandError('ERR value for ENTRIESREAD must be positive or -1');
  return n === -1 ? null : n;
}

function xgroup(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  if (!(sub in XGROUP_ARITY)) throw new CommandError(unknownSubcommand(args[0], 'xgroup'));
  checkSubArity('xgroup', sub, args, XGROUP_ARITY);
  if (sub === 'help') return XGROUP_HELP;
  const key = args[1];
  const groupName = args[2];
  let mkstream = false;
  let entriesRead: number | null | undefined;
  if (sub === 'create') {
    for (let i = 4; i < args.length; ) {
      const opt = args[i].toLowerCase();
      if (opt === 'mkstream') {
        mkstream = true;
        i++;
      } else if (opt === 'entriesread' && i + 1 < args.length) {
        entriesRead = parseEntriesRead(args[i + 1]);
        i += 2;
      } else {
        throw subcommandSyntaxError(args[0], 'xgroup');
      }
    }
  } else if (sub === 'setid') {
    if (args.length === 6 && args[4].toLowerCase() === 'entriesread') entriesRead = parseEntriesRead(args[5]);
    else if (args.length !== 4) throw subcommandSyntaxError(args[0], 'xgroup');
  }

  let s = stream(ctx, key);
  const g = s?.groups.get(groupName);
  if (!mkstream) {
    if (!s) throw new CommandError(RespMessages.XGROUP_NO_KEY);
    if (!g && (sub === 'setid' || sub === 'createconsumer' || sub === 'delconsumer')) throw nogroupForKey(key, groupName);
  }

  if (sub === 'create') {
    const rawId = args[3];
    const lastId = rawId === '$' ? (s?.lastId ?? ZERO_ID) : requireId(rawId);
    if (!s) {
      s = new Stream();
      ctx.db.set(key, { type: 'stream', value: s });
    }
    if (g) throw new CommandError(RespMessages.BUSYGROUP);
    const read = entriesRead !== undefined ? entriesRead : rawId === '$' ? s.entriesAdded : null;
    s.groups.set(groupName, { name: groupName, lastId, entriesRead: read, pending: new Map(), consumers: new Map() });
    return OK;
  }
  const st = s as Stream;
  if (sub === 'setid') {
    const grp = g as ConsumerGroup;
    grp.lastId = args[3] === '$' ? st.lastId : requireId(args[3]);
    grp.entriesRead = entriesRead ?? null;
    return OK;
  }
  if (sub === 'destroy') {
    if (!g) return 0;
    st.groups.delete(groupName);
    return 1;
  }
  const grp = g as ConsumerGroup;
  const consumerName = args[3];
  if (sub === 'createconsumer') {
    if (grp.consumers.has(consumerName)) return 0;
    getConsumer(grp, consumerName);
    return 1;
  }
  // delconsumer
  const c = grp.consumers.get(consumerName);
  if (!c) return 0;
  for (const k of c.pending.keys()) grp.pending.delete(k);
  grp.consumers.delete(consumerName);
  return c.pending.size;
}

// ---------------------------------------------------------------------------
// XINFO
// ---------------------------------------------------------------------------

const XINFO_ARITY: Record<string, number> = { stream: -3, groups: 3, consumers: 4, help: 2 };

const XINFO_HELP = [
  'XINFO <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
  'CONSUMERS <key> <groupname>',
  '    Show consumers of <groupname>.',
  'GROUPS <key>',
  '    Show the stream consumer groups.',
  'STREAM <key> [FULL [COUNT <count>]',
  '    Show information about the stream.',
  'HELP',
  '    Print this help.',
];

function xinfoStream(s: Stream, args: string[]): Reply {
  let full = false;
  let count = 10;
  if (args.length > 2) {
    if (args[2].toLowerCase() !== 'full') throw new CommandError(RespMessages.SYNTAX);
    full = true;
    if (args.length === 5 && args[3].toLowerCase() === 'count') count = Math.max(0, parseInteger(args[4]));
    else if (args.length !== 3) throw new CommandError(RespMessages.SYNTAX);
  }
  const first = s.entries[0];
  const last = s.entries[s.length - 1];
  const head: Reply[] = [
    'length', s.length,
    'radix-tree-keys', s.nodes.length,
    'radix-tree-nodes', s.nodes.length ? s.nodes.length + 1 : 1,
    'last-generated-id', idToString(s.lastId),
    'max-deleted-entry-id', idToString(s.maxDeletedId),
    'entries-added', s.entriesAdded,
    'recorded-first-entry-id', first ? idToString(first.id) : '0-0',
  ];
  if (!full) {
    return RespMap.from([...head, 'groups', s.groups.size, 'first-entry', first ? entryReply(first) : null, 'last-entry', last ? entryReply(last) : null]);
  }
  const limit = <T>(xs: T[]): T[] => (count ? xs.slice(0, count) : xs);
  const groups = [...s.groups.values()].sort(byName).map((g) => {
    const pel = [...g.pending.values()].sort((a, b) => compareIds(a.id, b.id));
    const consumers = [...g.consumers.values()].sort(byName).map((c) => {
      const cpel = [...c.pending.values()].sort((a, b) => compareIds(a.id, b.id));
      return RespMap.from([
        'name', c.name,
        'seen-time', c.seenTime,
        'active-time', c.activeTime,
        'pel-count', c.pending.size,
        'pending', limit(cpel).map((p) => [idToString(p.id), p.deliveryTime, p.deliveryCount]),
      ]);
    });
    return RespMap.from([
      'name', g.name,
      'last-delivered-id', idToString(g.lastId),
      'entries-read', g.entriesRead,
      'lag', lagOf(s, g),
      'pel-count', g.pending.size,
      'pending', limit(pel).map((p) => [idToString(p.id), p.consumer, p.deliveryTime, p.deliveryCount]),
      'consumers', consumers,
    ]);
  });
  return RespMap.from([...head, 'entries', limit(s.entries).map(entryReply), 'groups', groups]);
}

function xinfo(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  if (!(sub in XINFO_ARITY)) throw new CommandError(unknownSubcommand(args[0], 'xinfo'));
  checkSubArity('xinfo', sub, args, XINFO_ARITY);
  if (sub === 'help') return XINFO_HELP;
  const key = args[1];
  const s = stream(ctx, key);
  if (!s) throw new CommandError(RespMessages.NO_SUCH_KEY_STREAM);
  if (sub === 'stream') return xinfoStream(s, args);
  if (sub === 'groups') {
    return [...s.groups.values()].sort(byName).map((g) =>
      RespMap.from([
        'name', g.name,
        'consumers', g.consumers.size,
        'pending', g.pending.size,
        'last-delivered-id', idToString(g.lastId),
        'entries-read', g.entriesRead,
        'lag', lagOf(s, g),
      ]),
    );
  }
  // consumers
  const g = s.groups.get(args[2]);
  if (!g) throw nogroupForKey(key, args[2]);
  const now = Date.now();
  return [...g.consumers.values()].sort(byName).map((c) =>
    RespMap.from(['name', c.name, 'pending', c.pending.size, 'idle', now - c.seenTime, 'inactive', c.activeTime < 0 ? -1 : now - c.activeTime]),
  );
}

// ---------------------------------------------------------------------------
// XSETID / XDEL
// ---------------------------------------------------------------------------

function xsetid(ctx: CommandContext, args: string[]): Reply {
  const id = requireId(args[1]);
  let entriesAdded = -1;
  let maxDeleted = ZERO_ID;
  for (let i = 2; i < args.length; i += 2) {
    const more = args.length - 1 - i;
    const opt = args[i].toLowerCase();
    if (opt === 'entriesadded' && more) {
      entriesAdded = parseInteger(args[i + 1]);
      if (entriesAdded < 0) throw new CommandError('ERR entries_added must be positive');
    } else if (opt === 'maxdeletedid' && more) {
      maxDeleted = requireId(args[i + 1]);
      if (compareIds(id, maxDeleted) < 0) throw new CommandError('ERR The ID specified in XSETID is smaller than the provided max_deleted_entry_id');
    } else {
      throw new CommandError(RespMessages.SYNTAX);
    }
  }
  const s = stream(ctx, args[0]);
  if (!s) throw new CommandError(RespMessages.NO_SUCH_KEY_STREAM);
  if (compareIds(id, s.maxDeletedId) < 0) throw new CommandError('ERR The ID specified in XSETID is smaller than current max_deleted_entry_id');
  if (s.length) {
    if (compareIds(id, s.entries[s.length - 1].id) < 0) throw new CommandError('ERR The ID specified in XSETID is smaller than the target stream top item');
    if (entriesAdded !== -1 && s.length > entriesAdded) {
      throw new CommandError('ERR The entries_added specified in XSETID is smaller than the target stream length');
    }
  }
  s.lastId = id;
  if (entriesAdded !== -1) s.entriesAdded = entriesAdded;
  if (compareIds(maxDeleted, ZERO_ID) !== 0) s.maxDeletedId = maxDeleted;
  return OK;
}

function xdel(ctx: CommandContext, args: string[]): Reply {
  const s = stream(ctx, args[0]);
  if (!s) return 0;
  const ids = args.slice(1).map((raw) => requireId(raw));
  return ids.reduce((n, id) => n + (s.delete(id) ? 1 : 0), 0);
}

export const streamCommands: CommandSpec[] = [
  { name: 'xadd', arity: -5, flags: W, keys: keysAt(0), handler: xadd },
  { name: 'xlen', arity: 2, handler: (ctx, args) => stream(ctx, args[0])?.length ?? 0 },
  { name: 'xrange', arity: -4, handler: (ctx, args) => xrange(ctx, args, false) },
  { name: 'xrevrange', arity: -4, handler: (ctx, args) => xrange(ctx, args, true) },
  { name: 'xdel', arity: -3, flags: W, keys: keysAt(0), handler: xdel },
  { name: 'xtrim', arity: -4, flags: W, keys: keysAt(0), handler: xtrim },
  { name: 'xread', arity: -4, handler: xread },
  { name: 'xreadgroup', arity: -7, flags: W, handler: xreadgroup },
  { name: 'xack', arity: -4, flags: W, keys: keysAt(0), handler: xack },
  { name: 'xpending', arity: -3, handler: xpending },
  { name: 'xclaim', arity: -6, flags: W, keys: keysAt(0), handler: xclaim },
  { name: 'xautoclaim', arity: -6, flags: W, keys: keysAt(0), handler: xautoclaim },
  { name: 'xgroup', arity: -2, flags: W, keys: (args) => (args[1] !== undefined && args[0].toLowerCase() !== 'help' ? [args[1]] : []), handler: xgroup },
  { name: 'xinfo', arity: -2, handler: xinfo },
  { name: 'xsetid', arity: -3, flags: W, keys: keysAt(0), handler: xsetid },
];
