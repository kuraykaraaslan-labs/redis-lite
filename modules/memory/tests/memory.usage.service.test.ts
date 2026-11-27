import { describe, expect, it } from 'vitest';

import { ListDeque } from '@/modules/lists/lists.deque.structure';
import PersistenceService from '@/modules/persistence/persistence.service';
import { Stream } from '@/modules/streams/streams.structure';
import { ZSet } from '@/modules/zsets/zsets.structure';
import type { RedisValue } from '@/modules/database/database.types';

import { RaxShape } from '../memory.rax.model';
import MemoryService from '../memory.service';

const { SIZES, debugQuicklistInfo, intsetBytes, jemallocSize, memoryUsage, objectSize, quicklistNodes, sdsAllocSize, serializedLength, streamRaxMemory } = MemoryService;
const { listpackBytes } = PersistenceService;

const base = { samples: 5, hasExpire: false };
const str = (value: string, raw = false): RedisValue => ({ type: 'string', value, raw });
const range = (n: number, f: (i: number) => string): string[] => Array.from({ length: n }, (_, i) => f(i));

// Expected figures were read from a real Redis 7.0 (MEMORY USAGE through the differential harness).
describe('MEMORY USAGE strings', () => {
  it('int encoding: robj + key sds + dict entry', () => {
    expect(memoryUsage('a', str('1'), 'int', base)).toBe(48);
  });

  it('embstr: robj and value in one allocation', () => {
    expect(memoryUsage('b', str('hello'), 'embstr', base)).toBe(64);
    expect(memoryUsage('longerkeyname_abcdefghijklmnopqrstuvwxyz', str('hello'), 'embstr', base)).toBe(104);
    expect(memoryUsage('b', str('hello'), 'embstr', { samples: 5, hasExpire: true })).toBe(64);
  });

  it('raw: separate sds', () => {
    expect(memoryUsage('c', str('x'.repeat(81)), 'raw', base)).toBe(144);
    const big = memoryUsage('k', str('x'.repeat(100000)), 'raw', base);
    expect(big).toBe(16 + 114688 + 8 + 24);
  });

  it('grows with value and key length', () => {
    let prev = 0;
    for (let n = 45; n < 5000; n += 37) {
      const u = memoryUsage('key', str('v'.repeat(n)), 'raw', base);
      expect(u).toBeGreaterThanOrEqual(prev);
      prev = u;
    }
    expect(memoryUsage('k'.repeat(200), str('v'), 'embstr', base)).toBeGreaterThan(memoryUsage('k', str('v'), 'embstr', base));
  });
});

describe('MEMORY USAGE aggregates', () => {
  const kv = SIZES.robj + sdsAllocSize(1);

  it('a small list is a quicklist of one node', () => {
    const v: RedisValue = { type: 'list', value: ListDeque.from(['a', 'b', 'c']) };
    expect(memoryUsage('l', v, 'quicklist', base)).toBe(144);
  });

  it('quicklist list: samples nodes, scales by node count', () => {
    const list = range(5000, (i) => `element-${i}`);
    const deque = ListDeque.from(list);
    const nodes = quicklistNodes(deque);
    expect(nodes.length).toBeGreaterThan(5);
    expect(nodes.reduce((n, q) => n + q.count, 0)).toBe(5000);
    for (const n of nodes) expect(n.bytes).toBeLessThanOrEqual(8192);
    const v: RedisValue = { type: 'list', value: deque };
    const all = objectSize('k', v, 'quicklist', { samples: 0, hasExpire: false });
    const exact = kv + SIZES.quicklist + nodes.reduce((n, q) => n + SIZES.quicklistNode + jemallocSize(q.bytes), 0);
    expect(all).toBe(exact);
    const five = objectSize('k', v, 'quicklist', base);
    const ele = nodes.slice(0, 5).reduce((n, q) => n + SIZES.quicklistNode + jemallocSize(q.bytes), 0);
    expect(five).toBe(Math.floor(kv + SIZES.quicklist + (ele / 5) * nodes.length));
  });

  it('a large element gets a listpack node of its own', () => {
    const deque = ListDeque.from(['a', 'x'.repeat(10000), 'b']);
    const nodes = quicklistNodes(deque);
    expect(nodes.map((n) => n.count)).toEqual([1, 1, 1]);
    expect(nodes[1].bytes).toBe(10000 + 5 + 2 + 7);
    const info = debugQuicklistInfo(deque);
    expect(info.nodes).toBe(3);
    expect(info.listpackMax).toBe(-2);
  });

  it('intset / hashtable sets', () => {
    const ints = new Set(['1', '2', '3']);
    expect(intsetBytes(ints)).toBe(8 + 6);
    expect(intsetBytes(['1', '70000'])).toBe(8 + 8);
    expect(intsetBytes(['1', '5000000000'])).toBe(8 + 16);
    expect(memoryUsage('s', { type: 'set', value: ints }, 'intset', base)).toBe(64);
    expect(memoryUsage('s2', { type: 'set', value: new Set(['a', 'b', 'c']) }, 'hashtable', base)).toBe(232);
    const ht = new Set(range(200, (i) => `member:${i}`));
    const all = objectSize('k', { type: 'set', value: ht }, 'hashtable', { samples: 0, hasExpire: false });
    let want = kv + SIZES.dict + 8 * 256;
    for (const m of ht) want += SIZES.dictEntry + sdsAllocSize(m.length);
    expect(all).toBe(want);
  });

  it('sampling: SAMPLES 5 extrapolates the average of the first 5 elements', () => {
    const members = [...range(5, () => '').map((_, i) => `s${i}`), ...range(195, (i) => `long-member-name-${'z'.repeat(40)}-${i}`)];
    const set = new Set(members);
    const v: RedisValue = { type: 'set', value: set };
    const five = objectSize('k', v, 'hashtable', base);
    const per = SIZES.dictEntry + sdsAllocSize(2);
    expect(five).toBe(kv + SIZES.dict + 8 * 256 + per * 200);
    const all = objectSize('k', v, 'hashtable', { samples: 0, hasExpire: false });
    expect(all).toBeGreaterThan(five);
    const ten = objectSize('k', v, 'hashtable', { samples: 10, hasExpire: false });
    expect(ten).toBeGreaterThan(five);
    expect(ten).toBeLessThan(all);
  });

  it('zsets: listpack and skiplist', () => {
    const z = new ZSet();
    z.add('a', 1);
    z.add('b', 2.5);
    const lp = objectSize('k', { type: 'zset', value: z }, 'listpack', base);
    expect(lp).toBe(kv + jemallocSize(listpackBytes(['a', 1n, 'b', '2.5'])));
    const small = new ZSet();
    small.add('a', 0.1);
    small.add('b', 0.2);
    small.add('c', 3);
    expect(memoryUsage('zl', { type: 'zset', value: small }, 'listpack', base)).toBe(112); // scores stored as %.17g text
    const big = new ZSet();
    for (let i = 0; i < 300; i++) big.add(`m${i}`, i);
    const sl = objectSize('k', { type: 'zset', value: big }, 'skiplist', { samples: 0, hasExpire: false });
    const fixed = kv + SIZES.zset + SIZES.zskiplist + SIZES.dict + 8 * 512 + 640;
    expect(sl).toBeGreaterThan(fixed + 300 * (8 + 24 + 48));
    expect(sl).toBeLessThan(fixed + 300 * (8 + 24 + 64));
  });

  it('hashes: listpack and hashtable', () => {
    const h = new Map([
      ['f1', 'v1'],
      ['f2', '100'],
    ]);
    const lp = objectSize('k', { type: 'hash', value: h }, 'listpack', base);
    expect(lp).toBe(kv + jemallocSize(listpackBytes(['f1', 'v1', 'f2', '100'])));
    const big = new Map(range(300, (i) => `field${i}`).map((f) => [f, `value-${f}`] as [string, string]));
    const ht = objectSize('k', { type: 'hash', value: big }, 'hashtable', { samples: 0, hasExpire: false });
    expect(ht).toBeGreaterThan(kv + SIZES.dict + 8 * 512 + 300 * SIZES.dictEntry);
  });

  it('compact encodings are smaller than full ones for the same data', () => {
    const h = new Map(range(50, (i) => `f${i}`).map((f) => [f, 'v'] as [string, string]));
    const v: RedisValue = { type: 'hash', value: h };
    expect(objectSize('k', v, 'listpack', base)).toBeLessThan(objectSize('k', v, 'hashtable', base));
    const s = new Set(range(200, (i) => String(i)));
    const sv: RedisValue = { type: 'set', value: s };
    expect(objectSize('k', sv, 'intset', base)).toBeLessThan(objectSize('k', sv, 'hashtable', base));
  });

  it('aggregate sizes grow with element count', () => {
    let prev = 0;
    for (let n = 1; n < 600; n += 13) {
      const set = new Set(range(n, (i) => `m${i}`));
      const u = memoryUsage('k', { type: 'set', value: set }, 'hashtable', { samples: 0, hasExpire: false });
      expect(u).toBeGreaterThanOrEqual(prev);
      prev = u;
    }
  });
});

describe('streams', () => {
  const add = (s: Stream, ms: number, fields: string[]): void =>
    s.append({ id: { ms: BigInt(ms), seq: 0n }, fields }, 100, 4096);

  it('rax shape for stream IDs', () => {
    const rax = new RaxShape();
    const key = (n: number): Uint8Array => {
      const b = Buffer.alloc(16);
      b.writeBigUInt64BE(BigInt(n), 0);
      return b;
    };
    rax.insert(key(1));
    expect([rax.numele, rax.numnodes]).toEqual([1, 2]);
    rax.insert(key(2)); // splits the compressed node at byte 7: trimmed + split + postfix + new child chain
    expect(rax.numele).toBe(2);
    expect(rax.numnodes).toBe(6);
    expect(rax.insert(key(2))).toBe(false);
    expect(streamRaxMemory([])).toBe(SIZES.raxNode + SIZES.raxNodeExtra);
    expect(streamRaxMemory([{ ms: 1n, seq: 0n }])).toBe(16 + 2 * 244);
  });

  it('single node stream uses the preallocated listpack', () => {
    const s = new Stream();
    add(s, 1, ['f', 'v']);
    const kv = SIZES.robj + sdsAllocSize(1);
    expect(objectSize('k', { type: 'stream', value: s }, 'stream', base)).toBe(kv + SIZES.stream + 16 + 2 * 244 + 4096);
    expect(memoryUsage('x', { type: 'stream', value: s }, 'stream', base)).toBe(4728);
  });

  it('multi-node streams sample listpacks and add the tail node', () => {
    const s = new Stream();
    for (let i = 1; i <= 1000; i++) add(s, i, ['field', `value-${i}`]);
    expect(s.nodes.length).toBe(10);
    const u5 = objectSize('k', { type: 'stream', value: s }, 'stream', base);
    const u0 = objectSize('k', { type: 'stream', value: s }, 'stream', { samples: 0, hasExpire: false });
    expect(u0).toBeGreaterThan(SIZES.stream + 10 * 1000);
    expect(Math.abs(u5 - u0)).toBeLessThan(2000);
  });

  it('consumer groups add PEL and consumer overhead', () => {
    const s = new Stream();
    for (let i = 1; i <= 10; i++) add(s, i, ['f', 'v']);
    const before = objectSize('k', { type: 'stream', value: s }, 'stream', base);
    const pending = new Map();
    const id = { ms: 1n, seq: 0n };
    const pe = { id, consumer: 'alice', deliveryTime: 0, deliveryCount: 1 };
    pending.set('1-0', pe);
    s.groups.set('g', {
      name: 'g',
      lastId: id,
      entriesRead: 1,
      pending,
      consumers: new Map([['alice', { name: 'alice', seenTime: 0, activeTime: 0, pending: new Map([['1-0', pe]]) }]]),
    });
    const after = objectSize('k', { type: 'stream', value: s }, 'stream', base);
    const pel = 16 + 2 * 244;
    expect(after - before).toBe(SIZES.streamCG + pel + SIZES.streamNACK + SIZES.streamConsumer + 5 + pel);
  });
});


describe('serializedLength', () => {
  it('is the RDB object body length', () => {
    expect(serializedLength(str('bar'))).toBe(4); // len byte + 3
    expect(serializedLength(str('12345'))).toBe(3); // int16 encoding: 1 + 2
    expect(serializedLength({ type: 'list', value: ListDeque.from(['a', 'b']) })).toBeGreaterThan(0);
  });
});
