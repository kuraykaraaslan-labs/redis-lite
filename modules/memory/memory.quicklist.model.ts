// Written from the Redis documentation and observable behaviour; no Redis source code was consulted.

import type { ListDeque } from '@/modules/lists/lists.deque.structure';
import PersistenceService from '@/modules/persistence/persistence.service';

import MemoryAllocModel from './memory.alloc.model';
import type { QuicklistNodeInfo } from './memory.types';

/**
 * Quicklist nodes of a list as memory sees them: the node layout the list keeps (see QuicklistLayout) and, with
 * list-compress-depth > 0, the LZF-compressed interior nodes (every node but `depth` at each end, when compressing
 * saves at least 8 bytes of a listpack of 48 bytes or more).
 */
export default class MemoryQuicklistModel {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Nodes smaller than this are never compressed. */
  private static readonly MIN_COMPRESS_BYTES = 48;

  /** A compressed node must be at least this much smaller than the listpack. */
  private static readonly MIN_COMPRESS_IMPROVE = 8;

  /** quicklistLZF header: the compressed size (unsigned int). */
  private static readonly LZF_HEADER = 4;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Bytes of the compressed form of a listpack, or undefined when Redis keeps it uncompressed. */
  private static compressedBytes(items: readonly string[], bytes: number): number | undefined {
    const Q = MemoryQuicklistModel;
    if (bytes < Q.MIN_COMPRESS_BYTES) return undefined;
    const lz = PersistenceService.lzfCompress(PersistenceService.listpackEncode(items), bytes);
    if (!lz || lz.length + Q.MIN_COMPRESS_IMPROVE >= bytes) return undefined;
    return lz.length;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The first `limit` nodes of a list, head to tail, with what each one's data allocation takes. */
  static quicklistNodes(list: ListDeque, limit = Infinity): QuicklistNodeInfo[] {
    const { nodes, compress } = list.layout;
    const out: QuicklistNodeInfo[] = [];
    let start = 0;
    for (let i = 0; i < nodes.length && i < limit; i++) {
      const n = nodes[i];
      const interior = compress > 0 && i >= compress && i < nodes.length - compress;
      let lz: number | undefined;
      if (interior) {
        const key = `${n.count}:${n.bytes}`;
        if (n.lz?.key !== key) n.lz = { key, size: MemoryQuicklistModel.compressedBytes(list.slice(start, start + n.count), n.bytes) };
        lz = n.lz.size;
      }
      const alloc = MemoryAllocModel.jemallocSize(lz === undefined ? n.bytes : MemoryQuicklistModel.LZF_HEADER + lz);
      out.push({ count: n.count, bytes: n.bytes, alloc, compressed: lz !== undefined });
      start += n.count;
    }
    return out;
  }
}
