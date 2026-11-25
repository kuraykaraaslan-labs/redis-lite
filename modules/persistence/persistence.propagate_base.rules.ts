import type { Reply } from '@/libs/resp';
import { RespPairs, RespSet } from '@/libs/resp';

import type { PropagationTarget } from './persistence.enums';
import type { PropagatedOp } from './persistence.types';

/**
 * Building blocks of the propagation rules: op construction and reply readers. Shared by the propagate service and the
 * per-type rule files (sub-services never import each other).
 */
export default class PropagateBaseRules {
  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  static lc(s: string): string {
    return s.toLowerCase();
  }

  static op(db: number, argv: string[], target: PropagationTarget = 'all'): PropagatedOp {
    return { db, argv, target };
  }

  /** Items of an array-like reply (array, RESP3 set, pairs flattened to [a, b] pairs). */
  static items(reply: Reply): Reply[] {
    if (Array.isArray(reply)) return reply;
    if (reply instanceof RespSet) return reply.items;
    if (reply instanceof RespPairs) return reply.pairs;
    return [];
  }

  static str(reply: Reply): string {
    if (typeof reply === 'string') return reply;
    if (typeof reply === 'number' || typeof reply === 'bigint') return String(reply);
    return '';
  }

  /** DEL, or UNLINK when the matching lazyfree option is on. */
  static delOp(db: number, key: string, lazy: boolean): PropagatedOp {
    return PropagateBaseRules.op(db, [lazy ? 'UNLINK' : 'DEL', key]);
  }
}
