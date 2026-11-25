import type { Reply } from '@/libs/resp';
import { RespMap } from '@/libs/resp';

import { idToString, parseStreamId, U64_MAX } from '@/modules/streams/streams.structure';
import type { ConsumerGroup, Stream } from '@/modules/streams/streams.structure';

import PropagateBaseRules from './persistence.propagate_base.rules';
import type { PropagateContext, PropagatedOp } from './persistence.types';

/** Propagation of the stream commands (XADD, XTRIM, XREADGROUP, XCLAIM, XAUTOCLAIM). */
export default class PropagateStreamRules {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  private static readonly MAX_ID_STRING = `${U64_MAX}-${U64_MAX}`;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static streamAt(ctx: PropagateContext, key: string): Stream | undefined {
    const v = ctx.database.peek(key);
    return v && v.type === 'stream' ? v.value : undefined;
  }

  /**
   * Rewrites an approximate trim (`~`) to the exact result, as streamRewriteApproxSpecifier / streamRewriteTrimArgument
   * do: `~` → `=`, threshold → resulting length (MAXLEN) or first entry id (MINID). Redis keeps `LIMIT n`, which only the
   * master/AOF client may send with `=`; we drop it because redis-lite's XADD/XTRIM refuse LIMIT without `~`, and once
   * the threshold is exact the limit no longer matters.
   */
  private static rewriteApproxTrim(out: string[], strategyAt: number, s: Stream | undefined): void {
    const lc = PropagateBaseRules.lc;
    if (out[strategyAt + 1] !== '~') return;
    out[strategyAt + 1] = '=';
    const strategy = lc(out[strategyAt]);
    if (strategy === 'maxlen') out[strategyAt + 2] = String(s?.length ?? 0);
    else out[strategyAt + 2] = s && s.length ? idToString(s.entries[0].id) : PropagateStreamRules.MAX_ID_STRING;
    for (let i = strategyAt + 3; i < out.length - 1; i++) {
      if (lc(out[i]) === 'limit') {
        out.splice(i, 2);
        break;
      }
    }
  }

  /** streamPropagateXCLAIM: XCLAIM key group consumer 0 id TIME ms RETRYCOUNT n FORCE JUSTID LASTID group-last-id. */
  private static xclaimArgv(key: string, group: string, consumer: string, id: string, time: number, count: number, lastId: string): string[] {
    return ['XCLAIM', key, group, consumer, '0', id, 'TIME', String(time), 'RETRYCOUNT', String(count), 'FORCE', 'JUSTID', 'LASTID', lastId];
  }

  /** streamPropagateGroupID: XGROUP SETID key group last-id ENTRIESREAD n. */
  private static setidArgv(key: string, g: ConsumerGroup): string[] {
    return ['XGROUP', 'SETID', key, g.name, idToString(g.lastId), 'ENTRIESREAD', String(g.entriesRead ?? -1)];
  }

  /** Ids of an XCLAIM / XAUTOCLAIM claimed list (JUSTID → strings, otherwise [id, fields] entries). */
  private static claimedIds(list: Reply): string[] {
    const { items, str } = PropagateBaseRules;
    return items(list).map((e) => (typeof e === 'string' ? e : str(items(e)[0] ?? null)));
  }

  /** XCLAIM / XAUTOCLAIM: an XCLAIM … FORCE JUSTID LASTID per claimed entry, with its new delivery time / count. */
  private static claimOps(ctx: PropagateContext, key: string, group: string, consumer: string, ids: readonly string[], deleted: readonly string[]): PropagatedOp[] {
    const S = PropagateStreamRules;
    const op = PropagateBaseRules.op;
    const s = S.streamAt(ctx, key);
    const g = s?.groups.get(group);
    if (!g) return [];
    const lastId = idToString(g.lastId);
    const out: PropagatedOp[] = [];
    for (const id of ids) {
      const p = g.pending.get(id);
      if (p) out.push(op(ctx.db, S.xclaimArgv(key, group, consumer, id, p.deliveryTime, p.deliveryCount, lastId)));
    }
    // Entries deleted from the stream are dropped from the PEL; Redis propagates an XCLAIM for them too (which drops
    // them on the replica). UNCERTAIN: Redis sends the old NACK's time / count; we no longer have them and send 0.
    for (const id of deleted) out.push(op(ctx.db, S.xclaimArgv(key, group, consumer, id, 0, 0, lastId)));
    return out;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  static xadd(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const lc = PropagateBaseRules.lc;
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
    if (strategyAt >= 0) PropagateStreamRules.rewriteApproxTrim(out, strategyAt, PropagateStreamRules.streamAt(ctx, key));
    return [PropagateBaseRules.op(ctx.db, out)];
  }

  static xtrim(argv: readonly string[], _reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const out = [...argv];
    PropagateStreamRules.rewriteApproxTrim(out, 2, PropagateStreamRules.streamAt(ctx, argv[1]));
    return [PropagateBaseRules.op(ctx.db, out)];
  }

  /**
   * XREADGROUP is never propagated itself. For every key read with `>`: an XCLAIM per delivered entry (not with NOACK),
   * then XGROUP SETID because the group's last id moved (Redis calls streamPropagateGroupID unconditionally since #9127).
   * History reads (explicit ids) only bump delivery counters and are not propagated.
   */
  static xreadgroup(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const S = PropagateStreamRules;
    const { op, items, str, lc } = PropagateBaseRules;
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
      const s = S.streamAt(ctx, key);
      const g = s?.groups.get(group);
      if (!g) continue;
      const delivered = items(entries);
      if (!delivered.length) continue;
      if (!noack) {
        for (const e of delivered) {
          const id = str(items(e)[0] ?? null);
          const p = g.pending.get(id);
          out.push(op(db, S.xclaimArgv(key, group, consumer, id, p?.deliveryTime ?? Date.now(), p?.deliveryCount ?? 1, id)));
        }
      }
      out.push(op(db, S.setidArgv(key, g)));
    }
    return out;
  }

  static xclaim(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const S = PropagateStreamRules;
    const lc = PropagateBaseRules.lc;
    const [, key, group, consumer] = argv;
    const requested: string[] = [];
    let i = 5;
    for (; i < argv.length && parseStreamId(argv[i]) !== null; i++) requested.push(argv[i]);
    let lastIdGiven = false;
    for (; i < argv.length; i++) if (lc(argv[i]) === 'lastid') lastIdGiven = true;
    const claimed = S.claimedIds(reply);
    const s = S.streamAt(ctx, key);
    const deleted = requested
      .map((raw) => parseStreamId(raw))
      .filter((id): id is NonNullable<typeof id> => id !== null && s !== undefined && s.find(id) === undefined)
      .map(idToString);
    const out = S.claimOps(ctx, key, group, consumer, claimed, deleted);
    // LASTID given but nothing claimed: the group's last id still moved → XGROUP SETID.
    if (!out.length && lastIdGiven) {
      const g = s?.groups.get(group);
      if (g) out.push(PropagateBaseRules.op(ctx.db, S.setidArgv(key, g)));
    }
    return out;
  }

  static xautoclaim(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const { items, str } = PropagateBaseRules;
    const [, key, group, consumer] = argv;
    const r = items(reply);
    if (r.length < 2) return [];
    return PropagateStreamRules.claimOps(ctx, key, group, consumer, PropagateStreamRules.claimedIds(r[1]), items(r[2] ?? []).map(str));
  }
}
