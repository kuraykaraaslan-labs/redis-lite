import DatabaseService from '@/modules/database/database.service';
import { compareIds } from '@/modules/streams/streams.structure';
import type { Stream } from '@/modules/streams/streams.structure';
import type { RedisValue } from '@/modules/database/database.types';
import type { ListDeque } from '@/modules/lists/lists.deque.structure';
import type { PendingEntry, StreamEntry, StreamId } from '@/modules/streams/streams.types';

import PersistenceBytesCodec, { RdbWriter } from './persistence.bytes.codec';
import { QUICKLIST_CONTAINER, RDB_TYPE } from './persistence.enums';
import PersistenceListpackCodec from './persistence.listpack.codec';
import PersistenceRdbIoCodec from './persistence.rdb_io.codec';
import type { EncodedObject, ListpackEntry, RdbOptions } from './persistence.types';

/** A stream listpack node being filled by splitStream. */
interface StreamNode {
  master: StreamId;
  masterFields: string[];
  count: number;
  items: ListpackEntry[];
  itemsBytes: number;
}

/**
 * Object encoding: the RDB body of a value and the RDB type Redis 7.0 writes for it (RDB version 10): the value's own
 * encoding when known (intset / hashtable sets, listpack / hashtable hashes, listpack / skiplist sorted sets), else
 * the encoding thresholds in RdbOptions; lists as their quicklist nodes; streams as type 19.
 */
export default class PersistenceObjectEncoderCodec {
  // ──────────────────────────────────────────────
  // Private Helpers: per-type bodies
  // ──────────────────────────────────────────────

  /** A list as its quicklist nodes, each a listpack (Redis 7.0 only writes plain nodes past a 1 GB element). */
  private static encodeList(w: RdbWriter, list: ListDeque, o: RdbOptions): number {
    const io = PersistenceRdbIoCodec;
    const nodes = list.nodeItems();
    io.writeLen(w, nodes.length);
    for (const items of nodes) {
      io.writeLen(w, QUICKLIST_CONTAINER.PACKED);
      io.writeString(w, PersistenceListpackCodec.listpackEncode(items), o.rdbCompression);
    }
    return RDB_TYPE.LIST_QUICKLIST_2;
  }

  /** A set as an intset or a hash table (7.0 has no listpack sets), in the encoding the set already has. */
  private static encodeSet(w: RdbWriter, value: RedisValue & { type: 'set' }, o: RdbOptions): number {
    const io = PersistenceRdbIoCodec;
    const members = [...value.value];
    const known = DatabaseService.knownEncoding(value);
    if (known !== 'hashtable' && (known === 'intset' || members.length <= o.setMaxIntsetEntries)) {
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
    io.writeLen(w, members.length);
    for (const m of members) io.writeStr(w, m, o.rdbCompression);
    return RDB_TYPE.SET;
  }

  private static encodeZset(w: RdbWriter, value: RedisValue & { type: 'zset' }, o: RdbOptions): number {
    const io = PersistenceRdbIoCodec;
    const z = value.value;
    const known = DatabaseService.knownEncoding(value);
    const compact = known !== undefined ? known === 'listpack' : z.size <= o.zsetMaxListpackEntries && z.entries.every((e) => e.member.length <= o.zsetMaxListpackValue);
    if (compact) {
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

  private static encodeHash(w: RdbWriter, value: RedisValue & { type: 'hash' }, o: RdbOptions): number {
    const io = PersistenceRdbIoCodec;
    const h = value.value;
    const known = DatabaseService.knownEncoding(value);
    let small = known !== undefined ? known === 'listpack' : h.size <= o.hashMaxListpackEntries;
    if (small && known === undefined) {
      for (const [f, v] of h) {
        if (f.length > o.hashMaxListpackValue || v.length > o.hashMaxListpackValue) {
          small = false;
          break;
        }
      }
    }
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
        const cpel = E.sortedPending(c.pending);
        io.writeLen(w, cpel.length);
        for (const p of cpel) w.bytes(E.encodeStreamId(p.id));
      }
    }
    return RDB_TYPE.STREAM_LISTPACKS_2;
  }

  private static writeObject(w: RdbWriter, value: RedisValue, o: RdbOptions): number {
    const E = PersistenceObjectEncoderCodec;
    switch (value.type) {
      case 'string':
        PersistenceRdbIoCodec.writeStr(w, value.value, o.rdbCompression);
        return RDB_TYPE.STRING;
      case 'list':
        return E.encodeList(w, value.value, o);
      case 'set':
        return E.encodeSet(w, value, o);
      case 'zset':
        return E.encodeZset(w, value, o);
      case 'hash':
        return E.encodeHash(w, value, o);
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
  static encodeObject(value: RedisValue, opts?: Partial<RdbOptions>): EncodedObject {
    const w = new RdbWriter();
    const type = PersistenceObjectEncoderCodec.writeObject(w, value, PersistenceRdbIoCodec.resolveOptions(opts));
    return { type, body: w.toBuffer() };
  }
}
