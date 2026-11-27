import DatabaseService from '@/modules/database/database.service';

import { QuicklistLayout } from './lists.quicklist.structure';

// ============================================================================
// ListDeque
// ============================================================================

/**
 * The in-memory value of a Redis list: a growable ring buffer with O(1) push / pop at both ends and O(1) access by
 * index. Its read and write methods follow the `Array` methods of the same name (`length`, `at`, `push`, `unshift`,
 * `pop`, `shift`, `slice`, `splice`, `indexOf`, iteration), so code written against that subset works on both.
 *
 * Capacity is a power of two (index = (head + i) & mask). It doubles when full and halves when a quarter full, so a
 * queue that drained does not keep its peak memory. Freed slots are cleared so popped strings can be collected.
 *
 * It also keeps `listpackBytes`, the size its elements would take as one listpack, up to date on every change, so the
 * listpack / quicklist encoding checks after a write cost O(1) instead of a scan of the list, and `layout`, the
 * quicklist nodes Redis 7.0 would split the list into (see QuicklistLayout), for DEBUG OBJECT, MEMORY USAGE and DUMP.
 */
export class ListDeque implements Iterable<string> {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  private static readonly MIN_CAPACITY = 8;

  /** An empty listpack: 6-byte header + 1-byte terminator. */
  private static readonly LISTPACK_EMPTY_BYTES = 7;

  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  private buf: Array<string | undefined>;
  private mask: number;
  private head = 0;
  private size = 0;
  private bytes = ListDeque.LISTPACK_EMPTY_BYTES;

  /** The quicklist nodes of the list (fill and compress depth fixed when the list is created). */
  layout: QuicklistLayout;

  /** Set on a list loaded from a format without nodes: `adopt` lays it out again as if pushed one by one. */
  private pushBuilt = false;

  constructor(capacity = ListDeque.MIN_CAPACITY, fill = -2, compress = 0) {
    let cap = ListDeque.MIN_CAPACITY;
    while (cap < capacity) cap *= 2;
    this.buf = new Array<string | undefined>(cap).fill(undefined);
    this.mask = cap - 1;
    this.layout = new QuicklistLayout(fill, compress);
  }

  /** A deque holding `items` in order, laid out as if pushed one by one at the tail. */
  static from(items: Iterable<string>, fill = -2, compress = 0): ListDeque {
    const array = Array.isArray(items) ? (items as string[]) : [...items];
    const d = new ListDeque(array.length, fill, compress);
    for (let i = 0; i < array.length; i++) {
      const entry = DatabaseService.listpackEntrySize(array[i]);
      d.buf[i] = array[i];
      d.bytes += entry;
      d.layout.pushTail({ entry, length: array[i].length });
    }
    d.size = array.length;
    return d;
  }

  /** A list loaded from an RDB format without quicklist nodes (its layout follows the server's fill, see `adopt`). */
  static loaded(items: Iterable<string>): ListDeque {
    const d = ListDeque.from(items);
    d.pushBuilt = true;
    return d;
  }

  /** A deque holding the elements of `nodes`, one quicklist node per non-empty array (a loaded list keeps its nodes). */
  static fromNodes(nodes: readonly (readonly string[])[], fill = -2, compress = 0): ListDeque {
    const d = ListDeque.from(nodes.flat(), fill, compress);
    d.layout = QuicklistLayout.of(
      fill,
      compress,
      nodes.map((n) => ({ count: n.length, bytes: n.reduce((b, x) => b + DatabaseService.listpackEntrySize(x), QuicklistLayout.EMPTY_BYTES) })),
    );
    return d;
  }

  /** A copy with the same elements and the same node layout (COPY duplicates the quicklist). */
  clone(): ListDeque {
    const d = ListDeque.from(this.toArray(), this.layout.fill, this.layout.compress);
    d.layout = this.layout.clone();
    return d;
  }

  /** Re-stamps the list-max-listpack-size and list-compress-depth the list keeps (a loaded list takes the server's). */
  adopt(fill: number, compress: number): void {
    if (!this.pushBuilt) {
      this.layout = QuicklistLayout.of(fill, compress, this.layout.nodes);
      return;
    }
    this.pushBuilt = false;
    this.layout = new QuicklistLayout(fill, compress);
    for (const x of this) this.layout.pushTail({ entry: DatabaseService.listpackEntrySize(x), length: x.length });
  }

  /** The elements of each quicklist node, head to tail. */
  nodeItems(): string[][] {
    const out: string[][] = [];
    let i = 0;
    for (const n of this.layout.nodes) {
      out.push(this.slice(i, i + n.count));
      i += n.count;
    }
    return out;
  }

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Moves the elements into a new buffer of `cap` slots (a power of two ≥ size), head at slot 0. */
  private resize(cap: number): void {
    const next = new Array<string | undefined>(cap).fill(undefined);
    const { buf, mask, head, size } = this;
    for (let i = 0; i < size; i++) next[i] = buf[(head + i) & mask];
    this.buf = next;
    this.mask = cap - 1;
    this.head = 0;
  }

  private grow(): void {
    if (this.size === this.buf.length) this.resize(this.buf.length * 2);
  }

  private shrink(): void {
    const cap = this.buf.length;
    if (cap > ListDeque.MIN_CAPACITY && this.size <= cap >>> 2) this.resize(cap >>> 1);
  }

  /** Array-style start index: negative counts from the end, clamped to [0, size]. */
  private clampIndex(index: number, size: number): number {
    const i = Math.trunc(index) || 0;
    if (i < 0) return Math.max(size + i, 0);
    return Math.min(i, size);
  }

  /** Removes `count` elements at `start` by moving whichever side of the gap is shorter. */
  private removeRange(start: number, count: number): void {
    const { buf, mask, head, size } = this;
    const after = size - start - count;
    if (start < after) {
      // shift the front part right by `count`
      for (let i = start - 1; i >= 0; i--) buf[(head + i + count) & mask] = buf[(head + i) & mask];
      for (let i = 0; i < count; i++) buf[(head + i) & mask] = undefined;
      this.head = (head + count) & mask;
    } else {
      // shift the back part left by `count`
      for (let i = start; i < start + after; i++) buf[(head + i) & mask] = buf[(head + i + count) & mask];
      for (let i = start + after; i < size; i++) buf[(head + i) & mask] = undefined;
    }
    this.size = size - count;
  }

  /** Opens a gap of `count` slots at `start` (capacity must already fit) by moving the shorter side. */
  private openGap(start: number, count: number): void {
    const after = this.size - start;
    if (start < after) {
      this.head = (this.head - count) & this.mask;
      const { buf, mask, head } = this;
      for (let i = 0; i < start; i++) buf[(head + i) & mask] = buf[(head + i + count) & mask];
    } else {
      const { buf, mask, head } = this;
      for (let i = this.size - 1; i >= start; i--) buf[(head + i + count) & mask] = buf[(head + i) & mask];
    }
    this.size += count;
  }

  /** Puts `value` at position `at` in the buffer (the layout is already updated). */
  private place(at: number, value: string, entry: number): void {
    if (this.size + 1 > this.buf.length) this.resize(this.buf.length * 2);
    this.openGap(at, 1);
    this.buf[(this.head + at) & this.mask] = value;
    this.bytes += entry;
  }

  /** Inserts one element at position `at` (an insertion before the element there, or a push at the tail). */
  private insertOne(at: number, value: string): void {
    if (at >= this.size) {
      this.push(value);
      return;
    }
    this.insertAt(at, true, value);
  }

  // ──────────────────────────────────────────────
  // Public Methods: Array-compatible
  // ──────────────────────────────────────────────

  get length(): number {
    return this.size;
  }

  /** Bytes of the elements encoded as one listpack (header, entries, terminator), as Redis sizes it. */
  get listpackBytes(): number {
    return this.bytes;
  }

  /** The element at `index` (negative counts from the end), or undefined when out of range. */
  at(index: number): string | undefined {
    const i = index < 0 ? this.size + index : index;
    if (i < 0 || i >= this.size) return undefined;
    return this.buf[(this.head + i) & this.mask];
  }

  /** Appends at the tail; returns the new length. */
  push(...items: string[]): number {
    for (let j = 0; j < items.length; j++) {
      this.grow();
      const entry = DatabaseService.listpackEntrySize(items[j]);
      this.buf[(this.head + this.size) & this.mask] = items[j];
      this.size++;
      this.bytes += entry;
      this.layout.pushTail({ entry, length: items[j].length });
    }
    return this.size;
  }

  /** Prepends at the head keeping `items` in argument order (like Array#unshift); returns the new length. */
  unshift(...items: string[]): number {
    for (let j = items.length - 1; j >= 0; j--) {
      this.grow();
      this.head = (this.head - 1) & this.mask;
      const entry = DatabaseService.listpackEntrySize(items[j]);
      this.buf[this.head] = items[j];
      this.size++;
      this.bytes += entry;
      this.layout.pushHead({ entry, length: items[j].length });
    }
    return this.size;
  }

  /** Removes and returns the tail element. */
  pop(): string | undefined {
    if (this.size === 0) return undefined;
    this.size--;
    const slot = (this.head + this.size) & this.mask;
    const value = this.buf[slot] as string;
    this.buf[slot] = undefined;
    const entry = DatabaseService.listpackEntrySize(value);
    this.bytes -= entry;
    this.layout.popTail(entry);
    this.shrink();
    return value;
  }

  /** Removes and returns the head element. */
  shift(): string | undefined {
    if (this.size === 0) return undefined;
    const value = this.buf[this.head] as string;
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) & this.mask;
    this.size--;
    const entry = DatabaseService.listpackEntrySize(value);
    this.bytes -= entry;
    this.layout.popHead(entry);
    this.shrink();
    return value;
  }

  /** Copies the elements in [start, end) to an array (Array#slice index rules). */
  slice(start = 0, end = this.size): string[] {
    const s = this.clampIndex(start, this.size);
    const e = this.clampIndex(end, this.size);
    const out: string[] = new Array<string>(Math.max(0, e - s));
    for (let i = s; i < e; i++) out[i - s] = this.buf[(this.head + i) & this.mask] as string;
    return out;
  }

  /**
   * Removes `deleteCount` elements at `start` (all the rest when omitted) and inserts `items` there; returns the removed
   * elements (Array#splice rules, except that an explicit undefined `deleteCount` also means "the rest").
   */
  splice(start: number, deleteCount?: number, ...items: string[]): string[] {
    const s = this.clampIndex(start, this.size);
    const del = deleteCount === undefined ? this.size - s : Math.min(Math.max(Math.trunc(deleteCount) || 0, 0), this.size - s);
    const removed = this.slice(s, s + del);
    const removedEntries = removed.map((x) => DatabaseService.listpackEntrySize(x));
    for (let j = 0; j < removed.length; j++) this.bytes -= removedEntries[j];
    if (del === items.length) {
      for (let j = 0; j < del; j++) {
        const entry = DatabaseService.listpackEntrySize(items[j]);
        this.bytes += entry;
        this.layout.replace(s + j, removedEntries[j], entry);
        this.buf[(this.head + s + j) & this.mask] = items[j];
      }
      return removed;
    }
    if (del > 0) {
      this.layout.removeRange(s, removedEntries);
      this.removeRange(s, del);
    }
    if (items.length) {
      const needed = this.size + items.length;
      if (needed > this.buf.length) {
        let cap = this.buf.length;
        while (cap < needed) cap *= 2;
        this.resize(cap);
      }
      for (let j = 0; j < items.length; j++) this.insertOne(s + j, items[j]);
    } else this.shrink();
    return removed;
  }

  /** The first index of `value` at or after `fromIndex`, or -1. */
  indexOf(value: string, fromIndex = 0): number {
    for (let i = this.clampIndex(fromIndex, this.size); i < this.size; i++) {
      if (this.buf[(this.head + i) & this.mask] === value) return i;
    }
    return -1;
  }

  *[Symbol.iterator](): Iterator<string> {
    for (let i = 0; i < this.size; i++) yield this.buf[(this.head + i) & this.mask] as string;
  }

  // ──────────────────────────────────────────────
  // Public Methods: deque-specific
  // ──────────────────────────────────────────────

  /** Overwrites the element at `index` (0 ≤ index < length). */
  set(index: number, value: string): void {
    if (index < 0 || index >= this.size) throw new RangeError('ListDeque index out of range');
    const slot = (this.head + index) & this.mask;
    const oldEntry = DatabaseService.listpackEntrySize(this.buf[slot] as string);
    const entry = DatabaseService.listpackEntrySize(value);
    this.bytes += entry - oldEntry;
    this.layout.replace(index, oldEntry, entry);
    this.buf[slot] = value;
  }

  /** Inserts `value` before or after the element at `pivot` (0 ≤ pivot < length), as LINSERT does. */
  insertAt(pivot: number, before: boolean, value: string): void {
    if (pivot < 0 || pivot >= this.size) throw new RangeError('ListDeque index out of range');
    const entry = DatabaseService.listpackEntrySize(value);
    this.layout.insert(pivot, before, { entry, length: value.length }, (i) => DatabaseService.listpackEntrySize(this.buf[(this.head + i) & this.mask] as string));
    this.place(before ? pivot : pivot + 1, value, entry);
  }

  /** Removes the elements at the ascending positions `drop` (LREM), node by node. */
  removeIndices(drop: readonly number[]): void {
    if (!drop.length) return;
    const entries = drop.map((i) => DatabaseService.listpackEntrySize(this.buf[(this.head + i) & this.mask] as string));
    this.layout.removeSorted(drop, entries);
    let write = drop[0];
    let next = 0;
    for (let read = drop[0]; read < this.size; read++) {
      if (next < drop.length && drop[next] === read) {
        this.bytes -= entries[next];
        next++;
        continue;
      }
      this.buf[(this.head + write++) & this.mask] = this.buf[(this.head + read) & this.mask];
    }
    for (let i = write; i < this.size; i++) this.buf[(this.head + i) & this.mask] = undefined;
    this.size = write;
    this.shrink();
  }

  /** A copy of the elements as an array. */
  toArray(): string[] {
    return this.slice(0, this.size);
  }
}

export default ListDeque;
