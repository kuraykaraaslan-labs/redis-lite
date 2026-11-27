import { expect } from 'vitest';

import { Stream } from '@/modules/streams/streams.structure';
import { ZSet } from '@/modules/zsets/zsets.structure';
import type { RedisValue } from '@/modules/database/database.types';
import type { ConsumerGroup, PendingEntry } from '@/modules/streams/streams.types';

import PersistenceService from '../persistence.service';

const { decodeObject, dumpPayload, encodeObject, restorePayload } = PersistenceService;

/** Fixtures of the RDB / DUMP suites: binary strings, sample values and the encode → decode round trip. */
export const bin = (s: string): Buffer => Buffer.from(s, 'latin1');

export function binaryString(len: number, seed: number): string {
  let x = seed;
  let out = '';
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += String.fromCharCode((x >>> 16) & 0xff);
  }
  return out;
}

export function zsetOf(pairs: Array<[string, number]>): ZSet {
  const z = new ZSet();
  for (const [m, s] of pairs) z.add(m, s);
  return z;
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : 1);

export function plain(v: RedisValue): unknown {
  switch (v.type) {
    case 'zset':
      return { type: 'zset', entries: v.value.entries.map((e) => [e.member, e.score]) };
    case 'set':
      return { type: 'set', members: [...v.value].sort() };
    case 'hash':
      return { type: 'hash', entries: [...v.value].sort((a, b) => (a[0] < b[0] ? -1 : 1)) };
    case 'stream': {
      const s = v.value;
      return {
        entries: s.entries,
        lastId: s.lastId,
        entriesAdded: s.entriesAdded,
        maxDeletedId: s.maxDeletedId,
        groups: [...s.groups.values()].sort(byName).map((g) => ({
          name: g.name,
          lastId: g.lastId,
          entriesRead: g.entriesRead,
          pending: [...g.pending.entries()],
          consumers: [...g.consumers.values()].sort(byName).map((c) => ({ ...c, pending: [...c.pending.keys()] })),
        })),
      };
    }
    default:
      return v;
  }
}

export function roundTrip(v: RedisValue, expectedType: number): void {
  const enc = encodeObject(v);
  expect(enc.type).toBe(expectedType);
  expect(plain(decodeObject(enc.type, enc.body).value)).toEqual(plain(v));
  expect(plain(restorePayload(dumpPayload(v)))).toEqual(plain(v));
}

export function makeStream(n: number, withGroups: boolean): Stream {
  const s = new Stream();
  for (let i = 0; i < n; i++) {
    const id = { ms: BigInt(1700000000000 + Math.floor(i / 3)), seq: BigInt(i % 3) };
    const fields = i % 7 === 0 ? ['other', `v${i}`, 'extra', '42'] : ['name', `user-${i}`, 'n', String(i)];
    s.entries.push({ id, fields });
    s.lastId = id;
  }
  s.entriesAdded = n + 5;
  s.maxDeletedId = { ms: 5n, seq: 1n };
  if (withGroups && n > 2) {
    const g: ConsumerGroup = { name: 'g1', lastId: s.entries[2].id, entriesRead: 3, pending: new Map(), consumers: new Map() };
    const alice = { name: 'alice', seenTime: 1700000000123, activeTime: -1, pending: new Map<string, PendingEntry>() };
    const bob = { name: 'bob', seenTime: 1700000000200, activeTime: -1, pending: new Map<string, PendingEntry>() };
    for (let i = 0; i < 3; i++) {
      const id = s.entries[i].id;
      const owner = i === 1 ? bob : alice;
      const p: PendingEntry = { id, consumer: owner.name, deliveryTime: 1700000000000 + i, deliveryCount: i + 1 };
      const k = `${id.ms}-${id.seq}`;
      g.pending.set(k, p);
      owner.pending.set(k, p);
    }
    g.consumers.set('bob', bob);
    g.consumers.set('alice', alice);
    s.groups.set('g1', g);
    s.groups.set('a-empty', { name: 'a-empty', lastId: { ms: 0n, seq: 0n }, entriesRead: null, pending: new Map(), consumers: new Map() });
  }
  return s;
}
