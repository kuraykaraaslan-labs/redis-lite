/**
 * Propagation of the time series commands. A `*` timestamp (the server clock) is replaced by the timestamp the command
 * used, taken from its reply, so the AOF and replicas store the same samples: TS.ADD, TS.MADD, and TS.INCRBY /
 * TS.DECRBY (whose TIMESTAMP defaults to the clock). Everything else is propagated as typed.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import type { Reply } from '@/libs/resp';

import PropagateBaseRules from './persistence.propagate_base.rules';
import type { PropagateContext, PropagatedOp } from './persistence.types';

export default class PropagateTimeseriesRules {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Arguments taken by each TS.INCRBY / TS.DECRBY option before LABELS (which takes the rest). */
  private static readonly OPTION_ARGS: Record<string, number> = {
    retention: 1,
    encoding: 1,
    chunk_size: 1,
    duplicate_policy: 1,
    ignore: 2,
    timestamp: 1,
  };

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** TS.ADD key * value … → TS.ADD key <timestamp> value … */
  static add(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const out = [...argv];
    if (out[2] === '*' && typeof reply === 'number') out[2] = String(reply);
    return [PropagateBaseRules.op(ctx.db, out)];
  }

  /** TS.MADD: each `*` gets the timestamp its sample was written at (failed samples keep `*`). */
  static mAdd(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    const out = [...argv];
    const replies = Array.isArray(reply) ? reply : [];
    for (let i = 2, n = 0; i < out.length; i += 3, n++) {
      const r = replies[n];
      if (out[i] === '*' && typeof r === 'number') out[i] = String(r);
    }
    return [PropagateBaseRules.op(ctx.db, out)];
  }

  /** TS.INCRBY / TS.DECRBY: TIMESTAMP <reply> right after the value, replacing a TIMESTAMP option given as typed. */
  static incrBy(argv: readonly string[], reply: Reply, ctx: PropagateContext): PropagatedOp[] {
    if (typeof reply !== 'number') return [PropagateBaseRules.op(ctx.db, [...argv])];
    const rest: string[] = [];
    for (let i = 3; i < argv.length; ) {
      const lower = argv[i].toLowerCase();
      const n = PropagateTimeseriesRules.OPTION_ARGS[lower];
      if (n === undefined) {
        rest.push(...argv.slice(i));
        break;
      }
      if (lower !== 'timestamp') rest.push(...argv.slice(i, i + 1 + n));
      i += 1 + n;
    }
    return [PropagateBaseRules.op(ctx.db, [argv[0], argv[1], argv[2], 'TIMESTAMP', String(reply), ...rest])];
  }
}
