import { describe, expect, it } from 'vitest';

import { ListDeque } from '@/modules/lists/lists.deque.structure';
import type { RedisValue } from '@/modules/database/database.types';

import MemoryService from '../memory.service';
import type { KeyRecord, MemoryStatValue } from '../memory.types';

const { SIZES, computeMemory, datasetBytes, dbOverhead, infoMemory, memoryStats, memoryUsage, objectSize } = MemoryService;

const str = (value: string, raw = false): RedisValue => ({ type: 'string', value, raw });

describe('MEMORY STATS / INFO memory', () => {
  const records: KeyRecord[] = [
    { key: 'a', value: str('1'), encoding: 'int', hasExpire: false },
    { key: 'b', value: str('hello'), encoding: 'embstr', hasExpire: true },
    { key: 'c', value: { type: 'list', value: ListDeque.from(['x', 'y']) }, encoding: 'listpack', hasExpire: false },
  ];

  it('per-db overhead', () => {
    const o = dbOverhead({ id: 0, keys: records });
    expect(o.keys).toBe(3);
    expect(o.expires).toBe(1);
    // Redis 7.0: entries × (sizeof(dictEntry) + sizeof(robj)) + slots × 8; the expires dict has no robj
    expect(o.main).toBe(3 * SIZES.dictEntry + 4 * 8 + 3 * SIZES.robj);
    expect(o.expiresOverhead).toBe(SIZES.dictEntry + 4 * 8);
    expect(o.dataset).toBe(datasetBytes([{ id: 0, keys: records }]));
    // the dataset is what the allocator holds for the keys: the shared integer '1' allocates no object
    const sum = records.reduce((n, r) => n + objectSize(r.key, r.value, r.encoding, { samples: 0, hasExpire: r.hasExpire, allocated: true, sharedIntegers: true }), 0);
    expect(o.dataset).toBe(sum);
    expect(memoryUsage('a', records[0].value, 'int', { samples: 0, hasExpire: false })).toBe(SIZES.dictEntry + 8 + SIZES.robj);
  });

  it('is internally consistent', () => {
    const r = computeMemory({ databases: [{ id: 0, keys: records }, { id: 1, keys: [] }], clientsNormal: 37632, peak: 0 });
    expect(r.overheadTotal + r.dataset).toBe(r.usedMemory);
    expect(r.keysCount).toBe(3);
    expect(r.dbs.map((d) => d.id)).toEqual([0]);
    expect(r.bytesPerKey).toBe(Math.floor((r.usedMemory - r.startup) / 3));
    expect(r.peak).toBe(r.usedMemory);
    const stats = new Map<string, MemoryStatValue>(memoryStats(r));
    expect(stats.get('total.allocated')).toBe(r.usedMemory);
    expect(stats.get('db.0')).toEqual([
      ['overhead.hashtable.main', r.dbs[0].main],
      ['overhead.hashtable.expires', r.dbs[0].expiresOverhead],
      ['overhead.hashtable.slot-to-keys', 0],
    ]);
    expect(stats.get('peak.percentage')).toEqual({ double: Math.fround(100) });
    const keysOrder = memoryStats(r).map(([k]) => k);
    expect(keysOrder.slice(0, 3)).toEqual(['peak.allocated', 'total.allocated', 'startup.allocated']);
    expect(keysOrder.at(-1)).toBe('fragmentation.bytes');
    const info = new Map(infoMemory(r));
    expect(info.get('used_memory')).toBe(r.usedMemory);
    expect(info.get('used_memory_dataset')).toBe(r.dataset);
    expect(info.get('used_memory_overhead')).toBe(r.overheadTotal);
    expect(info.get('used_memory_peak_perc')).toBe('100.00%');
  });

  it('used memory grows with the dataset', () => {
    const small = computeMemory({ databases: [{ id: 0, keys: records }] });
    const more = [...records, { key: 'd', value: str('x'.repeat(1000)), encoding: 'raw', hasExpire: false }];
    const big = computeMemory({ databases: [{ id: 0, keys: more }], peak: small.usedMemory });
    expect(big.usedMemory).toBeGreaterThan(small.usedMemory + 1000);
    expect(big.dataset).toBeGreaterThan(small.dataset);
  });
});
