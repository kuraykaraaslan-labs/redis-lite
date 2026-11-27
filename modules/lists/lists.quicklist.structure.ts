// Written from the Redis documentation and observable behaviour; no Redis source code was consulted.

// ============================================================================
// QuicklistLayout
// ============================================================================

/** One quicklist node: how many elements it holds and the bytes of its listpack (header, entries, terminator). */
export interface QuicklistNode {
  count: number;
  bytes: number;
  /** Memory accounting's cache of the node's compressed size, valid while `count:bytes` equals `key`. */
  lz?: { key: string; size: number | undefined };
}

/** What the layout needs to know about one element: its listpack entry size and its string length. */
export interface QuicklistElement {
  entry: number;
  length: number;
}

/**
 * The node layout of a Redis 7.0 list (every list is a quicklist of listpack nodes there): how many elements each node
 * holds and how many bytes its listpack takes. The elements themselves live in the ListDeque; this mirrors only where
 * the node boundaries are, so DEBUG OBJECT, MEMORY USAGE and DUMP see the nodes a real server would have.
 *
 * The rules, as observed on Redis 7.0:
 * - a node takes one more element while `bytes + length + 8` stays within the limit (list-max-listpack-size < 0:
 *   4 KB … 64 KB) or, for a count limit, while it holds fewer than `fill` elements and `bytes + length + 8` ≤ 8 KB;
 * - pushes go to the end node or a new node; pops and deletions shrink nodes and drop empty ones (no merging);
 * - an insertion inside a node with no room splits it: the new element joins the new part (the left part when
 *   inserting before the pivot, the right part when inserting after it), then neighbouring nodes merge while their
 *   combined size minus 11 stays within the limit.
 * Each list keeps the fill it was created with (CONFIG SET only affects new lists).
 */
export class QuicklistLayout {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** list-max-listpack-size -1 … -5. */
  private static readonly SIZE_LEVELS = [4096, 8192, 16384, 32768, 65536];

  /** Byte ceiling of a node under a count limit. */
  private static readonly SIZE_SAFETY_LIMIT = 8192;

  /** Per-insert size estimate overhead. */
  private static readonly SIZE_ESTIMATE_OVERHEAD = 8;

  /** Bytes a merge saves by its estimate (one header and terminator). */
  private static readonly MERGE_SAVING = 11;

  /** An empty listpack: 6-byte header + 1-byte terminator. */
  static readonly EMPTY_BYTES = 7;

  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  /** Nodes from head to tail. */
  nodes: QuicklistNode[] = [];

  constructor(
    /** list-max-listpack-size when the list was created. */
    readonly fill: number,
    /** list-compress-depth when the list was created. */
    readonly compress: number,
  ) {}

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private sizeLimit(): number {
    const levels = QuicklistLayout.SIZE_LEVELS;
    return this.fill < 0 ? levels[Math.min(-this.fill - 1, levels.length - 1)] : QuicklistLayout.SIZE_SAFETY_LIMIT;
  }

  private allowInsert(node: QuicklistNode, length: number): boolean {
    if (node.bytes + length + QuicklistLayout.SIZE_ESTIMATE_OVERHEAD > this.sizeLimit()) return false;
    return this.fill < 0 || node.count < this.fill;
  }

  private allowMerge(a: QuicklistNode, b: QuicklistNode): boolean {
    if (a.bytes + b.bytes - QuicklistLayout.MERGE_SAVING > this.sizeLimit()) return false;
    return this.fill < 0 || a.count + b.count <= this.fill;
  }

  private static node(e: QuicklistElement): QuicklistNode {
    return { count: 1, bytes: QuicklistLayout.EMPTY_BYTES + e.entry };
  }

  /** Merges node i+1 into node i when allowed; returns whether it did. */
  private mergeAt(i: number): boolean {
    const a = this.nodes[i];
    const b = this.nodes[i + 1];
    if (!a || !b || !this.allowMerge(a, b)) return false;
    a.count += b.count;
    a.bytes += b.bytes - QuicklistLayout.EMPTY_BYTES;
    this.nodes.splice(i + 1, 1);
    return true;
  }

  /** The node holding element `index` and the element's offset in it. */
  private locate(index: number): { node: number; offset: number } {
    let i = index;
    for (let n = 0; n < this.nodes.length; n++) {
      if (i < this.nodes[n].count) return { node: n, offset: i };
      i -= this.nodes[n].count;
    }
    return { node: this.nodes.length - 1, offset: this.nodes[this.nodes.length - 1]?.count ?? 0 };
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** A layout with the given nodes (empty ones are dropped, as loading a list does). */
  static of(fill: number, compress: number, nodes: readonly QuicklistNode[]): QuicklistLayout {
    const q = new QuicklistLayout(fill, compress);
    q.nodes = nodes.filter((n) => n.count > 0).map((n) => ({ count: n.count, bytes: n.bytes }));
    return q;
  }

  clone(): QuicklistLayout {
    return QuicklistLayout.of(this.fill, this.compress, this.nodes);
  }

  pushTail(e: QuicklistElement): void {
    const tail = this.nodes[this.nodes.length - 1];
    if (tail && this.allowInsert(tail, e.length)) {
      tail.count++;
      tail.bytes += e.entry;
    } else this.nodes.push(QuicklistLayout.node(e));
  }

  pushHead(e: QuicklistElement): void {
    const head = this.nodes[0];
    if (head && this.allowInsert(head, e.length)) {
      head.count++;
      head.bytes += e.entry;
    } else this.nodes.unshift(QuicklistLayout.node(e));
  }

  /** Removes the head element (its listpack entry is `entry` bytes). */
  popHead(entry: number): void {
    const n = this.nodes[0];
    if (!n) return;
    n.count--;
    n.bytes -= entry;
    if (n.count === 0) this.nodes.shift();
  }

  /** Removes the tail element (its listpack entry is `entry` bytes). */
  popTail(entry: number): void {
    const n = this.nodes[this.nodes.length - 1];
    if (!n) return;
    n.count--;
    n.bytes -= entry;
    if (n.count === 0) this.nodes.pop();
  }

  /** Removes the elements at the ascending positions `drop` (listpack entries `entries`) in one pass. */
  removeSorted(drop: readonly number[], entries: readonly number[]): void {
    const kept: QuicklistNode[] = [];
    let start = 0;
    let k = 0;
    for (const n of this.nodes) {
      const end = start + n.count;
      while (k < drop.length && drop[k] < end) {
        n.count--;
        n.bytes -= entries[k++];
      }
      start = end;
      if (n.count > 0) kept.push(n);
    }
    this.nodes = kept;
  }

  /** Removes `entries.length` consecutive elements starting at `index`. */
  removeRange(index: number, entries: readonly number[]): void {
    if (!entries.length) return;
    let { node, offset } = this.locate(index);
    let k = 0;
    while (k < entries.length && node < this.nodes.length) {
      const n = this.nodes[node];
      const take = Math.min(n.count - offset, entries.length - k);
      for (let j = 0; j < take; j++) n.bytes -= entries[k++];
      n.count -= take;
      if (n.count === 0) this.nodes.splice(node, 1);
      else node++;
      offset = 0;
    }
  }

  /**
   * Inserts a new element next to the element at `pivot` (before or after it), as LINSERT does. `entryAt` gives the
   * listpack entry size of the element at an index (before the insertion), for the sizes of split parts.
   */
  insert(pivot: number, before: boolean, e: QuicklistElement, entryAt: (index: number) => number): void {
    if (!this.nodes.length) {
      this.nodes.push(QuicklistLayout.node(e));
      return;
    }
    const { node, offset } = this.locate(pivot);
    const n = this.nodes[node];
    if (this.allowInsert(n, e.length)) {
      n.count++;
      n.bytes += e.entry;
      return;
    }
    const atTail = !before && offset === n.count - 1;
    const atHead = before && offset === 0;
    if (atTail) {
      const next = this.nodes[node + 1];
      if (next && this.allowInsert(next, e.length)) {
        next.count++;
        next.bytes += e.entry;
      } else this.nodes.splice(node + 1, 0, QuicklistLayout.node(e));
      return;
    }
    if (atHead) {
      const prev = this.nodes[node - 1];
      if (prev && this.allowInsert(prev, e.length)) {
        prev.count++;
        prev.bytes += e.entry;
      } else this.nodes.splice(node, 0, QuicklistLayout.node(e));
      return;
    }
    let leftBytes = QuicklistLayout.EMPTY_BYTES;
    const at = before ? offset : offset + 1;
    const start = pivot - offset;
    for (let i = 0; i < at; i++) leftBytes += entryAt(start + i);
    this.split(node, at, leftBytes, before, e);
  }

  /**
   * Splits node `node` before its element `at` (the left part takes `leftBytes`) and puts the new element in the new
   * part (the left one when inserting before the pivot, the right one otherwise); then the parts merge with their
   * neighbours where allowed: the previous node with the left part, the left part with the right part, the right part
   * with the next node.
   */
  private split(node: number, at: number, leftBytes: number, before: boolean, e: QuicklistElement): void {
    const n = this.nodes[node];
    const left: QuicklistNode = { count: at, bytes: leftBytes };
    const right: QuicklistNode = { count: n.count - at, bytes: n.bytes - leftBytes + QuicklistLayout.EMPTY_BYTES };
    const grown = before ? left : right;
    grown.count++;
    grown.bytes += e.entry;
    this.nodes.splice(node, 1, left, right);
    let l = node;
    if (l > 0 && this.mergeAt(l - 1)) l--;
    if (!this.mergeAt(l)) l++;
    this.mergeAt(l);
  }

  /** Replaces the element at `index`: the node keeps its place, its size changes. */
  replace(index: number, oldEntry: number, newEntry: number): void {
    const { node } = this.locate(index);
    const n = this.nodes[node];
    if (n) n.bytes += newEntry - oldEntry;
  }
}

export default QuicklistLayout;
