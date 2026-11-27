import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import Redis from 'ioredis';

import { RedisLite } from '@/index';

import { HLL_DENSE_SIZE } from '../hyperloglog.encoding';
import { hllPatLen, murmurHash64A } from '../hyperloglog.hash';
import { Hll } from '../hyperloglog.structure';

let server: RedisLite;
let redis: Redis;

beforeAll(async () => {
  server = await RedisLite.start({ port: 0 });
  redis = new Redis(server.url);
});

afterAll(async () => {
  redis.disconnect();
  await server.close();
});

describe('hll internals', () => {
  it('MurmurHash64A (seed 0xadc83b19) matches a C reference build', () => {
    // Values from compiling the canonical MurmurHash64A in C (gcc, x86-64) with the same seed.
    const h = (s: string): string => murmurHash64A(Buffer.from(s, 'latin1'), 0xadc83b19).toString();
    expect(h('a')).toBe('6039968161137406375');
    expect(h('abcdefgh')).toBe('17556823505701520743');
    expect(h('abcdefghijklmnopq')).toBe('9758969025913573551');
    expect(h('')).toBe('15627466953755236146');
    expect(hllPatLen(Buffer.from('a'))).toEqual({ index: 12711, count: 2 });
  });

  it('registers round-trip between sparse and dense', () => {
    const sparse = Hll.create();
    for (let i = 0; i < 300; i++) sparse.add(Buffer.from(`el:${i}`), 3000);
    expect(sparse.encoding).toBe(1);
    const before = sparse.registers();
    const dense = new Hll(sparse.bytes.slice());
    expect(dense.toDense()).toBe(true);
    expect(dense.bytes.length).toBe(HLL_DENSE_SIZE);
    expect(dense.registers()).toEqual(before);
    expect(dense.count()).toBe(sparse.count());
    // Rebuild a sparse HLL from the dense registers.
    const rebuilt = Hll.create();
    before.forEach((v, i) => {
      if (v) rebuilt.set(i, v, 3000);
    });
    expect(rebuilt.registers()).toEqual(before);
  });
});

describe('PFADD / PFCOUNT', () => {
  it('small sets count exactly (redis.io examples)', async () => {
    expect(await redis.pfadd('hll', 'a', 'b', 'c', 'd', 'e', 'f', 'g')).toBe(1);
    expect(await redis.pfcount('hll')).toBe(7);

    expect(await redis.pfadd('hll2', 'foo', 'bar', 'zap')).toBe(1);
    expect(await redis.pfadd('hll2', 'zap', 'zap', 'zap')).toBe(0);
    expect(await redis.pfadd('hll2', 'foo', 'bar')).toBe(0);
    expect(await redis.pfcount('hll2')).toBe(3);
    expect(await redis.pfadd('some-other-hll', '1', '2', '3')).toBe(1);
    expect(await redis.pfcount('hll2', 'some-other-hll')).toBe(6);
    expect(await redis.pfcount('nokey')).toBe(0);
  });

  it('fresh key layout: sparse header + XZERO/VAL/XZERO', async () => {
    await redis.pfadd('fresh', 'a');
    const raw = await redis.getBuffer('fresh');
    expect(raw?.subarray(0, 4).toString('latin1')).toBe('HYLL');
    expect(raw?.[4]).toBe(1);
    // XZERO 12711, VAL(2,1), XZERO 3672; cache invalid (byte 15 = 0x80). Derived from this implementation.
    expect(raw?.toString('hex')).toBe('48594c4c01000000000000000000008071a6844e57');
    expect(await redis.call('pfdebug', 'decode', 'fresh')).toBe('Z:12711 v:2,1 Z:3672');
    expect(await redis.pfcount('fresh')).toBe(1);
    const cached = await redis.getBuffer('fresh');
    expect(cached?.subarray(8, 16).toString('hex')).toBe('0100000000000000');
    expect(await redis.object('ENCODING', 'fresh')).toBe('raw');
  });

  it('PFADD with no elements creates an empty HLL', async () => {
    expect(await redis.pfadd('empty')).toBe(1);
    expect(await redis.pfadd('empty')).toBe(0);
    const raw = await redis.getBuffer('empty');
    expect(raw?.toString('hex')).toBe('48594c4c0100000000000000000000807fff');
    expect(await redis.call('pfdebug', 'decode', 'empty')).toBe('Z:16384');
    expect(await redis.pfcount('empty')).toBe(0);
  });

  it('100k elements stay within the standard error and promote to dense', async () => {
    const batch: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      batch.push(`element:${i}`);
      if (batch.length === 10_000) {
        await redis.pfadd('big', ...batch);
        batch.length = 0;
      }
    }
    expect(await redis.call('pfdebug', 'encoding', 'big')).toBe('dense');
    const count = await redis.pfcount('big');
    expect(Math.abs(count - 100_000) / 100_000).toBeLessThan(0.0081 * 3);
    expect((await redis.getBuffer('big'))?.length).toBe(HLL_DENSE_SIZE);
  });

  it('promotes sparse to dense past hll-sparse-max-bytes', async () => {
    let i = 0;
    await redis.pfadd('grow');
    while ((await redis.call('pfdebug', 'encoding', 'grow')) !== 'dense' && i < 5000) {
      expect((await redis.getBuffer('grow'))?.length).toBeLessThanOrEqual(3000);
      await redis.pfadd('grow', `x${i++}`);
    }
    expect(await redis.call('pfdebug', 'encoding', 'grow')).toBe('dense');
    expect(i).toBeGreaterThan(500);
  });

  it('rejects invalid values', async () => {
    await redis.set('str', 'not an hll');
    await expect(redis.pfadd('str', 'x')).rejects.toThrow('WRONGTYPE Key is not a valid HyperLogLog string value.');
    await expect(redis.pfcount('str')).rejects.toThrow('WRONGTYPE Key is not a valid HyperLogLog string value.');
    await redis.lpush('list', 'x');
    await expect(redis.pfadd('list', 'x')).rejects.toThrow('WRONGTYPE Operation against a key');
    // Corrupt a sparse HLL by appending garbage: the register sum no longer matches.
    await redis.pfadd('corrupt', 'a', 'b', 'c');
    await redis.append('corrupt', 'hello');
    await expect(redis.pfcount('corrupt')).rejects.toThrow('INVALIDOBJ Corrupted HLL object detected');
  });
});

describe('PFMERGE / PFDEBUG', () => {
  it('merges (redis.io example) and keeps sparse when possible', async () => {
    await redis.pfadd('m1', 'foo', 'bar', 'zap', 'a');
    await redis.pfadd('m2', 'a', 'b', 'c', 'foo');
    expect(await redis.pfmerge('m3', 'm1', 'm2')).toBe('OK');
    expect(await redis.pfcount('m3')).toBe(6);
    expect(await redis.call('pfdebug', 'encoding', 'm3')).toBe('sparse');
    expect(await redis.pfmerge('m4')).toBe('OK');
    expect(await redis.pfcount('m4')).toBe(0);
  });

  it('dest is dense when a source is dense', async () => {
    await redis.pfadd('d1', 'a', 'b');
    expect(await redis.call('pfdebug', 'todense', 'd1')).toBe(1);
    expect(await redis.call('pfdebug', 'todense', 'd1')).toBe(0);
    await redis.pfadd('d2', 'c');
    await redis.pfmerge('d3', 'd2', 'd1');
    expect(await redis.call('pfdebug', 'encoding', 'd3')).toBe('dense');
    expect(await redis.pfcount('d3')).toBe(3);
  });

  it('GETREG matches registers across encodings', async () => {
    await redis.pfadd('g', 'a', 'b', 'c');
    const regs = (await redis.call('pfdebug', 'getreg', 'g')) as number[];
    expect(regs.length).toBe(16384);
    expect(regs[12711]).toBe(2);
    expect(regs.filter((r) => r > 0).length).toBe(3);
    expect(await redis.call('pfdebug', 'encoding', 'g')).toBe('dense');
    await expect(redis.call('pfdebug', 'decode', 'g')).rejects.toThrow('ERR HLL encoding is not sparse');
    await expect(redis.call('pfdebug', 'getreg', 'missing')).rejects.toThrow('ERR The specified key does not exist');
    await expect(redis.call('pfdebug', 'foo', 'g')).rejects.toThrow("ERR Unknown PFDEBUG subcommand 'foo'");
    // Redis 7.0: PFDEBUG has an exact arity of 3
    await expect(redis.call('pfdebug', 'getreg', 'g', 'x')).rejects.toThrow("ERR wrong number of arguments for 'pfdebug' command");
  });

  it('PFSELFTEST', async () => {
    expect(await redis.call('pfselftest')).toBe('OK');
  }, 300_000);
});
