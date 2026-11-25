import type { RedisValue } from '@/modules/database/database.core';
import { compareIds } from '@/modules/streams/streams.structure';
import type { PendingEntry, Stream, StreamEntry, StreamId } from '@/modules/streams/streams.structure';
import type { ZSet } from '@/modules/zsets/zsets.structure';

import PersistenceBytesCodec, { RdbWriter } from './persistence.bytes.codec';
import { QUICKLIST_CONTAINER, RDB_TYPE } from './persistence.enums';
import PersistenceListpackCodec from './persistence.listpack.codec';
import PersistenceRdbIoCodec from './persistence.rdb_io.codec';
import type { EncodedObject, FieldExpires, ListpackEntry, RdbOptions } from './persistence.types';

/** A quicklist node as the RDB writer lays it out. */
type QuicklistNode = { plain: true; value: string } | { plain: false; items: string[]; bytes: number };

/** A stream listpack node being filled by splitStream. */
interface StreamNode {
  master: StreamId;
  masterFields: string[];
  count: number;
  items: ListpackEntry[];
  itemsBytes: number;
}

/**
 * Object encoding: the RDB body of a value and the RDB type Redis would pick for it (listpack / intset / quicklist /
 * hash-with-TTL / stream layouts follow the encoding thresholds in RdbOptions).
 */
export default class PersistenceObjectEncoderCodec {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** isLargeElement / quicklistNodeExceedsLimit for list-max-listpack-size `fill`. */
  private static readonly QL_OPT_LEVEL = [4096, 8192, 16384, 32768, 65536];
  private static readonly QL_SIZE_SAFETY_LIMIT = 8192;
  private static readonly QL_SIZE_ESTIMATE_OVERHEAD = 8;

  // ──────────────────────────────────────────────
  // Private Helpers: lists
  // ──────────────────────────────────────────────

  private static qlSizeLimit(fill: number): number {
    const levels = PersistenceObjectEncoderCodec.QL_OPT_LEVEL;
    return levels[Math.min(-fill - 1, levels.length - 1)];
  }

  private static qlExceedsLimit(fill: number, newSz: number, newCount: number): boolean {
    const E = PersistenceObjectEncoderCodec;
    if (fill < 0) return newSz > E.qlSizeLimit(fill);
    if (newSz > E.QL_SIZE_SAFETY_LIMIT) return true;
    return newCount > (fill === 0 ? 1 : fill);
  }

  private static qlIsLargeElement(fill: number, sz: number): boolean {
    const E = PersistenceObjectEncoderCodec;
    return fill < 0 ? sz > E.qlSizeLimit(fill) : sz > E.QL_SIZE_SAFETY_LIMIT;
  }

  /**
   * Splits a list into quicklist nodes the way Redis does for a list built by RPUSHing one element
   * at a time: listpack encoding until it would exceed the limit, then the listpack becomes the
   * first quicklist node and further elements go to the tail node or a new node.
   */
  private static splitQuicklist(list: readonly string[], fill: number): QuicklistNode[] {
    const E = PersistenceObjectEncoderCodec;
    const lpEntryBytes = PersistenceListpackCodec.entryBytes;
    const LP_HDR_SIZE = PersistenceListpackCodec.LP_HDR_SIZE;
    const nodes: QuicklistNode[] = [];
    let quick = false;
    let tail: { plain: false; items: string[]; bytes: number } = { plain: false, items: [], bytes: LP_HDR_SIZE + 1 };
    for (const el of list) {
      const sz = el.length;
      if (!quick) {
        if (!E.qlExceedsLimit(fill, tail.bytes + sz, tail.items.length + 1)) {
          tail.items.push(el);
          tail.bytes += lpEntryBytes(el);
          continue;
        }
        quick = true;
        if (tail.items.length) nodes.push(tail);
      }
      const last = nodes[nodes.length - 1];
      if (E.qlIsLargeElement(fill, sz)) {
        nodes.push({ plain: true, value: el });
        continue;
      }
      if (last && !last.plain && !E.qlExceedsLimit(fill, last.bytes + sz + E.QL_SIZE_ESTIMATE_OVERHEAD, last.items.length + 1)) {
        last.items.push(el);
        last.bytes += lpEntryBytes(el);
      } else {
        tail = { plain: false, items: [el], bytes: LP_HDR_SIZE + 1 + lpEntryBytes(el) };
        nodes.push(tail);
      }
    }
    if (!quick && tail.items.length) nodes.push(tail);
    return nodes;
  }

  // ──────────────────────────────────────────────
  // Private Helpers: per-type bodies
  // ──────────────────────────────────────────────

  private static encodeList(w: RdbWriter, list: readonly string[], o: RdbOptions): number {
    const io = PersistenceRdbIoCodec;
    const nodes = PersistenceObjectEncoderCodec.splitQuicklist(list, o.listMaxListpackSize);
    io.writeLen(w, nodes.length);
    for (const n of nodes) {
      if (n.plain) {
        io.writeLen(w, QUICKLIST_CONTAINER.PLAIN);
        io.writeStr(w, n.value, o.rdbCompression);
      } else {
        io.writeLen(w, QUICKLIST_CONTAINER.PACKED);
        io.writeString(w, PersistenceListpackCodec.listpackEncode(n.items), o.rdbCompression);
      }
    }
    return RDB_TYPE.LIST_QUICKLIST_2;
  }

  private static encodeSet(w: RdbWriter, set: ReadonlySet<string>, o: RdbOptions): number {
    const io = PersistenceRdbIoCodec;
    const members = [...set];
    if (members.length <= o.setMaxIntsetEntries) {
      const ints: bigint[] = [];
      for (const m of members) {
        const v = PersistenceBytesCodec.stringToInt64(m);
        if (v === null) break;
        ints.push(v);
      }
      if (ints.length === members.length) {
        io.writeString(w, PersistenceListpackCodec.intsetEncode(ints), o.rdbCompression);
        return RDB_TYPE.SET_INTSET;
      }
    }
    if (members.length <= o.setMaxListpackEntries && members.every((m) => m.length <= o.setMaxListpackValue)) {
      io.writeString(w, PersistenceListpackCodec.listpackEncode(members), o.rdbCompression);
      return RDB_TYPE.SET_LISTPACK;
    }
    io.writeLen(w, members.length);
    for (const m of members) io.writeStr(w, m, o.rdbCompression);
    return RDB_TYPE.SET;
  }

  private static encodeZset(w: RdbWriter, z: ZSet, o: RdbOptions): number {
    const io = PersistenceRdbIoCodec;
    if (z.size <= o.zsetMaxListpackEntries && z.entries.every((e) => e.member.length <= o.zsetMaxListpackValue)) {
      const items: ListpackEntry[] = [];
      for (const e of z.entries) items.push(e.member, io.scoreEntry(e.score));
      io.writeString(w, PersistenceListpackCodec.listpackEncode(items), o.rdbCompression);
      return RDB_TYPE.ZSET_LISTPACK;
    }
    io.writeLen(w, z.size);
    for (let i = z.entries.length - 1; i >= 0; i--) {
      io.writeStr(w, z.entries[i].member, o.rdbCompression);
      w.doubleLe(z.entries[i].score);
    }
    return RDB_TYPE.ZSET_2;
  }

  private static encodeHash(w: RdbWriter, h: ReadonlyMap<string, string>, o: RdbOptions, fieldExpires?: FieldExpires): number {
    const io = PersistenceRdbIoCodec;
    const ttls = new Map<string, number>();
    if (fieldExpires) for (const [f, at] of fieldExpires) if (h.has(f)) ttls.set(f, at);
    let small = h.size <= o.hashMaxListpackEntries;
    if (small) {
      for (const [f, v] of h) {
        if (f.length > o.hashMaxListpackValue || v.length > o.hashMaxListpackValue) {
          small = false;
          break;
        }
      }
    }
    if (ttls.size === 0) {
      if (small) {
        const items: string[] = [];
        for (const [f, v] of h) items.push(f, v);
        io.writeString(w, PersistenceListpackCodec.listpackEncode(items), o.rdbCompression);
        return RDB_TYPE.HASH_LISTPACK;
      }
      io.writeLen(w, h.size);
      for (const [f, v] of h) {
        io.writeStr(w, f, o.rdbCompression);
        io.writeStr(w, v, o.rdbCompression);
      }
      return RDB_TYPE.HASH;
    }
    const minExpire = Math.min(...ttls.values());
    w.u64le(BigInt(minExpire));
    if (small) {
      // listpackEx: (field, value, ttl) triplets ordered by TTL; fields without TTL (0) at the tail.
      const withTtl = [...ttls.entries()].sort((a, b) => a[1] - b[1]);
      const items: ListpackEntry[] = [];
      for (const [f, at] of withTtl) items.push(f, h.get(f)!, BigInt(at));
      for (const [f, v] of h) if (!ttls.has(f)) items.push(f, v, 0n);
      io.writeString(w, PersistenceListpackCodec.listpackEncode(items), o.rdbCompression);
      return RDB_TYPE.HASH_LISTPACK_EX;
    }
    io.writeLen(w, h.size);
    for (const [f, v] of h) {
      const at = ttls.get(f);
      io.writeLen(w, at === undefined ? 0n : BigInt(at) - BigInt(minExpire) + 1n);
      io.writeStr(w, f, o.rdbCompression);
      io.writeStr(w, v, o.rdbCompression);
    }
    return RDB_TYPE.HASH_METADATA;
  }

  // ──────────────────────────────────────────────
  // Private Helpers: streams
  // ──────────────────────────────────────────────

  private static streamNodeEntries(n: StreamNode): ListpackEntry[] {
    return [n.count, 0, n.masterFields.length, ...n.masterFields, 0, ...n.items];
  }

  private static streamNodeBytes(n: StreamNode): number {
    let total = PersistenceListpackCodec.LP_HDR_SIZE + 1 + n.itemsBytes;
    for (const e of [n.count, 0, n.masterFields.length, ...n.masterFields, 0]) total += PersistenceListpackCodec.entryBytes(e);
    return total;
  }

  /** Packs stream entries into listpack nodes the way streamAppendItem does when only appending. */
  private static splitStream(entries: readonly StreamEntry[], o: RdbOptions): StreamNode[] {
    const E = PersistenceObjectEncoderCodec;
    const nodes: StreamNode[] = [];
    let maxBytes = o.streamNodeMaxBytes;
    if (maxBytes <= 0 || maxBytes > 1 << 30) maxBytes = 1 << 30;
    let cur: StreamNode | null = null;
    for (const e of entries) {
      let totelelen = 0;
      for (const f of e.fields) totelelen += f.length;
      if (cur) {
        if (E.streamNodeBytes(cur) + totelelen >= maxBytes) cur = null;
        else if (o.streamNodeMaxEntries > 0 && cur.count >= o.streamNodeMaxEntries) cur = null;
      }
      if (!cur) {
        const masterFields: string[] = [];
        for (let i = 0; i < e.fields.length; i += 2) masterFields.push(e.fields[i]);
        cur = { master: e.id, masterFields, count: 0, items: [], itemsBytes: 0 };
        nodes.push(cur);
      }
      const nf = e.fields.length >> 1;
      const same = nf === cur.masterFields.length && cur.masterFields.every((f, i) => e.fields[2 * i] === f);
      const item: ListpackEntry[] = [same ? 2 : 0, BigInt(e.id.ms) - BigInt(cur.master.ms), BigInt(e.id.seq) - BigInt(cur.master.seq)];
      if (same) {
        for (let i = 0; i < nf; i++) item.push(e.fields[2 * i + 1]);
      } else {
        item.push(nf);
        for (let i = 0; i < nf * 2; i++) item.push(e.fields[i]);
      }
      item.push(nf + 3 + (same ? 0 : nf + 1));
      for (const x of item) cur.itemsBytes += PersistenceListpackCodec.entryBytes(x);
      cur.items.push(...item);
      cur.count++;
    }
    return nodes;
  }

  private static byName<T extends { name: string }>(a: T, b: T): number {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }

  private static sortedPending(m: ReadonlyMap<string, PendingEntry>): PendingEntry[] {
    return [...m.values()].sort((a, b) => compareIds(a.id, b.id));
  }

  private static encodeStream(w: RdbWriter, s: Stream, o: RdbOptions): number {
    const E = PersistenceObjectEncoderCodec;
    const io = PersistenceRdbIoCodec;
    const nodes = E.splitStream(s.entries, o);
    io.writeLen(w, nodes.length);
    for (const n of nodes) {
      io.writeString(w, E.encodeStreamId(n.master), o.rdbCompression);
      io.writeString(w, PersistenceListpackCodec.listpackEncode(E.streamNodeEntries(n)), o.rdbCompression);
    }
    io.writeLen(w, s.entries.length);
    io.writeLen(w, BigInt(s.lastId.ms));
    io.writeLen(w, BigInt(s.lastId.seq));
    const first = s.entries[0]?.id ?? { ms: 0n, seq: 0n };
    io.writeLen(w, BigInt(first.ms));
    io.writeLen(w, BigInt(first.seq));
    io.writeLen(w, BigInt(s.maxDeletedId.ms));
    io.writeLen(w, BigInt(s.maxDeletedId.seq));
    io.writeLen(w, BigInt(s.entriesAdded));
    const groups = [...s.groups.values()].sort(E.byName);
    io.writeLen(w, groups.length);
    for (const g of groups) {
      io.writeStr(w, g.name, o.rdbCompression);
      io.writeLen(w, BigInt(g.lastId.ms));
      io.writeLen(w, BigInt(g.lastId.seq));
      io.writeLen(w, g.entriesRead === null ? -1n : BigInt(g.entriesRead));
      const pel = E.sortedPending(g.pending);
      io.writeLen(w, pel.length);
      for (const p of pel) {
        w.bytes(E.encodeStreamId(p.id));
        w.u64le(BigInt(p.deliveryTime));
        io.writeLen(w, p.deliveryCount);
      }
      const consumers = [...g.consumers.values()].sort(E.byName);
      io.writeLen(w, consumers.length);
      for (const c of consumers) {
        io.writeStr(w, c.name, o.rdbCompression);
        w.u64le(BigInt(c.seenTime));
        w.u64le(BigInt(c.activeTime));
        const cpel = E.sortedPending(c.pending);
        io.writeLen(w, cpel.length);
        for (const p of cpel) w.bytes(E.encodeStreamId(p.id));
      }
    }
    return RDB_TYPE.STREAM_LISTPACKS_3;
  }

  private static writeObject(w: RdbWriter, value: RedisValue, o: RdbOptions, fieldExpires?: FieldExpires): number {
    const E = PersistenceObjectEncoderCodec;
    switch (value.type) {
      case 'string':
        PersistenceRdbIoCodec.writeStr(w, value.value, o.rdbCompression);
        return RDB_TYPE.STRING;
      case 'list':
        return E.encodeList(w, value.value, o);
      case 'set':
        return E.encodeSet(w, value.value, o);
      case 'zset':
        return E.encodeZset(w, value.value, o);
      case 'hash':
        return E.encodeHash(w, value.value, o, fieldExpires);
      case 'stream':
        return E.encodeStream(w, value.value, o);
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** A stream ID as the 16-byte big-endian rax key Redis stores. */
  static encodeStreamId(id: StreamId): Buffer {
    const b = Buffer.alloc(16);
    b.writeBigUInt64BE(BigInt(id.ms), 0);
    b.writeBigUInt64BE(BigInt(id.seq), 8);
    return b;
  }

  /** Serializes a value's object body (no type byte) and returns the RDB type Redis would pick. */
  static encodeObject(value: RedisValue, opts?: Partial<RdbOptions>, fieldExpires?: FieldExpires): EncodedObject {
    const w = new RdbWriter();
    const type = PersistenceObjectEncoderCodec.writeObject(w, value, PersistenceRdbIoCodec.resolveOptions(opts), fieldExpires);
    return { type, body: w.toBuffer() };
  }
}
