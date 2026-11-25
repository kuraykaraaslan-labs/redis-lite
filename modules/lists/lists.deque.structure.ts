import DatabaseService from '@/modules/database/database.service';

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
 * listpack / quicklist encoding checks after a write cost O(1) instead of a scan of the list.
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

  constructor(capacity = ListDeque.MIN_CAPACITY) {
    let cap = ListDeque.MIN_CAPACITY;
    while (cap < capacity) cap *= 2;
    this.buf = new Array<string | undefined>(cap).fill(undefined);
    this.mask = cap - 1;
  }

  /** A deque holding `items` in order. */
  static from(items: Iterable<string>): ListDeque {
    const array = Array.isArray(items) ? (items as string[]) : [...items];
    const d = new ListDeque(array.length);
    for (let i = 0; i < array.length; i++) {
      d.buf[i] = array[i];
      d.bytes += DatabaseService.listpackEntrySize(array[i]);
    }
    d.size = array.length;
    return d;
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
      this.buf[(this.head + this.size) & this.mask] = items[j];
      this.size++;
      this.bytes += DatabaseService.listpackEntrySize(items[j]);
    }
    return this.size;
  }

  /** Prepends at the head keeping `items` in argument order (like Array#unshift); returns the new length. */
  unshift(...items: string[]): number {
    for (let j = items.length - 1; j >= 0; j--) {
      this.grow();
      this.head = (this.head - 1) & this.mask;
      this.buf[this.head] = items[j];
      this.size++;
      this.bytes += DatabaseService.listpackEntrySize(items[j]);
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
    this.bytes -= DatabaseService.listpackEntrySize(value);
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
    this.bytes -= DatabaseService.listpackEntrySize(value);
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
    for (let j = 0; j < removed.length; j++) this.bytes -= DatabaseService.listpackEntrySize(removed[j]);
    for (let j = 0; j < items.length; j++) this.bytes += DatabaseService.listpackEntrySize(items[j]);
    if (del === items.length) {
      for (let j = 0; j < del; j++) this.buf[(this.head + s + j) & this.mask] = items[j];
      return removed;
    }
    if (del > 0) this.removeRange(s, del);
    if (items.length) {
      const needed = this.size + items.length;
      if (needed > this.buf.length) {
        let cap = this.buf.length;
        while (cap < needed) cap *= 2;
        this.resize(cap);
      }
      this.openGap(s, items.length);
      for (let j = 0; j < items.length; j++) this.buf[(this.head + s + j) & this.mask] = items[j];
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
    this.bytes += DatabaseService.listpackEntrySize(value) - DatabaseService.listpackEntrySize(this.buf[slot] as string);
    this.buf[slot] = value;
  }

  /** A copy of the elements as an array. */
  toArray(): string[] {
    return this.slice(0, this.size);
  }
}

export default ListDeque;
