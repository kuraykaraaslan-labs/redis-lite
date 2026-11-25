import { listpackSize } from '@/modules/database/database.encoding';

/** A stream ID: both parts are unsigned 64-bit integers. */
export interface StreamId {
  ms: bigint;
  seq: bigint;
}

export interface StreamEntry {
  id: StreamId;
  fields: string[];
}

export interface PendingEntry {
  id: StreamId;
  consumer: string;
  deliveryTime: number;
  deliveryCount: number;
}

export interface Consumer {
  name: string;
  seenTime: number;
  activeTime: number;
  pending: Map<string, PendingEntry>;
}

export interface ConsumerGroup {
  name: string;
  lastId: StreamId;
  entriesRead: number | null;
  pending: Map<string, PendingEntry>;
  consumers: Map<string, Consumer>;
}

/** One radix-tree node of a Redis stream: a listpack holding up to stream-node-max-entries entries. */
export interface StreamNode {
  masterId: StreamId;
  masterFields: string[];
  /** Entries ever appended to this node (valid + deleted), as Redis counts them. */
  total: number;
  /** Entries not deleted. */
  live: number;
  /** Bytes of the entries part of the listpack (the master entry is computed from the live counters). */
  entryBytes: number;
  lastId: StreamId;
}

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
    return listpackSize(master) - 1 + node.entryBytes;
  }

  /** Listpack bytes of one entry inside `node`: flags, ms/seq deltas, [field count + fields] or values only, lp-count. */
  private static entryBytes(node: StreamNode, e: StreamEntry): number {
    const fields = e.fields.filter((_, i) => i % 2 === 0);
    const sameFields = fields.length === node.masterFields.length && fields.every((f, i) => f === node.masterFields[i]);
    const parts = [sameFields ? '2' : '0', lpInt(e.id.ms - node.masterId.ms), lpInt(e.id.seq - node.masterId.seq)];
    if (sameFields) parts.push(...e.fields.filter((_, i) => i % 2 === 1), lpInt(fields.length + 3));
    else parts.push(lpInt(fields.length), ...e.fields, lpInt(fields.length * 2 + 4));
    return listpackSize(parts) - 7;
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
  trimNodes(strategy: 'maxlen' | 'minid', maxlen: number, minid: StreamId, approx: boolean, limit: number): number {
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
