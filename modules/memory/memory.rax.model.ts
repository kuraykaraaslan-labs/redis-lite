import { compareIds } from '@/modules/streams/streams.structure';
import type { StreamId } from '@/modules/streams/streams.types';

import MemoryAllocModel from './memory.alloc.model';
import type { RaxNode } from './memory.types';

/** Structural model of rax.c raxInsert, tracking numnodes / numele exactly for a given insertion order. */
export class RaxShape {
  numnodes = 1;
  numele = 0;
  private head: RaxNode = RaxShape.newNode();

  private static newNode(): RaxNode {
    return { compr: false, key: false, chars: [], children: [] };
  }

  insert(s: Uint8Array): boolean {
    const len = s.length;
    let h = this.head;
    let parent: RaxNode | null = null;
    let pidx = 0;
    let i = 0;
    let j = 0;
    while (h.chars.length && i < len) {
      if (h.compr) {
        for (j = 0; j < h.chars.length && i < len; j++, i++) if (h.chars[j] !== s[i]) break;
        if (j !== h.chars.length) break;
        parent = h;
        pidx = 0;
        h = h.children[0];
      } else {
        const idx = h.chars.indexOf(s[i]);
        if (idx < 0) break;
        i++;
        parent = h;
        pidx = idx;
        h = h.children[idx];
      }
      j = 0;
    }
    const replace = (n: RaxNode): void => {
      if (parent) parent.children[pidx] = n;
      else this.head = n;
    };
    if (i === len && (!h.compr || j === 0)) {
      if (h.key) return false;
      h.key = true;
      this.numele++;
      return true;
    }
    if (h.compr && i === len) {
      // The key ends inside a compressed node: split it into trimmed (key) + postfix.
      const postfix: RaxNode = { compr: h.chars.length - j > 1, key: true, chars: h.chars.slice(j), children: [h.children[0]] };
      replace({ compr: j > 1, key: h.key, chars: h.chars.slice(0, j), children: [postfix] });
      this.numnodes++;
      this.numele++;
      return true;
    }
    if (h.compr) {
      // Mismatch inside a compressed node: [trimmed] -> split (1 char) -> [postfix] -> old child.
      const next = h.children[0];
      const split: RaxNode = { compr: false, key: false, chars: [h.chars[j]], children: [] };
      if (j === 0) {
        split.key = h.key;
        replace(split);
      } else {
        replace({ compr: j > 1, key: h.key, chars: h.chars.slice(0, j), children: [split] });
        this.numnodes++;
      }
      const postLen = h.chars.length - j - 1;
      if (postLen > 0) {
        split.children.push({ compr: postLen > 1, key: false, chars: h.chars.slice(j + 1), children: [next] });
        this.numnodes++;
      } else split.children.push(next);
      h = split;
    }
    while (i < len) {
      const child = RaxShape.newNode();
      if (h.chars.length === 0 && len - i > 1) {
        h.compr = true;
        h.chars = Array.from(s.subarray(i));
        h.children = [child];
        i = len;
      } else {
        let pos = 0;
        while (pos < h.chars.length && h.chars[pos] < s[i]) pos++;
        h.chars.splice(pos, 0, s[i]);
        h.children.splice(pos, 0, child);
        i++;
      }
      this.numnodes++;
      h = child;
    }
    h.key = true;
    this.numele++;
    return true;
  }
}

/** Memory of the stream radix trees (stream index, consumer group and consumer PELs). */
export default class MemoryRaxModel {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static streamIdKey(id: StreamId): Uint8Array {
    const b = Buffer.alloc(16);
    b.writeBigUInt64BE(BigInt(id.ms), 0);
    b.writeBigUInt64BE(BigInt(id.seq), 8);
    return b;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /**
   * streamRadixTreeMemoryUsage for a rax keyed by stream IDs, inserted in ascending order:
   * numele × sizeof(streamID) + numnodes × (sizeof(raxNode) + sizeof(long) × 30). (Redis overwrites, rather than adds
   * to, its initial sizeof(rax) term, so the rax struct itself is not counted.)
   */
  static streamRaxMemory(ids: Iterable<StreamId>): number {
    const S = MemoryAllocModel.SIZES;
    const sorted = [...ids].sort(compareIds);
    const rax = new RaxShape();
    for (const id of sorted) rax.insert(MemoryRaxModel.streamIdKey(id));
    return rax.numele * S.streamID + rax.numnodes * (S.raxNode + S.raxNodeExtra);
  }
}
