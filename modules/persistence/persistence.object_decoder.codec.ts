import { ListDeque } from '@/modules/lists/lists.deque.structure';
import { idToString, Stream } from '@/modules/streams/streams.structure';
import { ZSet } from '@/modules/zsets/zsets.structure';
import type { RedisValue } from '@/modules/database/database.types';
import type { Consumer, ConsumerGroup, StreamId } from '@/modules/streams/streams.types';

import PersistenceBytesCodec, { RdbReader } from './persistence.bytes.codec';
import { QUICKLIST_CONTAINER, RDB_TYPE } from './persistence.enums';
import PersistenceListpackCodec from './persistence.listpack.codec';
import PersistenceMessages from './persistence.messages';
import PersistenceRdbIoCodec from './persistence.rdb_io.codec';
import type { DecodedObject } from './persistence.types';

/**
 * Object decoding: every RDB object type Redis 2.x … 7.0 writes (legacy ziplist / zipmap / intset, quicklists,
 * listpacks, the two stream layouts) back into a RedisValue. Later types (listpack sets, 7.2+ streams, hash field
 * TTLs) are refused as bad data, as 7.0 refuses them.
 */
export default class PersistenceObjectDecoderCodec {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static decodeStreamId(b: Buffer): StreamId {
    if (b.length !== 16) throw PersistenceBytesCodec.badFormat();
    return { ms: b.readBigUInt64BE(0), seq: b.readBigUInt64BE(8) };
  }

  private static pairsToHash(items: readonly string[]): Map<string, string> {
    if (items.length % 2) throw PersistenceBytesCodec.badFormat();
    const h = new Map<string, string>();
    for (let i = 0; i < items.length; i += 2) h.set(items[i], items[i + 1]);
    return h;
  }

  private static pairsToZset(items: Array<string | bigint>): ZSet {
    if (items.length % 2) throw PersistenceBytesCodec.badFormat();
    const z = new ZSet();
    for (let i = 0; i < items.length; i += 2) {
      const sc = items[i + 1];
      z.add(PersistenceListpackCodec.entryToString(items[i]), typeof sc === 'bigint' ? Number(sc) : PersistenceRdbIoCodec.parseScore(sc));
    }
    return z;
  }

  private static readDoubleV1(r: RdbReader): number {
    const len = r.u8();
    if (len === 253) return NaN;
    if (len === 254) return Infinity;
    if (len === 255) return -Infinity;
    return PersistenceRdbIoCodec.parseScore(r.bytes(len).toString('latin1'));
  }

  private static readStream(r: RdbReader, type: number): Stream {
    const D = PersistenceObjectDecoderCodec;
    const io = PersistenceRdbIoCodec;
    const bad = PersistenceBytesCodec.badFormat;
    const entryToString = PersistenceListpackCodec.entryToString;
    const s = new Stream();
    const nodes = io.readLen(r);
    for (let n = 0; n < nodes; n++) {
      const master = D.decodeStreamId(io.readStringBuf(r));
      const items = PersistenceListpackCodec.listpackDecode(io.readStringBuf(r));
      let i = 0;
      const next = (): string | bigint => {
        if (i >= items.length) throw bad();
        return items[i++];
      };
      const nextInt = (): bigint => {
        const v = next();
        if (typeof v !== 'bigint') throw bad();
        return v;
      };
      const count = nextInt();
      const deleted = nextInt();
      const nf = Number(nextInt());
      const masterFields: string[] = [];
      for (let k = 0; k < nf; k++) masterFields.push(entryToString(next()));
      if (nextInt() !== 0n) throw bad();
      const total = Number(count + deleted);
      for (let k = 0; k < total; k++) {
        const flags = Number(nextInt());
        const ms = master.ms + nextInt();
        const seq = master.seq + nextInt();
        const fields: string[] = [];
        if (flags & 2) {
          for (const f of masterFields) fields.push(f, entryToString(next()));
        } else {
          const n2 = Number(nextInt());
          for (let j = 0; j < n2 * 2; j++) fields.push(entryToString(next()));
        }
        nextInt(); // lp-count
        if (!(flags & 1)) s.entries.push({ id: { ms, seq }, fields });
      }
      if (i !== items.length) throw bad();
    }
    const length = io.readLen(r);
    if (length !== s.entries.length) throw bad();
    s.lastId = { ms: io.readLenBig(r), seq: io.readLenBig(r) };
    if (type >= RDB_TYPE.STREAM_LISTPACKS_2) {
      io.readLen(r); // first id ms (derived from entries)
      io.readLen(r); // first id seq
      s.maxDeletedId = { ms: io.readLenBig(r), seq: io.readLenBig(r) };
      s.entriesAdded = io.readLen(r);
    } else {
      s.entriesAdded = s.entries.length;
    }
    const ngroups = io.readLen(r);
    for (let g = 0; g < ngroups; g++) {
      const name = io.readStr(r);
      const lastId = { ms: io.readLenBig(r), seq: io.readLenBig(r) };
      let entriesRead: number | null = null;
      if (type >= RDB_TYPE.STREAM_LISTPACKS_2) {
        const er = io.readLenBig(r);
        entriesRead = er >= 1n << 63n ? null : PersistenceBytesCodec.bigToSafe(er);
      }
      const group: ConsumerGroup = { name, lastId, entriesRead, pending: new Map(), consumers: new Map() };
      const npel = io.readLen(r);
      for (let k = 0; k < npel; k++) {
        const id = D.decodeStreamId(r.bytes(16));
        const deliveryTime = Number(r.i64le());
        const deliveryCount = io.readLen(r);
        group.pending.set(idToString(id), { id, consumer: '', deliveryTime, deliveryCount });
      }
      const nconsumers = io.readLen(r);
      for (let k = 0; k < nconsumers; k++) {
        const cname = io.readStr(r);
        const seenTime = Number(r.i64le());
        const consumer: Consumer = { name: cname, seenTime, activeTime: -1, pending: new Map() };
        const cpel = io.readLen(r);
        for (let j = 0; j < cpel; j++) {
          const key = idToString(D.decodeStreamId(r.bytes(16)));
          const p = group.pending.get(key);
          if (!p) throw bad();
          p.consumer = cname;
          consumer.pending.set(key, p);
        }
        group.consumers.set(cname, consumer);
      }
      s.groups.set(name, group);
    }
    return s;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Reads one object body of RDB type `type` at the reader's position. */
  static readObject(r: RdbReader, type: number): DecodedObject {
    const D = PersistenceObjectDecoderCodec;
    const io = PersistenceRdbIoCodec;
    const lp = PersistenceListpackCodec;
    const bad = PersistenceBytesCodec.badFormat;
    switch (type) {
      case RDB_TYPE.STRING:
        return { value: { type: 'string', value: io.readStr(r) } };
      case RDB_TYPE.LIST: {
        const n = io.readLen(r);
        const list: string[] = [];
        for (let i = 0; i < n; i++) list.push(io.readStr(r));
        return { value: { type: 'list', value: ListDeque.loaded(list) } };
      }
      case RDB_TYPE.LIST_ZIPLIST:
        return { value: { type: 'list', value: ListDeque.loaded(lp.ziplistDecode(io.readStringBuf(r)).map(lp.entryToString)) } };
      case RDB_TYPE.LIST_QUICKLIST:
      case RDB_TYPE.LIST_QUICKLIST_2: {
        const n = io.readLen(r);
        const nodes: string[][] = [];
        for (let i = 0; i < n; i++) {
          if (type === RDB_TYPE.LIST_QUICKLIST) {
            nodes.push(lp.ziplistDecode(io.readStringBuf(r)).map(lp.entryToString));
            continue;
          }
          const container = io.readLen(r);
          const blob = io.readStringBuf(r);
          if (container === QUICKLIST_CONTAINER.PLAIN) nodes.push([blob.toString('latin1')]);
          else if (container === QUICKLIST_CONTAINER.PACKED) nodes.push(lp.listpackStrings(blob));
          else throw bad();
        }
        return { value: { type: 'list', value: ListDeque.fromNodes(nodes) } };
      }
      case RDB_TYPE.SET: {
        const n = io.readLen(r);
        const set = new Set<string>();
        for (let i = 0; i < n; i++) set.add(io.readStr(r));
        return { value: { type: 'set', value: set } };
      }
      case RDB_TYPE.SET_INTSET:
        return { value: { type: 'set', value: new Set(lp.intsetDecode(io.readStringBuf(r)).map((v) => v.toString())) } };
      case RDB_TYPE.ZSET:
      case RDB_TYPE.ZSET_2: {
        const n = io.readLen(r);
        const z = new ZSet();
        for (let i = 0; i < n; i++) {
          const member = io.readStr(r);
          z.add(member, type === RDB_TYPE.ZSET_2 ? r.doubleLe() : D.readDoubleV1(r));
        }
        return { value: { type: 'zset', value: z } };
      }
      case RDB_TYPE.ZSET_ZIPLIST:
        return { value: { type: 'zset', value: D.pairsToZset(lp.ziplistDecode(io.readStringBuf(r))) } };
      case RDB_TYPE.ZSET_LISTPACK:
        return { value: { type: 'zset', value: D.pairsToZset(lp.listpackDecode(io.readStringBuf(r))) } };
      case RDB_TYPE.HASH: {
        const n = io.readLen(r);
        const h = new Map<string, string>();
        for (let i = 0; i < n; i++) {
          const f = io.readStr(r);
          h.set(f, io.readStr(r));
        }
        return { value: { type: 'hash', value: h } };
      }
      case RDB_TYPE.HASH_ZIPMAP:
        return { value: { type: 'hash', value: D.pairsToHash(lp.zipmapDecode(io.readStringBuf(r))) } };
      case RDB_TYPE.HASH_ZIPLIST:
        return { value: { type: 'hash', value: D.pairsToHash(lp.ziplistDecode(io.readStringBuf(r)).map(lp.entryToString)) } };
      case RDB_TYPE.HASH_LISTPACK:
        return { value: { type: 'hash', value: D.pairsToHash(lp.listpackStrings(io.readStringBuf(r))) } };
      case RDB_TYPE.STREAM_LISTPACKS:
      case RDB_TYPE.STREAM_LISTPACKS_2:
        return { value: { type: 'stream', value: D.readStream(r, type) } };
      case RDB_TYPE.MODULE_2:
      case RDB_TYPE.MODULE_PRE_GA:
        throw new Error(PersistenceMessages.MODULE_TYPES_UNSUPPORTED);
      default:
        throw bad();
    }
  }

  /** Whether a decoded aggregate is empty (Redis skips such keys on load and refuses them on RESTORE). */
  static isEmptyAggregate(v: RedisValue): boolean {
    switch (v.type) {
      case 'hash':
      case 'set':
      case 'zset':
        return v.value.size === 0;
      case 'list':
        return v.value.length === 0;
      default:
        return false;
    }
  }

  /** Decodes an object body of the given RDB type. */
  static decodeObject(type: number, body: Buffer): DecodedObject {
    return PersistenceObjectDecoderCodec.readObject(new RdbReader(body), type);
  }
}
