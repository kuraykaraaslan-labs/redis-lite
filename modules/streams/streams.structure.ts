import DatabaseService from '@/modules/database/database.service';

import type { TrimStrategy } from './streams.enums';
import type { Consumer, ConsumerGroup, PendingEntry, StreamEntry, StreamId, StreamNode } from './streams.types';

/**
 * The stream data structure (Redis t_stream.c semantics): ids, the append-only entry log laid out in listpack nodes,
 * and the consumer-group bookkeeping (read counters, lag, pending entries lists) shared by the stream services.
 */

// ============================================================================
// IDs
// ============================================================================

export const U64_MAX = (1n << 64n) - 1n;
export const ZERO_ID: StreamId = { ms: 0n, seq: 0n };
export const MAX_ID: StreamId = { ms: U64_MAX, seq: U64_MAX };

export function compareIds(a: StreamId, b: StreamId): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

export function idToString(id: StreamId): string {
  return `${id.ms}-${id.seq}`;
}

/** Parses an unsigned 64-bit decimal (digits only). Returns null when malformed or out of range. */
export function parseU64(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = BigInt(raw);
  return n > U64_MAX ? null : n;
}

/** Parses `ms-seq` or `ms` (seq defaults to `defaultSeq`). Returns null when malformed. */
export function parseStreamId(raw: string, defaultSeq = 0n): StreamId | null {
  const dash = raw.indexOf('-');
  const ms = parseU64(dash < 0 ? raw : raw.slice(0, dash));
  const seq = dash < 0 ? defaultSeq : parseU64(raw.slice(dash + 1));
  if (ms === null || seq === null) return null;
  return { ms, seq };
}

/** The id right after `id`, or null when `id` is the last possible id (Redis streamIncrID). */
export function nextId(id: StreamId): StreamId | null {
  if (id.seq !== U64_MAX) return { ms: id.ms, seq: id.seq + 1n };
  if (id.ms !== U64_MAX) return { ms: id.ms + 1n, seq: 0n };
  return null;
}

/** The id right before `id`, or null for 0-0 (Redis streamDecrID). */
export function prevId(id: StreamId): StreamId | null {
  if (id.seq > 0n) return { ms: id.ms, seq: id.seq - 1n };
  if (id.ms > 0n) return { ms: id.ms - 1n, seq: U64_MAX };
  return null;
}

// ============================================================================
// Stream
// ============================================================================

function lpInt(n: number | bigint): string {
  return String(n);
}

/** Append-only log with consumer groups. Entries are kept sorted by id (XADD only appends). */
export class Stream {
  entries: StreamEntry[] = [];
  /** Listpack nodes, oldest first. Rebuilt on demand when `entries` was assigned directly (RESTORE). */
  nodes: StreamNode[] = [];
  private readonly nodeOf = new WeakMap<StreamEntry, StreamNode>();
  lastId: StreamId = ZERO_ID;
  entriesAdded = 0;
  maxDeletedId: StreamId = ZERO_ID;
  readonly groups = new Map<string, ConsumerGroup>();

  get length(): number {
    return this.entries.length;
  }

  /** Bytes of a node's listpack: header + master entry (count, deleted, fields, terminator) + entries + end byte. */
  static nodeBytes(node: StreamNode): number {
    const master = [lpInt(node.live), lpInt(node.total - node.live), lpInt(node.masterFields.length), ...node.masterFields, '0'];
    return DatabaseService.listpackSize(master) - 1 + node.entryBytes;
  }

  /** Listpack bytes of one entry inside `node`: flags, ms/seq deltas, [field count + fields] or values only, lp-count. */
  private static entryBytes(node: StreamNode, e: StreamEntry): number {
    const fields = e.fields.filter((_, i) => i % 2 === 0);
    const sameFields = fields.length === node.masterFields.length && fields.every((f, i) => f === node.masterFields[i]);
    const parts = [sameFields ? '2' : '0', lpInt(e.id.ms - node.masterId.ms), lpInt(e.id.seq - node.masterId.seq)];
    if (sameFields) parts.push(...e.fields.filter((_, i) => i % 2 === 1), lpInt(fields.length + 3));
    else parts.push(lpInt(fields.length), ...e.fields, lpInt(fields.length * 2 + 4));
    return DatabaseService.listpackSize(parts) - 7;
  }

  /** Appends an entry, opening a new node when Redis would (entry count or byte limit reached). */
  append(entry: StreamEntry, maxEntries: number, maxBytes: number): void {
    this.ensureNodes(maxEntries, maxBytes);
    this.place(entry, maxEntries, maxBytes);
    this.entries.push(entry);
  }

  private place(entry: StreamEntry, maxEntries: number, maxBytes: number): void {
    const limitBytes = maxBytes === 0 || maxBytes > 1073741824 ? 1073741824 : maxBytes;
    let node: StreamNode | undefined = this.nodes[this.nodes.length - 1];
    const fieldBytes = entry.fields.reduce((n, f) => n + f.length, 0);
    if (node && (Stream.nodeBytes(node) + fieldBytes >= limitBytes || (maxEntries && node.total >= maxEntries))) node = undefined;
    if (!node) {
      node = { masterId: entry.id, masterFields: entry.fields.filter((_, i) => i % 2 === 0), total: 0, live: 0, entryBytes: 0, lastId: entry.id };
      this.nodes.push(node);
    }
    node.entryBytes += Stream.entryBytes(node, entry);
    node.total++;
    node.live++;
    node.lastId = entry.id;
    this.nodeOf.set(entry, node);
  }

  /** After RESTORE the entries exist without nodes: lay them out exactly as consecutive XADDs would. */
  ensureNodes(maxEntries = 100, maxBytes = 4096): void {
    if (this.nodes.length || !this.entries.length) return;
    for (const e of this.entries) this.place(e, maxEntries, maxBytes);
  }

  /** Marks an entry deleted in its node; a node whose entries are all deleted is freed, as in Redis. */
  private release(entry: StreamEntry): void {
    const node = this.nodeOf.get(entry);
    if (!node) return;
    node.live--;
    if (node.live === 0) this.nodes.splice(this.nodes.indexOf(node), 1);
  }

  /**
   * XTRIM / XADD trimming with Redis's node semantics: whole nodes are removed while the stream stays at or above
   * the threshold; with `~` (approx) trimming stops at the first node that cannot be removed whole, otherwise
   * entries of that node are deleted one by one. `limit` caps removed entries (approx only; 0 = none).
   */
  trimNodes(strategy: TrimStrategy, maxlen: number, minid: StreamId, approx: boolean, limit: number): number {
    this.ensureNodes();
    let removed = 0;
    while (this.nodes.length) {
      const node = this.nodes[0];
      if (limit && removed + node.live > limit) break;
      const removeNode = strategy === 'maxlen' ? this.entries.length - node.live >= maxlen : compareIds(node.lastId, minid) < 0;
      if (removeNode) {
        const n = node.live;
        this.entries.splice(0, n);
        this.nodes.shift();
        removed += n;
        continue;
      }
      if (approx) break;
      while (this.entries.length && this.nodeOf.get(this.entries[0]) === node) {
        if (strategy === 'maxlen' ? this.entries.length <= maxlen : compareIds(this.entries[0].id, minid) >= 0) break;
        const e = this.entries.shift() as StreamEntry;
        this.release(e);
        removed++;
      }
      break;
    }
    return removed;
  }

  /** Entries with id strictly greater than `id` (at most `count`). */
  after(id: StreamId, count?: number): StreamEntry[] {
    const out: StreamEntry[] = [];
    let i = this.lowerBound(id);
    if (i < this.entries.length && compareIds(this.entries[i].id, id) === 0) i++;
    for (; i < this.entries.length; i++) {
      out.push(this.entries[i]);
      if (count !== undefined && out.length >= count) break;
    }
    return out;
  }

  /** Index of the first entry with id >= `id`. */
  lowerBound(id: StreamId): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareIds(this.entries[mid].id, id) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  find(id: StreamId): StreamEntry | undefined {
    const i = this.lowerBound(id);
    const e = this.entries[i];
    return e && compareIds(e.id, id) === 0 ? e : undefined;
  }

  range(start: StreamId, end: StreamId, count?: number): StreamEntry[] {
    const out: StreamEntry[] = [];
    for (let i = this.lowerBound(start); i < this.entries.length; i++) {
      const e = this.entries[i];
      if (compareIds(e.id, end) > 0) break;
      out.push(e);
      if (count !== undefined && out.length >= count) break;
    }
    return out;
  }

  delete(id: StreamId): boolean {
    this.ensureNodes();
    const i = this.lowerBound(id);
    const e = this.entries[i];
    if (!e || compareIds(e.id, id) !== 0) return false;
    this.entries.splice(i, 1);
    this.release(e);
    if (compareIds(id, this.maxDeletedId) > 0) this.maxDeletedId = id;
    return true;
  }
}

// ============================================================================
// Entries as replies
// ============================================================================

/** An entry as Redis replies it: `[id, [field, value, …]]`. */
export function entryReply(entry: StreamEntry): [string, string[]] {
  return [idToString(entry.id), entry.fields];
}

/** Orders consumers and groups by name, as Redis's radix trees list them. */
export function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// ============================================================================
// Consumer group read counters and lag (t_stream.c)
// ============================================================================

function firstId(s: Stream): StreamId {
  return s.entries[0]?.id ?? ZERO_ID;
}

/** streamRangeHasTombstones: whether a deleted entry may lie in [start, end]. */
function rangeHasTombstones(s: Stream, start: StreamId, end: StreamId = MAX_ID): boolean {
  if (!s.length || compareIds(s.maxDeletedId, ZERO_ID) === 0) return false;
  if (compareIds(firstId(s), s.maxDeletedId) > 0) return false;
  return compareIds(start, s.maxDeletedId) <= 0 && compareIds(s.maxDeletedId, end) <= 0;
}

/** streamEstimateDistanceFromFirstEverEntry: the logical read counter of `id`, or null when unknown. */
function estimateEntriesRead(s: Stream, id: StreamId): number | null {
  if (!s.entriesAdded) return 0;
  if (!s.length && compareIds(id, s.lastId) < 1) return s.entriesAdded;
  const cmpLast = compareIds(id, s.lastId);
  if (cmpLast === 0) return s.entriesAdded;
  if (cmpLast > 0) return null;
  const cmpFirst = compareIds(id, firstId(s));
  if (compareIds(s.maxDeletedId, ZERO_ID) === 0 || compareIds(s.maxDeletedId, firstId(s)) < 0) {
    if (cmpFirst < 0) return s.entriesAdded - s.length;
    if (cmpFirst === 0) return s.entriesAdded - s.length + 1;
  }
  return null;
}

/** streamReplyWithCGLag: the group's lag, or null when it cannot be computed. */
export function groupLag(s: Stream, g: ConsumerGroup): number | null {
  if (!s.entriesAdded) return 0;
  if (g.entriesRead !== null && !rangeHasTombstones(s, g.lastId)) return s.entriesAdded - g.entriesRead;
  const read = estimateEntriesRead(s, g.lastId);
  return read === null ? null : s.entriesAdded - read;
}

/** Advances the group's last-delivered id to `id`, keeping entries-read as Redis does. */
export function advanceGroup(s: Stream, g: ConsumerGroup, id: StreamId): void {
  if (compareIds(id, g.lastId) <= 0) return;
  if (g.entriesRead !== null && !rangeHasTombstones(s, g.lastId)) g.entriesRead++;
  else if (s.entriesAdded) g.entriesRead = estimateEntriesRead(s, id);
  g.lastId = id;
}

// ============================================================================
// Consumers and pending entries lists
// ============================================================================

/** The group's consumer `name`, created (never seen, never active) when missing. */
export function getOrCreateConsumer(g: ConsumerGroup, name: string): Consumer {
  let c = g.consumers.get(name);
  if (!c) {
    c = { name, seenTime: Date.now(), activeTime: -1, pending: new Map() };
    g.consumers.set(name, c);
  }
  return c;
}

/** Adds (or reassigns) a PEL entry for `e` delivered through `>`. */
export function deliverNew(g: ConsumerGroup, c: Consumer, e: StreamEntry, now: number): void {
  const k = idToString(e.id);
  const prev = g.pending.get(k);
  if (prev) {
    g.consumers.get(prev.consumer)?.pending.delete(k);
    prev.consumer = c.name;
    prev.deliveryTime = now;
    prev.deliveryCount = 1;
    c.pending.set(k, prev);
    return;
  }
  const p: PendingEntry = { id: e.id, consumer: c.name, deliveryTime: now, deliveryCount: 1 };
  g.pending.set(k, p);
  c.pending.set(k, p);
}

/** Removes a pending entry from the group's PEL and its consumer's. */
export function dropPending(g: ConsumerGroup, p: PendingEntry): void {
  const k = idToString(p.id);
  g.pending.delete(k);
  g.consumers.get(p.consumer)?.pending.delete(k);
}

/** Moves a pending entry to `c` (no-op on ownership when it is already c's). */
export function movePending(g: ConsumerGroup, c: Consumer, p: PendingEntry): void {
  const k = idToString(p.id);
  if (p.consumer !== c.name) {
    if (p.consumer) g.consumers.get(p.consumer)?.pending.delete(k);
    p.consumer = c.name;
  }
  c.pending.set(k, p);
}
