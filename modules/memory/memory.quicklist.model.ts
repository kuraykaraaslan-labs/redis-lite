import PersistenceService from '@/modules/persistence/persistence.service';

import type { QuicklistNodeInfo } from './memory.types';

/**
 * Quicklist node layout of a list built by appending one element at a time (the same rule as the RDB writer): one
 * listpack until list-max-listpack-size is exceeded, which becomes the first node, then tail-node appends.
 */
export default class MemoryQuicklistModel {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  private static readonly QL_OPT_LEVEL = [4096, 8192, 16384, 32768, 65536];
  private static readonly QL_SIZE_SAFETY_LIMIT = 8192;
  private static readonly QL_SIZE_ESTIMATE_OVERHEAD = 8;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static qlSizeLimit(fill: number): number {
    const levels = MemoryQuicklistModel.QL_OPT_LEVEL;
    return levels[Math.min(-fill - 1, levels.length - 1)];
  }

  private static qlExceedsLimit(fill: number, newSz: number, newCount: number): boolean {
    const Q = MemoryQuicklistModel;
    if (fill < 0) return newSz > Q.qlSizeLimit(fill);
    if (newSz > Q.QL_SIZE_SAFETY_LIMIT) return true;
    return newCount > (fill === 0 ? 1 : fill);
  }

  private static qlIsLargeElement(fill: number, sz: number): boolean {
    const Q = MemoryQuicklistModel;
    return fill < 0 ? sz > Q.qlSizeLimit(fill) : sz > Q.QL_SIZE_SAFETY_LIMIT;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  static quicklistNodes(list: Iterable<string>, fill: number): QuicklistNodeInfo[] {
    const Q = MemoryQuicklistModel;
    const nodes: QuicklistNodeInfo[] = [];
    const lpEntry = (s: string): number => PersistenceService.listpackBytes([s]) - 7;
    let quick = false;
    let tail: QuicklistNodeInfo = { plain: false, count: 0, bytes: 7 };
    for (const el of list) {
      const sz = el.length;
      if (!quick) {
        if (!Q.qlExceedsLimit(fill, tail.bytes + sz, tail.count + 1)) {
          tail.count++;
          tail.bytes += lpEntry(el);
          continue;
        }
        quick = true;
        if (tail.count) nodes.push(tail);
      }
      if (Q.qlIsLargeElement(fill, sz)) {
        nodes.push({ plain: true, count: 1, bytes: sz });
        continue;
      }
      const last = nodes[nodes.length - 1];
      if (last && !last.plain && !Q.qlExceedsLimit(fill, last.bytes + sz + Q.QL_SIZE_ESTIMATE_OVERHEAD, last.count + 1)) {
        last.count++;
        last.bytes += lpEntry(el);
      } else {
        tail = { plain: false, count: 1, bytes: 7 + lpEntry(el) };
        nodes.push(tail);
      }
    }
    if (!quick && tail.count) nodes.push(tail);
    return nodes;
  }
}
