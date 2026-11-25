import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Redis from 'ioredis';

import type { Reply } from '@/libs/resp';

import { RedisLite } from '@/index';
import { LuaEngine } from '@/modules/scripting/scripting.engine';
import { RedisLiteServer } from '@/modules/server/server.core';
import { hashFieldExpires } from '@/modules/hashes/hashes.commands';
import { objectEncoding } from '@/modules/database/database.encoding';
import { sleep, tempDir, useServer } from '@/tests/helpers';

import { clientMemory, computeMemory } from '../memory.accounting';
import type { KeyRecord } from '../memory.accounting';

/**
 * maxmemory and the eviction policies, as documented on redis.io ("Key eviction") and in redis.conf: the policies,
 * approximated LRU / LFU / TTL by sampling maxmemory-samples keys, the OOM error of denyoom commands, evicted_keys and
 * the `evicted` keyspace event.
 */
const t = useServer();

const OOM = "OOM command not allowed when used memory > 'maxmemory'.";
const BIG = 'x'.repeat(4000);

async function info(section: string): Promise<Map<string, string>> {
  const text = String(await t.call('INFO', section));
  return new Map(text.split('\r\n').filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]));
}

async function used(): Promise<number> {
  return Number((await info('memory')).get('used_memory'));
}

async function evicted(): Promise<number> {
  return Number((await info('stats')).get('evicted_keys'));
}

async function errOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'no error';
}

async function exists(...keys: string[]): Promise<boolean[]> {
  return Promise.all(keys.map(async (k) => (await t.call('EXISTS', k)) === 1));
}

beforeEach(async () => {
  await t.call('CONFIG', 'SET', 'maxmemory', '0');
  await t.call('FLUSHALL');
  await t.call('CONFIG', 'SET', 'maxmemory-samples', '64', 'maxmemory-eviction-tenacity', '100');
});

afterEach(async () => {
  await t.call('CONFIG', 'SET', 'maxmemory', '0', 'maxmemory-policy', 'noeviction', 'maxmemory-samples', '5', 'maxmemory-eviction-tenacity', '10');
});

describe('noeviction', () => {
  it('denyoom commands get the OOM error once over the limit; reads and DEL still work', async () => {
    await t.call('CONFIG', 'SET', 'maxmemory-policy', 'noeviction');
    await t.call('CONFIG', 'SET', 'maxmemory', String((await used()) + 30_000));
    let refused = '';
    for (let i = 0; i < 50 && !refused; i++) {
      const e = await errOf(t.call('SET', `k:${i}`, BIG));
      if (e !== 'no error') refused = e;
    }
    expect(refused).toBe(OOM);
    expect(await t.call('GET', 'k:0')).toBe(BIG);
    expect(await errOf(t.call('LPUSH', 'list', 'a'))).toBe(OOM);
    expect(await t.call('DEL', 'k:0', 'k:1', 'k:2', 'k:3')).toBe(4);
    expect(await t.call('SET', 'again', 'v')).toBe('OK');
    expect(await evicted()).toBe(0);
  });

  it('MULTI: queueing is refused while out of memory and EXEC aborts', async () => {
    const c = t.client();
    await c.call('SET', 'fill', 'x'.repeat(20_000));
    await t.call('CONFIG', 'SET', 'maxmemory', String((await used()) - 1000));
    await c.call('MULTI');
    expect(await errOf(c.call('SET', 'a', '1'))).toBe(OOM);
    expect(await errOf(c.call('GET', 'a'))).toBe(OOM);
    expect(await errOf(c.call('EXEC'))).toBe(`EXECABORT Transaction discarded because of previous errors.`);
  });

  it('EXEC is refused when a queued command is denyoom and memory ran out after queueing', async () => {
    const c = t.client();
    await c.call('SET', 'fill', 'x'.repeat(20_000));
    await c.call('MULTI');
    await c.call('SET', 'a', '1');
    await t.call('CONFIG', 'SET', 'maxmemory', String((await used()) - 1000));
    expect(await errOf(c.call('EXEC'))).toBe(`EXECABORT Transaction discarded because of: ${OOM}`);
    await c.call('MULTI');
    await t.call('CONFIG', 'SET', 'maxmemory', '0');
    await c.call('GET', 'a');
    await t.call('CONFIG', 'SET', 'maxmemory', String((await used()) - 1000));
    expect(await c.call('EXEC')).toEqual([null]);
  });

  it('scripts: write commands called while out of memory fail with OOM, reads work', async () => {
    await t.call('SET', 'fill', 'x'.repeat(20_000));
    await t.call('CONFIG', 'SET', 'maxmemory', String((await used()) - 1000));
    expect(await errOf(t.call('EVAL', "return redis.call('SET', KEYS[1], 'v')", '1', 'k'))).toMatch(/^OOM command not allowed when used memory > 'maxmemory'\./);
    expect(await t.call('EVAL', "return redis.call('GET', KEYS[1])", '1', 'fill')).toHaveLength(20_000);
  });
});

describe('policies', () => {
  /** A DUMP payload of a value of about 4 KB. */
  async function payload(): Promise<Buffer> {
    await t.call('SET', 'tmp', BIG);
    const p = await t.redis.dumpBuffer('tmp');
    await t.call('DEL', 'tmp');
    return p;
  }

  it('allkeys-lru: the least recently used keys go first', async () => {
    await t.call('CONFIG', 'SET', 'maxmemory-policy', 'allkeys-lru');
    const p = await payload();
    for (let i = 0; i < 10; i++) await t.redis.restore(`cold:${i}`, 0, p, 'IDLETIME', 10_000 + i);
    for (let i = 0; i < 10; i++) await t.call('SET', `hot:${i}`, BIG);
    const total = await used();
    await t.call('CONFIG', 'SET', 'maxmemory', String(total - 4 * 4100));
    expect(await used()).toBeLessThanOrEqual(total - 4 * 4100);
    const n = await evicted();
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThan(10);
    expect(await exists(...Array.from({ length: 10 }, (_, i) => `hot:${i}`))).toEqual(Array(10).fill(true));
    // the most idle ones were evicted
    const cold = await exists(...Array.from({ length: 10 }, (_, i) => `cold:${i}`));
    expect(cold.slice(10 - n).every((e) => !e)).toBe(true);
    // writes go on, evicting more
    expect(await t.call('SET', 'new', BIG)).toBe('OK');
    expect(await evicted()).toBeGreaterThan(n);
  });

  it('allkeys-lfu: the least frequently used keys go first', async () => {
    await t.call('CONFIG', 'SET', 'maxmemory-policy', 'allkeys-lfu');
    const p = await payload();
    for (let i = 0; i < 8; i++) await t.redis.restore(`rare:${i}`, 0, p, 'FREQ', 0);
    for (let i = 0; i < 8; i++) await t.redis.restore(`often:${i}`, 0, p, 'FREQ', 200);
    const total = await used();
    await t.call('CONFIG', 'SET', 'maxmemory', String(total - 3 * 4100));
    expect(await evicted()).toBeGreaterThanOrEqual(3);
    expect(await exists(...Array.from({ length: 8 }, (_, i) => `often:${i}`))).toEqual(Array(8).fill(true));
  });

  it('volatile-ttl: keys with the nearest expire go first; keys without TTL are never evicted', async () => {
    await t.call('CONFIG', 'SET', 'maxmemory-policy', 'volatile-ttl');
    for (let i = 0; i < 5; i++) await t.call('SET', `soon:${i}`, BIG, 'EX', String(100 + i));
    for (let i = 0; i < 5; i++) await t.call('SET', `late:${i}`, BIG, 'EX', '100000');
    for (let i = 0; i < 5; i++) await t.call('SET', `keep:${i}`, BIG);
    const total = await used();
    await t.call('CONFIG', 'SET', 'maxmemory', String(total - 3 * 4100));
    const n = await evicted();
    expect(n).toBeGreaterThanOrEqual(3);
    expect(await exists('soon:0', 'soon:1', 'soon:2')).toEqual([false, false, false]);
    expect(await exists(...Array.from({ length: 5 }, (_, i) => `late:${i}`))).toEqual(Array(5).fill(true));
    // more than the volatile keys can free: only keys with a TTL are evicted, then writes are refused
    await t.call('CONFIG', 'SET', 'maxmemory', String(total - 20 * 4100));
    expect(await errOf(t.call('SET', 'x', 'y'))).toBe(OOM);
    expect(await exists(...Array.from({ length: 5 }, (_, i) => `keep:${i}`))).toEqual(Array(5).fill(true));
    expect(await t.call('DBSIZE')).toBe(5);
  });

  it('volatile-lru / volatile-lfu / volatile-random with no key having a TTL behave like noeviction', async () => {
    for (let i = 0; i < 5; i++) await t.call('SET', `p:${i}`, BIG);
    for (const policy of ['volatile-lru', 'volatile-lfu', 'volatile-random']) {
      await t.call('CONFIG', 'SET', 'maxmemory-policy', policy);
      await t.call('CONFIG', 'SET', 'maxmemory', String((await used()) - 1000));
      expect(await errOf(t.call('SET', 'x', 'y'))).toBe(OOM);
      await t.call('CONFIG', 'SET', 'maxmemory', '0');
    }
    expect(await t.call('DBSIZE')).toBe(5);
  });

  it('allkeys-random and volatile-random free enough memory', async () => {
    await t.call('CONFIG', 'SET', 'maxmemory-policy', 'allkeys-random');
    for (let i = 0; i < 20; i++) await t.call('SET', `r:${i}`, BIG);
    const total = await used();
    await t.call('CONFIG', 'SET', 'maxmemory', String(total - 5 * 4100));
    expect(await used()).toBeLessThanOrEqual(total - 5 * 4100);
    expect(await t.call('DBSIZE')).toBeLessThanOrEqual(15);
    await t.call('CONFIG', 'SET', 'maxmemory', '0', 'maxmemory-policy', 'volatile-random');
    for (let i = 0; i < 10; i++) await t.call('SET', `v:${i}`, BIG, 'EX', '1000');
    const before = await t.call('DBSIZE');
    const rKeys = ((await t.call('KEYS', 'r:*')) as string[]).length;
    const now = await used();
    await t.call('CONFIG', 'SET', 'maxmemory', String(now - 3 * 4100));
    expect(Number(before) - Number(await t.call('DBSIZE'))).toBeGreaterThanOrEqual(3);
    // only keys with a TTL were candidates
    expect(((await t.call('KEYS', 'r:*')) as string[]).length).toBe(rKeys);
  });

  it('evicts across databases', async () => {
    await t.call('CONFIG', 'SET', 'maxmemory-policy', 'allkeys-lru');
    const p = await payload();
    const c = t.client();
    await c.select(4);
    for (let i = 0; i < 5; i++) await c.restore(`old:${i}`, 0, p, 'IDLETIME', 50_000);
    for (let i = 0; i < 5; i++) await t.call('SET', `fresh:${i}`, BIG);
    await t.call('CONFIG', 'SET', 'maxmemory', String((await used()) - 2 * 4100));
    expect(Number(await c.dbsize())).toBeLessThanOrEqual(3);
    expect(await t.call('DBSIZE')).toBe(5);
    await c.flushdb();
    c.disconnect();
  });

  it('a low tenacity finishes the work in the background without refusing commands', async () => {
    await t.call('CONFIG', 'SET', 'maxmemory-policy', 'allkeys-random', 'maxmemory-eviction-tenacity', '0');
    const pipe = t.redis.pipeline();
    for (let i = 0; i < 3000; i++) pipe.set(`small:${i}`, `value-${i}`);
    await pipe.exec();
    const target = (await used()) - 150_000;
    expect(await t.call('CONFIG', 'SET', 'maxmemory', String(target))).toBe('OK');
    expect(await t.call('SET', 'allowed', 'v')).toBe('OK');
    await sleep(200);
    expect(await used()).toBeLessThanOrEqual(target);
  });
});

describe('side effects of an eviction', () => {
  it('INFO evicted_keys, the evicted keyspace event (class e), WATCH and DEL in the AOF', async () => {
    const dir = tempDir();
    const server = await RedisLite.start({ port: 0, dir, appendonly: true, save: '' });
    const r = new Redis(server.url);
    const sub = new Redis(server.url);
    const watcher = new Redis(server.url);
    try {
      const events: string[] = [];
      await r.config('SET', 'notify-keyspace-events', 'Ee');
      sub.on('message', (_ch: string, key: string) => events.push(key));
      await sub.subscribe('__keyevent@0__:evicted');
      await r.config('SET', 'maxmemory-policy', 'allkeys-lru', 'maxmemory-samples', '64');
      const payload = await (async () => {
        await r.set('tmp', BIG);
        const p = await r.dumpBuffer('tmp');
        await r.del('tmp');
        return p;
      })();
      await r.restore('victim', 0, payload, 'IDLETIME', 100_000);
      for (let i = 0; i < 4; i++) await r.set(`stay:${i}`, BIG);
      await watcher.watch('victim');
      const usedNow = Number(/used_memory:(\d+)/.exec(await r.info('memory'))?.[1]);
      await r.config('SET', 'maxmemory', String(usedNow - 100));
      expect(await r.exists('victim')).toBe(0);
      await sleep(40);
      expect(events).toEqual(['victim']);
      expect(await watcher.multi().set('w', '1').exec()).toBeNull();
      expect(/evicted_keys:(\d+)/.exec(await r.info('stats'))?.[1]).toBe('1');
      await r.config('SET', 'maxmemory', '0');
      const aofDir = join(dir, 'appendonlydir');
      const incr = readdirSync(aofDir).find((f) => f.endsWith('.incr.aof')) as string;
      expect(readFileSync(join(aofDir, incr), 'latin1')).toContain('*2\r\n$3\r\nDEL\r\n$6\r\nvictim\r\n');
    } finally {
      r.disconnect();
      sub.disconnect();
      watcher.disconnect();
      await server.close();
    }
  });
});

describe('incremental used-memory accounting', () => {
  it('matches a full recomputation of the dataset after many kinds of changes', async () => {
    const server = new RedisLiteServer({ port: 0, host: '127.0.0.1', databases: 4, logLevel: 'silent' });
    server.lua = await LuaEngine.create(server);
    const client = server.createInternalClient();
    const run = (...argv: string[]): Reply => server.execute(client, argv, { inScript: false, noBlock: true }) as Reply;
    const allocated = new Set<number>();
    const full = (): number => {
      const databases = server.databases.map((db, id) => {
        if (db.keys().length) allocated.add(id);
        const keys: KeyRecord[] = [];
        for (const key of db.keys()) {
          const value = db.peek(key);
          if (!value) continue;
          const fieldTtls = value.type === 'hash' ? hashFieldExpires(value.value) : undefined;
          keys.push({ key, value, encoding: objectEncoding(value, server.config, fieldTtls !== undefined), hasExpire: db.getExpire(key) !== undefined, fieldTtls });
        }
        return { id, keys, allocated: allocated.has(id) };
      });
      return computeMemory({ databases, clientsNormal: server.clients.size * clientMemory(), sizes: {
        listMaxListpackSize: server.config.num('list-max-listpack-size'),
        streamNodeMaxEntries: server.config.num('stream-node-max-entries'),
        streamNodeMaxBytes: server.config.num('stream-node-max-bytes'),
      } }).usedMemory;
    };
    const check = () => expect(server.memoryReport().usedMemory).toBe(full());

    run('SET', 's', 'hello');
    run('APPEND', 's', ' world');
    check();
    run('RPUSH', 'l', ...Array.from({ length: 200 }, (_, i) => `item-${i}`));
    run('LPOP', 'l', '50');
    check();
    run('HSET', 'h', ...Array.from({ length: 300 }, (_, i) => [`f${i}`, `v${i}`]).flat());
    run('HPEXPIRE', 'h', '100000', 'FIELDS', '1', 'f1');
    check();
    run('SADD', 'set', '1', '2', '3');
    run('SADD', 'set', 'not-an-int');
    run('ZADD', 'z', '1', 'a', '2', 'b');
    run('XADD', 'st', '*', 'f', 'v');
    check();
    run('EXPIRE', 's', '1000');
    run('PERSIST', 's');
    run('EXPIRE', 'l', '1000');
    check();
    run('RENAME', 'z', 'z2');
    run('SELECT', '2');
    run('SET', 'other-db', 'v');
    run('SELECT', '0');
    run('SWAPDB', '0', '2');
    check();
    run('SWAPDB', '0', '2');
    run('DEL', 'set');
    run('EVAL', "redis.call('SET', 'fromlua', string.rep('a', 1000)); return 1", '0');
    check();
    run('CONFIG', 'SET', 'list-max-listpack-size', '8');
    check();
    run('FLUSHDB');
    check();
  });
});
