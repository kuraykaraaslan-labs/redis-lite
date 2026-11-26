import type { Reply } from '@/libs/resp';

import HashesService from '@/modules/hashes/hashes.service';

import PropagateBaseRules from './persistence.propagate_base.rules';
import type { PropagateContext, PropagatedOp } from './persistence.types';

/** Propagation of the hash field TTL commands (HEXPIRE family, HGETDEL, HGETEX, HSETEX). */
export default class PropagateHashRules {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Position of the FIELDS keyword (and the fields after numfields) in a hash-field-TTL command. */
  private static fieldsOf(argv: readonly string[], from: number): { at: number; fields: string[] } | null {
    for (let i = from; i < argv.length; i++) {
      if (PropagateBaseRules.lc(argv[i]) === 'fields') {
        const n = Number(argv[i + 1]);
        return { at: i, fields: argv.slice(i + 2, i + 2 + n) };
      }
    }
    return null;
  }

  private static fieldExpire(ctx: PropagateContext, key: string, field: string): number | undefined {
    const v = ctx.database.raw(key);
    if (!v || v.type !== 'hash') return undefined;
    return HashesService.hashFieldExpires(v.value)?.get(field);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /**
   * HEXPIRE family: fields whose time was in the past were deleted (reply 2) → HDEL key f…; the command itself becomes
   * HPEXPIREAT key <ms> [cond] FIELDS n <fields not deleted>, and is dropped when no field was updated (reply 1).
   * UNCERTAIN: whether the HDELs are one command or one per field, and their order relative to HPEXPIREAT.
   */
  static hexpire(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const { op, items, lc } = PropagateBaseRules;
    const db = ctx.db;
    const key = argv[1];
    const spec = PropagateHashRules.fieldsOf(argv, 3);
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
      const at = name === 'hpexpireat' ? argv[2] : String(PropagateHashRules.fieldExpire(ctx, key, updatedField) ?? argv[2]);
      out.push(op(db, ['HPEXPIREAT', key, at, ...argv.slice(3, spec.at), 'FIELDS', String(kept.length), ...kept]));
    }
    return out;
  }

  /** HGETDEL → HDEL key <fields that existed>. UNCERTAIN (Redis 8.0 command). */
  static hgetdel(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const spec = PropagateHashRules.fieldsOf(argv, 2);
    if (!spec) return [];
    const values = PropagateBaseRules.items(reply);
    const removed = spec.fields.filter((_, i) => values[i] !== null && values[i] !== undefined);
    return removed.length ? [PropagateBaseRules.op(ctx.db, ['HDEL', argv[1], ...removed])] : [];
  }

  /** HGETEX EX/PX/EXAT/PXAT → HPEXPIREAT (or HDEL when the time is past), PERSIST → HPERSIST. UNCERTAIN (Redis 8.0). */
  static hgetex(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const { op, items, lc } = PropagateBaseRules;
    const db = ctx.db;
    const key = argv[1];
    const spec = PropagateHashRules.fieldsOf(argv, 2);
    if (!spec) return [];
    const mode = lc(argv[2]);
    const values = items(reply);
    const present = spec.fields.filter((_, i) => values[i] !== null && values[i] !== undefined);
    if (!present.length) return [];
    if (mode === 'persist') return [op(db, ['HPERSIST', key, 'FIELDS', String(present.length), ...present])];
    if (mode !== 'ex' && mode !== 'px' && mode !== 'exat' && mode !== 'pxat') return [];
    const at = PropagateHashRules.fieldExpire(ctx, key, present[0]);
    if (at === undefined) return [op(db, ['HDEL', key, ...present])];
    return [op(db, ['HPEXPIREAT', key, String(at), 'FIELDS', String(present.length), ...present])];
  }

  /** HSETEX with EX/PX/EXAT → HSETEX … PXAT <ms> …. UNCERTAIN (Redis 8.0). */
  static hsetex(argv: readonly string[], _reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const { op, lc } = PropagateBaseRules;
    const db = ctx.db;
    const key = argv[1];
    const spec = PropagateHashRules.fieldsOf(argv, 2);
    if (!spec) return [op(db, [...argv])];
    const out = [...argv];
    for (let i = 2; i < spec.at; i++) {
      const o = lc(argv[i]);
      if (o === 'ex' || o === 'px' || o === 'exat') {
        const field = spec.fields[0];
        const at = field === undefined ? undefined : PropagateHashRules.fieldExpire(ctx, key, field);
        if (at === undefined) return [op(db, ['HDEL', key, ...spec.fields.filter((_, j) => j % 2 === 0)])];
        out[i] = 'PXAT';
        out[i + 1] = String(at);
        break;
      }
    }
    return [op(db, out)];
  }
}
