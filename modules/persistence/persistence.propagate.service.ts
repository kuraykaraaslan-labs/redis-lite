import type { Reply } from '@/libs/resp';
import { NULL_ARRAY, RespError } from '@/libs/resp';

import PropagateBaseRules from './persistence.propagate_base.rules';
import PropagateHashRules from './persistence.propagate_hashes.rules';
import PropagateStreamRules from './persistence.propagate_streams.rules';
import PropagateTimeseriesRules from './persistence.propagate_timeseries.rules';
import type { PropagateContext, PropagatedOp } from './persistence.types';

/**
 * Command propagation: what Redis writes to the AOF and sends to replicas for a command it just executed.
 *
 * Redis never propagates a command as typed when replaying it would not be deterministic. Relative expires become
 * absolute (PEXPIREAT / SET … PXAT), INCRBYFLOAT becomes SET … KEEPTTL, SPOP becomes SREM, blocking pops become their
 * non-blocking forms, scripts are replicated by their effects (the write commands they ran), XREADGROUP becomes XCLAIM +
 * XGROUP SETID, and so on (Redis 7.0+ semantics, unchanged in 8.x as far as known). This is the pure rewrite of one
 * executed command, given the keyspace after it ran; the execution-unit model lives in the Propagator.
 *
 * Rules marked UNCERTAIN are best recollections of Redis's source, not verified against a running 8.8.
 */
export default class PersistencePropagateService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Commands that are never propagated themselves (scripts and transactions propagate the commands they ran). */
  private static readonly NEVER = new Set([
    'eval', 'evalsha', 'eval_ro', 'evalsha_ro', 'fcall', 'fcall_ro', 'multi', 'exec', 'discard', 'watch', 'unwatch', 'select',
    // SCRIPT LOAD / FLUSH are not propagated since Redis 7.0 (effects replication only). UNCERTAIN for SCRIPT FLUSH.
    'script',
  ]);

  /** FUNCTION subcommands that change state and are propagated verbatim. */
  private static readonly FUNCTION_WRITES = new Set(['load', 'delete', 'flush', 'restore']);

  /** Redis AOF_REWRITE_ITEMS_PER_CMD and SPOP_MOVE_STRATEGY batch size. */
  private static readonly SPOP_BATCH = 1024;

  // ──────────────────────────────────────────────
  // Private Helpers: shared
  // ──────────────────────────────────────────────

  /** The command as typed, in its database. */
  private static verbatim(argv: readonly string[], db: number): PropagatedOp[] {
    return [PropagateBaseRules.op(db, [...argv])];
  }

  private static exists(ctx: PropagateContext, key: string): boolean {
    return ctx.database.raw(key) !== undefined;
  }

  // ──────────────────────────────────────────────
  // Private Helpers: strings / keys
  // ──────────────────────────────────────────────

  private static propagateSet(argv: readonly string[], ctx: PropagateContext): PropagatedOp[] {
    const { op, delOp, lc } = PropagateBaseRules;
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
      if (ctx.database.raw(key) === undefined) return [delOp(db, key, Boolean(ctx.lazyfreeLazyExpire))];
      if (expireKind === 'pxat') return [op(db, [...argv])];
      // setGenericCommand: replaceClientCommandVector(c, 5, SET, key, val, PXAT, ms) — NX/XX/GET are dropped.
      const at = ctx.database.getExpireRaw(key);
      return [op(db, at === undefined ? ['SET', key, value] : ['SET', key, value, 'PXAT', String(at)])];
    }
    // "Propagate without the GET argument".
    if (getAt >= 0) return [op(db, argv.filter((_, i) => i !== getAt))];
    return [op(db, [...argv])];
  }

  private static propagateGetex(argv: readonly string[], ctx: PropagateContext): PropagatedOp[] {
    const { op, delOp, lc } = PropagateBaseRules;
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
      if (ctx.database.raw(key) === undefined) return [delOp(db, key, Boolean(ctx.lazyfreeLazyExpire))];
      const at = ctx.database.getExpireRaw(key);
      return at === undefined ? [] : [op(db, ['PEXPIREAT', key, String(at)])];
    }
    if (persist) return [op(db, ['PERSIST', key])];
    return [];
  }

  private static propagateRestore(argv: readonly string[], ctx: PropagateContext): PropagatedOp[] {
    const { op, delOp, lc } = PropagateBaseRules;
    const db = ctx.db;
    const key = argv[1];
    // A TTL already in the past: the key is not created; Redis propagates DEL / UNLINK (lazyfree-lazy-server-del).
    if (ctx.database.raw(key) === undefined) return [delOp(db, key, Boolean(ctx.lazyfreeLazyServerDel))];
    const absttl = argv.slice(4).some((a) => lc(a) === 'absttl');
    if (argv[2] === '0' || absttl) return [op(db, [...argv])];
    // restoreCommand: a relative TTL is propagated as an absolute one + ABSTTL.
    const at = ctx.database.getExpireRaw(key);
    if (at === undefined) return [op(db, [...argv])];
    const out = [...argv];
    out[2] = String(at);
    out.push('ABSTTL');
    return [op(db, out)];
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /**
   * Commands Redis propagates even when they did not change the dirty counter (forceCommandPropagation / dirty++ always):
   * FLUSHALL, FLUSHDB, SWAPDB, FUNCTION LOAD/DELETE/FLUSH/RESTORE, and PUBLISH / SPUBLISH (to replicas only).
   */
  static isForcedPropagation(argv: readonly string[]): boolean {
    const name = argv[0].toLowerCase();
    if (name === 'flushall' || name === 'flushdb' || name === 'swapdb' || name === 'publish' || name === 'spublish') return true;
    return name === 'function' && argv.length > 1 && PersistencePropagateService.FUNCTION_WRITES.has(argv[1].toLowerCase());
  }

  /** DEL / UNLINK Redis propagates when a key expires (lazily or by the active cycle), per lazyfree-lazy-expire. */
  static expiredKeyOp(db: number, key: string, lazyfreeLazyExpire: boolean): PropagatedOp {
    return PropagateBaseRules.delOp(db, key, lazyfreeLazyExpire);
  }

  /**
   * How an executed command is propagated: zero or more ops in the command's database. Call it only for a command that
   * changed the dataset (Redis: server.dirty moved) or `isForcedPropagation`; no-op writes must not be propagated at all.
   */
  static propagateOps(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const P = PersistencePropagateService;
    const { op, delOp, items, str, lc } = PropagateBaseRules;
    const name = lc(argv[0]);
    const db = ctx.db;
    if (P.NEVER.has(name)) return [];
    if (reply instanceof RespError) return [];
    const lazyExpire = Boolean(ctx.lazyfreeLazyExpire);

    switch (name) {
      case 'function':
        return argv.length > 1 && P.FUNCTION_WRITES.has(lc(argv[1])) ? P.verbatim(argv, db) : [];
      case 'publish':
      case 'spublish':
        return [op(db, [...argv], 'repl')];

      // ---- strings -----------------------------------------------------------------------------------------------
      case 'set':
        return P.propagateSet(argv, ctx);
      case 'setex':
      case 'psetex': {
        // setGenericCommand rewrites to SET key value PXAT <ms>.
        const key = argv[1];
        const at = ctx.database.getExpireRaw(key);
        if (at === undefined) return P.exists(ctx, key) ? [op(db, ['SET', key, argv[3]])] : [delOp(db, key, lazyExpire)];
        return [op(db, ['SET', key, argv[3], 'PXAT', String(at)])];
      }
      case 'getset':
        // getsetCommand: rewriteClientCommandArgument(c, 0, shared.set).
        return [op(db, ['SET', ...argv.slice(1)])];
      case 'getdel':
        return [op(db, ['DEL', argv[1]])];
      case 'getex':
        return P.propagateGetex(argv, ctx);
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
        if (!P.exists(ctx, key)) return [delOp(db, key, lazyExpire)];
        if (name === 'pexpireat') return P.verbatim(argv, db);
        const at = ctx.database.getExpireRaw(key);
        return [op(db, ['PEXPIREAT', key, at === undefined ? argv[2] : String(at), ...argv.slice(3)])];
      }
      case 'restore':
        return P.propagateRestore(argv, ctx);

      // ---- hashes ------------------------------------------------------------------------------------------------
      case 'hincrbyfloat':
        return [op(db, ['HSET', argv[1], argv[2], str(reply)])];
      case 'hexpire':
      case 'hpexpire':
      case 'hexpireat':
      case 'hpexpireat':
        return PropagateHashRules.hexpire(argv, reply, ctx);
      case 'hgetdel':
        return PropagateHashRules.hgetdel(argv, reply, ctx);
      case 'hgetex':
        return PropagateHashRules.hgetex(argv, reply, ctx);
      case 'hsetex':
        return PropagateHashRules.hsetex(argv, reply, ctx);

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
        if (!P.exists(ctx, key)) return [delOp(db, key, Boolean(ctx.lazyfreeLazyServerDel))];
        const out: PropagatedOp[] = [];
        for (let i = 0; i < members.length; i += P.SPOP_BATCH) out.push(op(db, ['SREM', key, ...members.slice(i, i + P.SPOP_BATCH)]));
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
        return PropagateStreamRules.xadd(argv, reply, ctx);
      case 'xtrim':
        return PropagateStreamRules.xtrim(argv, reply, ctx);
      case 'xreadgroup':
        return PropagateStreamRules.xreadgroup(argv, reply, ctx);
      case 'xclaim':
        return PropagateStreamRules.xclaim(argv, reply, ctx);
      case 'xautoclaim':
        return PropagateStreamRules.xautoclaim(argv, reply, ctx);

      // ---- time series -------------------------------------------------------------------------------------------
      case 'ts.add':
        return PropagateTimeseriesRules.add(argv, reply, ctx);
      case 'ts.madd':
        return PropagateTimeseriesRules.mAdd(argv, reply, ctx);
      case 'ts.incrby':
      case 'ts.decrby':
        return PropagateTimeseriesRules.incrBy(argv, reply, ctx);

      default:
        return P.verbatim(argv, db);
    }
  }

  /** `propagateOps` without the routing: the argv of each op, as written to the AOF / replicas (MULTI/EXEC not included). */
  static propagate(argv: readonly string[], reply: Reply, ctx: PropagateContext): string[][] {
    return PersistencePropagateService.propagateOps(argv, reply, ctx).map((o) => o.argv);
  }
}
