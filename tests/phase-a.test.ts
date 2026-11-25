import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import Redis from 'ioredis';

import { RedisLite } from '@/index';

let server: RedisLite;
let redis: Redis;
const call = (...args: Array<string | number>) => redis.call(String(args[0]), ...args.slice(1).map(String));
const enc = (key: string) => call('OBJECT', 'ENCODING', key);

beforeAll(async () => {
  server = await RedisLite.start({ port: 0 });
  redis = new Redis(server.url);
});

afterAll(async () => {
  redis.disconnect();
  await server.close();
});

describe('object encodings follow Redis conversion rules', () => {
  it('strings', async () => {
    await redis.set('s1', '123');
    expect(await enc('s1')).toBe('int');
    await redis.set('s1', 'hello');
    expect(await enc('s1')).toBe('embstr');
    await redis.set('s1', 'x'.repeat(45));
    expect(await enc('s1')).toBe('raw');
    await redis.set('s2', 'ab');
    await redis.append('s2', 'c');
    expect(await enc('s2')).toBe('raw');
    await redis.set('s3', '0123');
    expect(await enc('s3')).toBe('embstr');
  });

  it('hashes are sticky once converted', async () => {
    await redis.hset('h1', 'a', '1');
    expect(await enc('h1')).toBe('listpack');
    for (let i = 0; i < 129; i++) await redis.hset('h1', `f${i}`, 'v');
    expect(await enc('h1')).toBe('hashtable');
    await redis.del('h1');
    await redis.hset('h1', 'a', 'x'.repeat(65));
    expect(await enc('h1')).toBe('hashtable');
    await redis.hdel('h1', 'a');
    await redis.hset('h2', 'a', '1');
    await call('HEXPIRE', 'h2', 100, 'FIELDS', 1, 'a');
    expect(await enc('h2')).toBe('listpackex');
  });

  it('sets go intset → listpack → hashtable', async () => {
    await redis.sadd('st', '1', '2', '3');
    expect(await enc('st')).toBe('intset');
    await redis.sadd('st', 'a');
    expect(await enc('st')).toBe('listpack');
    await redis.sadd('st', ...Array.from({ length: 130 }, (_, i) => `m${i}`));
    expect(await enc('st')).toBe('hashtable');
  });

  it('zsets and lists', async () => {
    await redis.zadd('zs', 1, 'a');
    expect(await enc('zs')).toBe('listpack');
    await redis.zadd('zs', ...Array.from({ length: 130 }, (_, i) => [i, `m${i}`]).flat());
    expect(await enc('zs')).toBe('skiplist');
    await redis.rpush('ls', 'a', 'b');
    expect(await enc('ls')).toBe('listpack');
    await redis.rpush('ls', ...Array.from({ length: 200 }, () => 'x'.repeat(60)));
    expect(await enc('ls')).toBe('quicklist');
    await redis.ltrim('ls', 0, 1);
    expect(await enc('ls')).toBe('listpack');
  });

  it('CONFIG SET thresholds take effect', async () => {
    expect(await call('CONFIG', 'SET', 'hash-max-listpack-entries', 2)).toBe('OK');
    expect(await call('CONFIG', 'GET', 'hash-max-ziplist-entries')).toEqual(['hash-max-ziplist-entries', '2']);
    await redis.hset('h3', 'a', '1', 'b', '2', 'c', '3');
    expect(await enc('h3')).toBe('hashtable');
    await call('CONFIG', 'SET', 'hash-max-listpack-entries', 128);
  });
});

describe('SCAN cursors', () => {
  it('iterates all keys exactly once with real pages', async () => {
    await redis.select(2);
    const keys = Array.from({ length: 500 }, (_, i) => `k:${i}`);
    await redis.mset(...keys.flatMap((k) => [k, '1']));
    const seen: string[] = [];
    let cursor = '0';
    let pages = 0;
    do {
      const [next, batch] = (await redis.scan(cursor, 'COUNT', 20)) as [string, string[]];
      seen.push(...batch);
      cursor = next;
      pages++;
    } while (cursor !== '0');
    expect(pages).toBeGreaterThan(10);
    expect(seen.sort()).toEqual([...keys].sort());
    await redis.select(0);
  });

  it('HSCAN returns compact encodings in one call and paginates hashtables', async () => {
    await redis.hset('small', 'a', '1', 'b', '2');
    expect(await redis.hscan('small', '0', 'COUNT', 1)).toEqual(['0', ['a', '1', 'b', '2']]);
    await redis.hset('big', ...Array.from({ length: 300 }, (_, i) => [`f${i}`, 'v']).flat());
    const [cursor] = (await redis.hscan('big', '0')) as [string, string[]];
    expect(cursor).not.toBe('0');
  });
});

describe('WATCH only fires on real modifications', () => {
  it('no-op writes do not abort the transaction', async () => {
    await redis.sadd('w', 'm');
    const other = redis.duplicate();
    await redis.watch('w', 'missing');
    await other.sadd('w', 'm');
    await other.del('missing');
    await other.srem('w', 'nope');
    expect(await redis.multi().ping().exec()).toEqual([[null, 'PONG']]);
    await redis.watch('w');
    await other.sadd('w', 'new');
    expect(await redis.multi().ping().exec()).toBeNull();
    other.disconnect();
  });
});

describe('LRU / LFU', () => {
  it('OBJECT IDLETIME, FREQ, NO-TOUCH', async () => {
    await redis.set('lru', 'v');
    expect(await call('OBJECT', 'IDLETIME', 'lru')).toBe(0);
    await expect(call('OBJECT', 'FREQ', 'lru')).rejects.toThrow(/LFU maxmemory policy is not selected/);
    await call('CONFIG', 'SET', 'maxmemory-policy', 'allkeys-lfu');
    await redis.set('lfu', 'v');
    expect(await call('OBJECT', 'FREQ', 'lfu')).toBeGreaterThanOrEqual(5);
    await expect(call('OBJECT', 'IDLETIME', 'lfu')).rejects.toThrow(/LFU maxmemory policy is selected/);
    await call('CONFIG', 'SET', 'maxmemory-policy', 'noeviction');
  });
});

describe('streams trim whole nodes like Redis', () => {
  it('MAXLEN ~ removes only full nodes, = is exact, XDEL frees empty nodes', async () => {
    for (let i = 1; i <= 250; i++) await redis.xadd('xs', `${i}-0`, 'f', 'v');
    const info = (await call('XINFO', 'STREAM', 'xs')) as unknown[];
    expect(info[info.indexOf('radix-tree-keys') + 1]).toBe(3);
    expect(await call('XTRIM', 'xs', 'MAXLEN', '~', 120)).toBe(100);
    expect(await redis.xlen('xs')).toBe(150);
    expect(await call('XTRIM', 'xs', 'MAXLEN', '=', 120)).toBe(30);
    expect(await redis.xlen('xs')).toBe(120);
    expect(await call('XTRIM', 'xs', 'MINID', '~', '230-0')).toBe(70);
    expect(await redis.xlen('xs')).toBe(50);
    await expect(call('XTRIM', 'xs', 'MAXLEN', 10, 'LIMIT', 5)).rejects.toThrow(/LIMIT cannot be used without/);
  });
});
