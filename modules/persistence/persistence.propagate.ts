/**
 * Command propagation: what Redis writes to the AOF and sends to replicas for a command it just executed.
 *
 * Redis never propagates a command as typed when replaying it would not be deterministic. Relative expires become
 * absolute (PEXPIREAT / SET … PXAT), INCRBYFLOAT becomes SET … KEEPTTL, SPOP becomes SREM, blocking pops become their
 * non-blocking forms, scripts are replicated by their effects (the write commands they ran), XREADGROUP becomes XCLAIM +
 * XGROUP SETID, and so on (Redis 7.0+ semantics, unchanged in 8.x as far as known).
 *
 * Two layers:
 * - `propagateOps()` / `propagate()`: the pure rewrite of one executed command, given the keyspace after it ran.
 * - `Propagator`: Redis's "execution unit" model (server.also_propagate + propagatePendingCommands). Every command the
 *   server executes, nested ones included (EXEC bodies, redis.call inside scripts, blocked clients being served), is
 *   recorded into the current unit; when the outermost unit ends, its ops go to the sinks (AOF, replication), wrapped in
 *   MULTI/EXEC when there is more than one.
 *
 * Rules marked UNCERTAIN are best recollections of Redis's source, not verified against a running 8.8.
 */
import type { Reply } from '@/libs/resp';
import { NULL_ARRAY, RespError, RespMap, RespPairs, RespSet } from '@/libs/resp';

import { hashFieldExpires } from '@/modules/hashes/hashes.commands';
import type { Database } from '@/modules/database/database.core';
import type { ConsumerGroup, Stream } from '@/modules/streams/streams.structure';
import { idToString, parseStreamId, U64_MAX } from '@/modules/streams/streams.structure';

/** Where an op goes: both the AOF and replicas, or only one of them (PUBLISH goes to replicas only). */
export type PropagationTarget = 'all' | 'aof' | 'repl';

/** One propagated command. `db` is the database it runs in; -1 for MULTI / EXEC (no SELECT is emitted for them). */
export interface PropagatedOp {
  db: number;
  argv: string[];
  target: PropagationTarget;
}

/** The keyspace a rewrite reads (after the command ran). */
export type KeyspaceView = Pick<Database, 'peek' | 'getExpire'>;

export interface PropagateContext {
  /** Database the command ran in. */
  db: number;
  /** That database, after the command ran. */
  database: KeyspaceView;
  /** lazyfree-lazy-expire: deletions caused by an expire in the past propagate as UNLINK instead of DEL. */
  lazyfreeLazyExpire?: boolean;
  /** lazyfree-lazy-server-del: server-side deletions (SPOP of a whole set, RESTORE with a past TTL) propagate as UNLINK. */
  lazyfreeLazyServerDel?: boolean;
  /**
   * Keys on which XREADGROUP created the reading consumer (Redis propagates XGROUP CREATECONSUMER first).
   * The post-command state cannot tell, so the stream code has to report it.
   */
  createdConsumerKeys?: readonly string[];
}

/** Commands that are never propagated themselves (scripts and transactions propagate the commands they ran). */
const NEVER = new Set([
  'eval', 'evalsha', 'eval_ro', 'evalsha_ro', 'fcall', 'fcall_ro', 'multi', 'exec', 'discard', 'watch', 'unwatch', 'select',
  // SCRIPT LOAD / FLUSH are not propagated since Redis 7.0 (effects replication only). UNCERTAIN for SCRIPT FLUSH.
  'script',
]);

/** FUNCTION subcommands that change state and are propagated verbatim. */
const FUNCTION_WRITES = new Set(['load', 'delete', 'flush', 'restore']);

/**
 * Commands Redis propagates even when they did not change the dirty counter (forceCommandPropagation / dirty++ always):
 * FLUSHALL, FLUSHDB, SWAPDB, FUNCTION LOAD/DELETE/FLUSH/RESTORE, and PUBLISH / SPUBLISH (to replicas only).
 */
export function isForcedPropagation(argv: readonly string[]): boolean {
  const name = argv[0].toLowerCase();
  if (name === 'flushall' || name === 'flushdb' || name === 'swapdb' || name === 'publish' || name === 'spublish') return true;
  return name === 'function' && argv.length > 1 && FUNCTION_WRITES.has(argv[1].toLowerCase());
}

/** Commands flagged CMD_TOUCHES_ARBITRARY_KEYS: their lazy-expire DELs are not wrapped in MULTI/EXEC. */
const TOUCHES_ARBITRARY_KEYS = new Set(['keys', 'scan', 'randomkey']);

/** Redis AOF_REWRITE_ITEMS_PER_CMD and SPOP_MOVE_STRATEGY batch size. */
const SPOP_BATCH = 1024;

const lc = (s: string): string => s.toLowerCase();

function op(db: number, argv: string[], target: PropagationTarget = 'all'): PropagatedOp {
  return { db, argv, target };
}

/** Items of an array-like reply (array, RESP3 set, pairs flattened to [a, b] pairs). */
function items(reply: Reply): Reply[] {
  if (Array.isArray(reply)) return reply;
  if (reply instanceof RespSet) return reply.items;
  if (reply instanceof RespPairs) return reply.pairs;
  return [];
}

function str(reply: Reply): string {
  if (typeof reply === 'string') return reply;
  if (typeof reply === 'number' || typeof reply === 'bigint') return String(reply);
  return '';
}

function delOp(db: number, key: string, lazy: boolean): PropagatedOp {
  return op(db, [lazy ? 'UNLINK' : 'DEL', key]);
}

/** DEL / UNLINK Redis propagates when a key expires (lazily or by the active cycle), per lazyfree-lazy-expire. */
export function expiredKeyOp(db: number, key: string, lazyfreeLazyExpire: boolean): PropagatedOp {
  return delOp(db, key, lazyfreeLazyExpire);
}

/**
 * How an executed command is propagated: zero or more ops in the command's database. Call it only for a command that
 * changed the dataset (Redis: server.dirty moved) or `isForcedPropagation`; no-op writes must not be propagated at all.
 */
export function propagateOps(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
  const name = lc(argv[0]);
  const db = ctx.db;
  if (NEVER.has(name)) return [];
  if (reply instanceof RespError) return [];
  const verbatim = (): PropagatedOp[] => [op(db, [...argv])];
  const exists = (key: string): boolean => ctx.database.peek(key) !== undefined;
  const expireOf = (key: string): number | undefined => ctx.database.getExpire(key);
  const lazyExpire = Boolean(ctx.lazyfreeLazyExpire);
  const lazyServer = Boolean(ctx.lazyfreeLazyServerDel);

  switch (name) {
    case 'function':
      return argv.length > 1 && FUNCTION_WRITES.has(lc(argv[1])) ? verbatim() : [];
    case 'publish':
    case 'spublish':
      return [op(db, [...argv], 'repl')];

    // ---- strings -----------------------------------------------------------------------------------------------
    case 'set':
      return propagateSet(argv, ctx);
    case 'setex':
    case 'psetex': {
      // setGenericCommand rewrites to SET key value PXAT <ms>.
      const key = argv[1];
      const at = expireOf(key);
      if (at === undefined) return exists(key) ? [op(db, ['SET', key, argv[3]])] : [delOp(db, key, lazyExpire)];
      return [op(db, ['SET', key, argv[3], 'PXAT', String(at)])];
    }
    case 'getset':
      // getsetCommand: rewriteClientCommandArgument(c, 0, shared.set).
      return [op(db, ['SET', ...argv.slice(1)])];
    case 'getdel':
      return [op(db, ['DEL', argv[1]])];
    case 'getex':
      return propagateGetex(argv, ctx);
    case 'incrbyfloat':
      // Float formatting may differ between hosts, so the result is propagated (Redis: SET key value KEEPTTL).
      return [op(db, ['SET', argv[1], str(reply), 'KEEPTTL'])];

    // ---- keys --------------------------------------------------------------------------------------------------
    case 'expire':
    case 'pexpire':
    case 'expireat':
    case 'pexpireat': {
      // expireGenericCommand: a time in the past deletes the key (DEL / UNLINK per lazyfree-lazy-expire); otherwise
      // argv[0] becomes PEXPIREAT and argv[2] the absolute ms; NX/XX/GT/LT stay (rewriteClientCommandArgument).
      const key = argv[1];
      if (!exists(key)) return [delOp(db, key, lazyExpire)];
      if (name === 'pexpireat') return verbatim();
      const at = expireOf(key);
      return [op(db, ['PEXPIREAT', key, at === undefined ? argv[2] : String(at), ...argv.slice(3)])];
    }
    case 'restore':
      return propagateRestore(argv, ctx);

    // ---- hashes ------------------------------------------------------------------------------------------------
    case 'hincrbyfloat':
      return [op(db, ['HSET', argv[1], argv[2], str(reply)])];
    case 'hexpire':
    case 'hpexpire':
    case 'hexpireat':
    case 'hpexpireat':
      return propagateHexpire(argv, reply, ctx);
    case 'hgetdel':
      return propagateHgetdel(argv, reply, ctx);
    case 'hgetex':
      return propagateHgetex(argv, reply, ctx);
    case 'hsetex':
      return propagateHsetex(argv, ctx);

    // ---- sets --------------------------------------------------------------------------------------------------
    case 'spop': {
      const key = argv[1];
      if (argv.length === 2) {
        const member = reply;
        return typeof member === 'string' ? [op(db, ['SREM', key, member])] : [];
      }
      const members = items(reply).map(str);
      if (!members.length) return [];
      // Whole set popped: spopWithCountCommand propagates DEL / UNLINK (lazyfree-lazy-server-del).
      if (!exists(key)) return [delOp(db, key, lazyServer)];
      const out: PropagatedOp[] = [];
      for (let i = 0; i < members.length; i += SPOP_BATCH) out.push(op(db, ['SREM', key, ...members.slice(i, i + SPOP_BATCH)]));
      return out;
    }

    // ---- lists -------------------------------------------------------------------------------------------------
    case 'blpop':
    case 'brpop': {
      const r = items(reply);
      if (r.length < 2) return [];
      return [op(db, [name === 'blpop' ? 'LPOP' : 'RPOP', str(r[0])])];
    }
    case 'lmpop':
    case 'blmpop': {
      // Replicated as [LR]POP key count (listPopRangeAndReplyWithKey), for LMPOP too.
      const r = items(reply);
      if (r.length < 2) return [];
      const numkeysAt = name === 'lmpop' ? 1 : 2;
      const dir = lc(argv[numkeysAt + 1 + Number(argv[numkeysAt])] ?? 'left');
      return [op(db, [dir === 'left' ? 'LPOP' : 'RPOP', str(r[0]), String(items(r[1]).length)])];
    }
    case 'brpoplpush':
      return reply === null || reply === NULL_ARRAY ? [] : [op(db, ['RPOPLPUSH', argv[1], argv[2]])];
    case 'blmove':
      return reply === null || reply === NULL_ARRAY ? [] : [op(db, ['LMOVE', argv[1], argv[2], argv[3], argv[4]])];

    // ---- sorted sets -------------------------------------------------------------------------------------------
    case 'bzpopmin':
    case 'bzpopmax': {
      const r = items(reply);
      if (!r.length) return [];
      return [op(db, [name === 'bzpopmin' ? 'ZPOPMIN' : 'ZPOPMAX', str(r[0])])];
    }
    case 'zmpop':
    case 'bzmpop': {
      // UNCERTAIN: replicated as ZPOP[MIN|MAX] key <number popped>.
      const r = items(reply);
      if (r.length < 2) return [];
      const numkeysAt = name === 'zmpop' ? 1 : 2;
      const dir = lc(argv[numkeysAt + 1 + Number(argv[numkeysAt])] ?? 'min');
      return [op(db, [dir === 'max' ? 'ZPOPMAX' : 'ZPOPMIN', str(r[0]), String(items(r[1]).length)])];
    }

    // ---- streams -----------------------------------------------------------------------------------------------
    case 'xadd':
      return propagateXadd(argv, reply, ctx);
    case 'xtrim':
      return propagateXtrim(argv, ctx);
    case 'xreadgroup':
      return propagateXreadgroup(argv, reply, ctx);
    case 'xclaim':
      return propagateXclaim(argv, reply, ctx);
    case 'xautoclaim':
      return propagateXautoclaim(argv, reply, ctx);

    default:
      return verbatim();
  }
}

/** `propagateOps` without the routing: the argv of each op, as written to the AOF / replicas (MULTI/EXEC not included). */
export function propagate(argv: readonly string[], reply: Reply, ctx: PropagateContext): string[][] {
  return propagateOps(argv, reply, ctx).map((o) => o.argv);
}

// ---- strings ---------------------------------------------------------------------------------------------------

function propagateSet(argv: readonly string[], ctx: PropagateContext): PropagatedOp[] {
  const db = ctx.db;
  const [, key, value] = argv;
  let expireKind: string | null = null;
  let getAt = -1;
  for (let i = 3; i < argv.length; i++) {
    const o = lc(argv[i]);
    if (o === 'ex' || o === 'px' || o === 'exat' || o === 'pxat') {
      expireKind = o;
      i++;
    } else if (o === 'ifeq' || o === 'ifne' || o === 'ifdeq' || o === 'ifdne') i++;
    else if (o === 'get' && getAt < 0) getAt = i;
  }
  if (expireKind !== null) {
    // An expire time already in the past deletes the key (Redis 7.2+ propagates DEL / UNLINK). UNCERTAIN on 7.0.
    if (ctx.database.peek(key) === undefined) return [delOp(db, key, Boolean(ctx.lazyfreeLazyExpire))];
    if (expireKind === 'pxat') return [op(db, [...argv])];
    // setGenericCommand: replaceClientCommandVector(c, 5, SET, key, val, PXAT, ms) — NX/XX/GET are dropped.
    const at = ctx.database.getExpire(key);
    return [op(db, at === undefined ? ['SET', key, value] : ['SET', key, value, 'PXAT', String(at)])];
  }
  // "Propagate without the GET argument".
  if (getAt >= 0) return [op(db, argv.filter((_, i) => i !== getAt))];
  return [op(db, [...argv])];
}

function propagateGetex(argv: readonly string[], ctx: PropagateContext): PropagatedOp[] {
  const db = ctx.db;
  const key = argv[1];
  let expire = false;
  let persist = false;
  for (let i = 2; i < argv.length; i++) {
    const o = lc(argv[i]);
    if (o === 'ex' || o === 'px' || o === 'exat' || o === 'pxat') {
      expire = true;
      i++;
    } else if (o === 'persist') persist = true;
  }
  if (expire) {
    if (ctx.database.peek(key) === undefined) return [delOp(db, key, Boolean(ctx.lazyfreeLazyExpire))];
    const at = ctx.database.getExpire(key);
    return at === undefined ? [] : [op(db, ['PEXPIREAT', key, String(at)])];
  }
  if (persist) return [op(db, ['PERSIST', key])];
  return [];
}

function propagateRestore(argv: readonly string[], ctx: PropagateContext): PropagatedOp[] {
  const db = ctx.db;
  const key = argv[1];
  // A TTL already in the past: the key is not created; Redis propagates DEL / UNLINK (lazyfree-lazy-server-del).
  if (ctx.database.peek(key) === undefined) return [delOp(db, key, Boolean(ctx.lazyfreeLazyServerDel))];
  const absttl = argv.slice(4).some((a) => lc(a) === 'absttl');
  if (argv[2] === '0' || absttl) return [op(db, [...argv])];
  // restoreCommand: a relative TTL is propagated as an absolute one + ABSTTL.
  const at = ctx.database.getExpire(key);
  if (at === undefined) return [op(db, [...argv])];
  const out = [...argv];
  out[2] = String(at);
  out.push('ABSTTL');
  return [op(db, out)];
}

// ---- hashes ----------------------------------------------------------------------------------------------------

/** Position of the FIELDS keyword (and the fields after numfields) in a hash-field-TTL command. */
function fieldsOf(argv: readonly string[], from: number): { at: number; fields: string[] } | null {
  for (let i = from; i < argv.length; i++) {
    if (lc(argv[i]) === 'fields') {
      const n = Number(argv[i + 1]);
      return { at: i, fields: argv.slice(i + 2, i + 2 + n) };
    }
  }
  return null;
}

function fieldExpire(ctx: PropagateContext, key: string, field: string): number | undefined {
  const v = ctx.database.peek(key);
  if (!v || v.type !== 'hash') return undefined;
  return hashFieldExpires(v.value)?.get(field);
}

/**
 * HEXPIRE family: fields whose time was in the past were deleted (reply 2) → HDEL key f…; the command itself becomes
 * HPEXPIREAT key <ms> [cond] FIELDS n <fields not deleted>, and is dropped when no field was updated (reply 1).
 * UNCERTAIN: whether the HDELs are one command or one per field, and their order relative to HPEXPIREAT.
 */
function propagateHexpire(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
  const db = ctx.db;
  const key = argv[1];
  const spec = fieldsOf(argv, 3);
  if (!spec) return [];
  const codes = items(reply);
  const deleted: string[] = [];
  const kept: string[] = [];
  let updatedField: string | null = null;
  spec.fields.forEach((f, i) => {
    const code = codes[i];
    if (code === 2) deleted.push(f);
    else {
      kept.push(f);
      if (code === 1 && updatedField === null) updatedField = f;
    }
  });
  const out: PropagatedOp[] = [];
  if (deleted.length) out.push(op(db, ['HDEL', key, ...deleted]));
  if (updatedField !== null) {
    const name = lc(argv[0]);
    const at = name === 'hpexpireat' ? argv[2] : String(fieldExpire(ctx, key, updatedField) ?? argv[2]);
    out.push(op(db, ['HPEXPIREAT', key, at, ...argv.slice(3, spec.at), 'FIELDS', String(kept.length), ...kept]));
  }
  return out;
}

/** HGETDEL → HDEL key <fields that existed>. UNCERTAIN (Redis 8.0 command). */
function propagateHgetdel(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
  const spec = fieldsOf(argv, 2);
  if (!spec) return [];
  const values = items(reply);
  const removed = spec.fields.filter((_, i) => values[i] !== null && values[i] !== undefined);
  return removed.length ? [op(ctx.db, ['HDEL', argv[1], ...removed])] : [];
}

/** HGETEX EX/PX/EXAT/PXAT → HPEXPIREAT (or HDEL when the time is past), PERSIST → HPERSIST. UNCERTAIN (Redis 8.0). */
function propagateHgetex(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
  const db = ctx.db;
  const key = argv[1];
  const spec = fieldsOf(argv, 2);
  if (!spec) return [];
  const mode = lc(argv[2]);
  const values = items(reply);
  const present = spec.fields.filter((_, i) => values[i] !== null && values[i] !== undefined);
  if (!present.length) return [];
  if (mode === 'persist') return [op(db, ['HPERSIST', key, 'FIELDS', String(present.length), ...present])];
  if (mode !== 'ex' && mode !== 'px' && mode !== 'exat' && mode !== 'pxat') return [];
  const at = fieldExpire(ctx, key, present[0]);
  if (at === undefined) return [op(db, ['HDEL', key, ...present])];
  return [op(db, ['HPEXPIREAT', key, String(at), 'FIELDS', String(present.length), ...present])];
}

/** HSETEX with EX/PX/EXAT → HSETEX … PXAT <ms> …. UNCERTAIN (Redis 8.0). */
function propagateHsetex(argv: readonly string[], ctx: PropagateContext): PropagatedOp[] {
  const db = ctx.db;
  const key = argv[1];
  const spec = fieldsOf(argv, 2);
  if (!spec) return [op(db, [...argv])];
  const out = [...argv];
  for (let i = 2; i < spec.at; i++) {
    const o = lc(argv[i]);
    if (o === 'ex' || o === 'px' || o === 'exat') {
      const field = spec.fields[0];
      const at = field === undefined ? undefined : fieldExpire(ctx, key, field);
      if (at === undefined) return [op(db, ['HDEL', key, ...spec.fields.filter((_, j) => j % 2 === 0)])];
      out[i] = 'PXAT';
      out[i + 1] = String(at);
      break;
    }
  }
  return [op(db, out)];
}

// ---- streams ---------------------------------------------------------------------------------------------------

const MAX_ID_STRING = `${U64_MAX}-${U64_MAX}`;

function streamAt(ctx: PropagateContext, key: string): Stream | undefined {
  const v = ctx.database.peek(key);
  return v && v.type === 'stream' ? v.value : undefined;
}

/**
 * Rewrites an approximate trim (`~`) to the exact result, as streamRewriteApproxSpecifier / streamRewriteTrimArgument
 * do: `~` → `=`, threshold → resulting length (MAXLEN) or first entry id (MINID). Redis keeps `LIMIT n`, which only the
 * master/AOF client may send with `=`; we drop it because redis-lite's XADD/XTRIM refuse LIMIT without `~`, and once
 * the threshold is exact the limit no longer matters.
 */
function rewriteApproxTrim(out: string[], strategyAt: number, s: Stream | undefined): void {
  if (out[strategyAt + 1] !== '~') return;
  out[strategyAt + 1] = '=';
  const strategy = lc(out[strategyAt]);
  if (strategy === 'maxlen') out[strategyAt + 2] = String(s?.length ?? 0);
  else out[strategyAt + 2] = s && s.length ? idToString(s.entries[0].id) : MAX_ID_STRING;
  for (let i = strategyAt + 3; i < out.length - 1; i++) {
    if (lc(out[i]) === 'limit') {
      out.splice(i, 2);
      break;
    }
  }
}

function propagateXadd(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
  if (typeof reply !== 'string') return [];
  const out = [...argv];
  const key = argv[1];
  let strategyAt = -1;
  let i = 2;
  while (i < out.length) {
    const o = lc(out[i]);
    if (o === 'nomkstream') i++;
    else if (o === 'maxlen' || o === 'minid') {
      strategyAt = i;
      i += out[i + 1] === '~' || out[i + 1] === '=' ? 3 : 2;
    } else if (o === 'limit') i += 2;
    else break;
  }
  // The ID argument becomes the ID actually assigned (auto-generated `*` or `ms-*`).
  if (i < out.length) out[i] = reply;
  if (strategyAt >= 0) rewriteApproxTrim(out, strategyAt, streamAt(ctx, key));
  return [op(ctx.db, out)];
}

function propagateXtrim(argv: readonly string[], ctx: PropagateContext): PropagatedOp[] {
  const out = [...argv];
  rewriteApproxTrim(out, 2, streamAt(ctx, argv[1]));
  return [op(ctx.db, out)];
}

/** streamPropagateXCLAIM: XCLAIM key group consumer 0 id TIME ms RETRYCOUNT n FORCE JUSTID LASTID group-last-id. */
function xclaimArgv(key: string, group: string, consumer: string, id: string, time: number, count: number, lastId: string): string[] {
  return ['XCLAIM', key, group, consumer, '0', id, 'TIME', String(time), 'RETRYCOUNT', String(count), 'FORCE', 'JUSTID', 'LASTID', lastId];
}

/** streamPropagateGroupID: XGROUP SETID key group last-id ENTRIESREAD n. */
function setidArgv(key: string, g: ConsumerGroup): string[] {
  return ['XGROUP', 'SETID', key, g.name, idToString(g.lastId), 'ENTRIESREAD', String(g.entriesRead ?? -1)];
}

/**
 * XREADGROUP is never propagated itself. For every key read with `>`: an XCLAIM per delivered entry (not with NOACK),
 * then XGROUP SETID because the group's last id moved (Redis calls streamPropagateGroupID unconditionally since #9127).
 * History reads (explicit ids) only bump delivery counters and are not propagated.
 */
function propagateXreadgroup(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
  const db = ctx.db;
  let group = '';
  let consumer = '';
  let noack = false;
  let streamsAt = -1;
  for (let i = 1; i < argv.length; i++) {
    const o = lc(argv[i]);
    if (o === 'group') {
      group = argv[i + 1];
      consumer = argv[i + 2];
      i += 2;
    } else if (o === 'count' || o === 'block') i++;
    else if (o === 'noack') noack = true;
    else if (o === 'streams') {
      streamsAt = i;
      break;
    }
  }
  if (streamsAt < 0) return [];
  const rest = argv.slice(streamsAt + 1);
  const half = rest.length / 2;
  const startOf = new Map<string, string>();
  for (let j = 0; j < half; j++) startOf.set(rest[j], rest[half + j]);

  const out: PropagatedOp[] = [];
  for (const key of ctx.createdConsumerKeys ?? []) out.push(op(db, ['XGROUP', 'CREATECONSUMER', key, group, consumer]));
  const served: Array<[Reply, Reply]> = reply instanceof RespMap ? reply.entries : [];
  for (const [rawKey, entries] of served) {
    const key = str(rawKey);
    if (startOf.get(key) !== '>') continue;
    const s = streamAt(ctx, key);
    const g = s?.groups.get(group);
    if (!g) continue;
    const delivered = items(entries);
    if (!delivered.length) continue;
    if (!noack) {
      for (const e of delivered) {
        const id = str(items(e)[0] ?? null);
        const p = g.pending.get(id);
        out.push(op(db, xclaimArgv(key, group, consumer, id, p?.deliveryTime ?? Date.now(), p?.deliveryCount ?? 1, id)));
      }
    }
    out.push(op(db, setidArgv(key, g)));
  }
  return out;
}

/** Ids of an XCLAIM / XAUTOCLAIM claimed list (JUSTID → strings, otherwise [id, fields] entries). */
function claimedIds(list: Reply): string[] {
  return items(list).map((e) => (typeof e === 'string' ? e : str(items(e)[0] ?? null)));
}

/** XCLAIM / XAUTOCLAIM: an XCLAIM … FORCE JUSTID LASTID per claimed entry, with its new delivery time / count. */
function claimOps(ctx: PropagateContext, key: string, group: string, consumer: string, ids: readonly string[], deleted: readonly string[]): PropagatedOp[] {
  const s = streamAt(ctx, key);
  const g = s?.groups.get(group);
  if (!g) return [];
  const lastId = idToString(g.lastId);
  const out: PropagatedOp[] = [];
  for (const id of ids) {
    const p = g.pending.get(id);
    if (p) out.push(op(ctx.db, xclaimArgv(key, group, consumer, id, p.deliveryTime, p.deliveryCount, lastId)));
  }
  // Entries deleted from the stream are dropped from the PEL; Redis propagates an XCLAIM for them too (which drops
  // them on the replica). UNCERTAIN: Redis sends the old NACK's time / count; we no longer have them and send 0.
  for (const id of deleted) out.push(op(ctx.db, xclaimArgv(key, group, consumer, id, 0, 0, lastId)));
  return out;
}

function propagateXclaim(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
  const [, key, group, consumer] = argv;
  const requested: string[] = [];
  let i = 5;
  for (; i < argv.length && parseStreamId(argv[i]) !== null; i++) requested.push(argv[i]);
  let lastIdGiven = false;
  for (; i < argv.length; i++) if (lc(argv[i]) === 'lastid') lastIdGiven = true;
  const claimed = claimedIds(reply);
  const s = streamAt(ctx, key);
  const deleted = requested
    .map((raw) => parseStreamId(raw))
    .filter((id): id is NonNullable<typeof id> => id !== null && s !== undefined && s.find(id) === undefined)
    .map(idToString);
  const out = claimOps(ctx, key, group, consumer, claimed, deleted);
  // LASTID given but nothing claimed: the group's last id still moved → XGROUP SETID.
  if (!out.length && lastIdGiven) {
    const g = s?.groups.get(group);
    if (g) out.push(op(ctx.db, setidArgv(key, g)));
  }
  return out;
}

function propagateXautoclaim(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
  const [, key, group, consumer] = argv;
  const r = items(reply);
  if (r.length < 2) return [];
  return claimOps(ctx, key, group, consumer, claimedIds(r[1]), items(r[2] ?? []).map(str));
}

// ---------------------------------------------------------------------------------------------------------------
// Execution units
// ---------------------------------------------------------------------------------------------------------------

/** Receives each finished unit's ops (already wrapped in MULTI/EXEC when needed). Filter on `target`. */
export type PropagationSink = (ops: readonly PropagatedOp[]) => void;

export interface PropagatorOptions {
  /** The server's databases (read after a command ran, to compute absolute expires etc.). */
  databases: readonly KeyspaceView[];
  /** Live config: lazyfree-lazy-expire, lazyfree-lazy-server-del. */
  config: { get(name: string): string | undefined };
}

/** Extra facts a command reports that the post-command keyspace cannot tell. */
export interface RecordHints {
  createdConsumerKeys?: readonly string[];
}

/**
 * Redis's also_propagate / execution-unit model.
 *
 *   propagator.enter(name)            // every execute(), nested ones included
 *   … run the command …
 *   propagator.record(db, argv, reply, dirtyDelta)
 *   propagator.exit()                 // the outermost exit flushes the unit to the sinks
 *
 * Scripts: EVAL / FCALL record nothing themselves; each redis.call goes through execute(), so its write is recorded
 * into the script's unit ("effects replication"). EXEC likewise. A unit with more than one op is wrapped in
 * MULTI … EXEC; a single op is propagated bare ("the single command is atomic"). The SELECT for an op is emitted by the
 * sink, inside the MULTI.
 */
export class Propagator {
  private depth = 0;
  private pending: PropagatedOp[] = [];
  private noTransaction = false;
  private paused = 0;
  private readonly sinks: PropagationSink[] = [];

  constructor(private readonly options: PropagatorOptions) {}

  /** Adds a sink (AOF, replication). Returns a function that removes it. */
  addSink(sink: PropagationSink): () => void {
    this.sinks.push(sink);
    return () => {
      const i = this.sinks.indexOf(sink);
      if (i >= 0) this.sinks.splice(i, 1);
    };
  }

  /** Stops propagation (while loading the RDB / AOF). Nestable. */
  pause(): void {
    this.paused++;
  }

  resume(): void {
    if (this.paused > 0) this.paused--;
  }

  get isPaused(): boolean {
    return this.paused > 0;
  }

  /** True inside an execution unit. */
  get inUnit(): boolean {
    return this.depth > 0;
  }

  /** Starts (or nests into) an execution unit. `commandName`: the top-level command (KEYS/SCAN/RANDOMKEY never wrap). */
  enter(commandName = ''): void {
    if (this.depth === 0) {
      this.pending = [];
      this.noTransaction = TOUCHES_ARBITRARY_KEYS.has(commandName.toLowerCase());
    }
    this.depth++;
  }

  /** Ends a unit level; the outermost one propagates what was collected. */
  exit(): void {
    if (this.depth === 0) return;
    this.depth--;
    if (this.depth === 0) this.flush();
  }

  private lazy(name: string): boolean {
    return this.options.config.get(name) === 'yes';
  }

  /**
   * Records an executed command. `dirty`: how much the dirty counter moved while it ran (Redis propagates a command
   * only when it did, or when propagation is forced). Returns the ops added.
   */
  record(dbIndex: number, argv: readonly string[], reply: Reply, dirty: number, hints: RecordHints = {}): PropagatedOp[] {
    if (this.paused) return [];
    if (dirty <= 0 && !isForcedPropagation(argv)) return [];
    const database = this.options.databases[dbIndex];
    if (!database) return [];
    const ops = propagateOps(argv, reply, {
      db: dbIndex,
      database,
      lazyfreeLazyExpire: this.lazy('lazyfree-lazy-expire'),
      lazyfreeLazyServerDel: this.lazy('lazyfree-lazy-server-del'),
      createdConsumerKeys: hints.createdConsumerKeys,
    });
    this.push(ops);
    return ops;
  }

  /** Redis alsoPropagate(): adds an op to the current unit (or propagates it at once outside a unit). */
  also(dbIndex: number, argv: string[], target: PropagationTarget = 'all'): void {
    if (this.paused) return;
    this.push([op(dbIndex, argv, target)]);
  }

  /**
   * A key expired (lazily on access, or by the active expire cycle): DEL / UNLINK per lazyfree-lazy-expire. Inside a
   * unit it joins the unit (Redis 7: deleteExpiredKeyAndPropagate → alsoPropagate, flushed at the end of the execution
   * unit), so a write on an expired key propagates as MULTI, DEL, <write>, EXEC. UNCERTAIN for 8.x.
   */
  expired(dbIndex: number, key: string): void {
    if (this.paused) return;
    this.push([expiredKeyOp(dbIndex, key, this.lazy('lazyfree-lazy-expire'))]);
  }

  private push(ops: PropagatedOp[]): void {
    if (!ops.length) return;
    this.pending.push(...ops);
    if (this.depth === 0) this.flush();
  }

  private flush(): void {
    const ops = this.pending;
    this.pending = [];
    if (!ops.length) return;
    const wrapped = ops.length > 1 && !this.noTransaction ? [op(-1, ['MULTI']), ...ops, op(-1, ['EXEC'])] : ops;
    for (const sink of [...this.sinks]) sink(wrapped);
  }
}
