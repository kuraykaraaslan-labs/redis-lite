import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import Redis from 'ioredis';

import { RedisLite } from '@/index';
import { waitForBlocked } from '@/tests/helpers';

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

describe('basics', () => {
  it('strings, ttl, incr', async () => {
    expect(await redis.ping()).toBe('PONG');
    expect(await redis.set('a', '1', 'EX', 10)).toBe('OK');
    expect(await redis.get('a')).toBe('1');
    expect(await redis.ttl('a')).toBe(10);
    expect(await redis.incrby('a', 5)).toBe(6);
    expect(await redis.set('a', 'x', 'NX')).toBeNull();
    expect(await redis.getdel('a')).toBe('6');
    expect(await redis.exists('a')).toBe(0);
  });

  it('binary values round-trip', async () => {
    const buf = Buffer.from([0, 0x81, 0xff, 0x7f, 0xc3, 0xa7]);
    await redis.set('bin', buf);
    expect(await redis.getBuffer('bin')).toEqual(buf);
    await redis.set('utf', 'çğış🙂');
    expect(await redis.get('utf')).toBe('çğış🙂');
  });

  it('hash, list, set, zset', async () => {
    await redis.hset('h', 'f', 'v', 'n', '1');
    expect(await redis.hgetall('h')).toEqual({ f: 'v', n: '1' });
    expect(await redis.hincrby('h', 'n', 2)).toBe(3);
    await redis.rpush('l', 'a', 'b', 'c');
    expect(await redis.lrange('l', 0, -1)).toEqual(['a', 'b', 'c']);
    expect(await redis.lpos('l', 'b')).toBe(1);
    await redis.sadd('s', 'x', 'y');
    expect(await redis.scard('s')).toBe(2);
    await redis.zadd('z', 3, 'c', 1, 'a', 2, 'b');
    expect(await redis.zrange('z', 0, -1, 'WITHSCORES')).toEqual(['a', '1', 'b', '2', 'c', '3']);
    expect(await redis.zrangebyscore('z', '(1', '+inf')).toEqual(['b', 'c']);
    expect(await redis.zrevrangebyscore('z', 3, 2)).toEqual(['c', 'b']);
    expect(await redis.type('z')).toBe('zset');
    await expect(redis.lpush('h', 'x')).rejects.toThrow(/WRONGTYPE/);
  });

  it('multi/exec and watch', async () => {
    const r = await redis.multi().set('m', '1').incr('m').exec();
    expect(r).toEqual([[null, 'OK'], [null, 2]]);
    const other = redis.duplicate();
    await redis.watch('m');
    await other.set('m', '9');
    expect(await redis.multi().set('m', '3').exec()).toBeNull();
    other.disconnect();
  });

  it('lua: the connected-limit admit script from next-boilerplate', async () => {
    const ADMIT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then return {1, redis.call('ZCARD', KEYS[1])} end
local n = redis.call('ZCARD', KEYS[1])
if n >= tonumber(ARGV[2]) then return {0, n} end
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[3])
return {1, n + 1}`;
    const now = Date.now();
    expect(await redis.eval(ADMIT, 1, 'conn', now, 2, 'd1', now + 60000)).toEqual([1, 1]);
    expect(await redis.eval(ADMIT, 1, 'conn', now, 2, 'd2', now + 60000)).toEqual([1, 2]);
    expect(await redis.eval(ADMIT, 1, 'conn', now, 2, 'd3', now + 60000)).toEqual([0, 2]);
    expect(await redis.eval(ADMIT, 1, 'conn', now, 2, 'd1', now + 60000)).toEqual([1, 2]);
    expect(await redis.zscore('conn', 'd1')).toBe(String(now + 60000));
  });

  it('lua: errors, cjson, cmsgpack, status', async () => {
    await expect(redis.eval("return redis.call('INCR', KEYS[1])", 1, 'h')).rejects.toThrow(/WRONGTYPE/);
    expect(await redis.eval("local ok = redis.pcall('INCR', KEYS[1]) return ok.err ~= nil and 1 or 0", 1, 'h')).toBe(1);
    expect(await redis.eval('return cjson.encode(cjson.decode(ARGV[1]))', 0, '{"a":[1,2,3]}')).toBe('{"a":[1,2,3]}');
    expect(await redis.eval("return redis.status_reply('FINE')", 0)).toBe('FINE');
    expect(await redis.eval('return tostring(tonumber(ARGV[1]))', 0, '1700000000000')).toBe('1700000000000');
    expect(await redis.eval("local t = cmsgpack.unpack(cmsgpack.pack({delay = 5, name = 'x'})) return {t.delay, t.name}", 0)).toEqual([5, 'x']);
    expect(await redis.eval('return 3.99', 0)).toBe(3);
  });

  it('blocking BLPOP and BZPOPMIN are woken by writes', async () => {
    const b = redis.duplicate();
    const pending = b.blpop('q', 30);
    await waitForBlocked({ call: (...args: string[]) => redis.call(args[0], ...args.slice(1)) });
    await redis.rpush('q', 'job');
    expect(await pending).toEqual(['q', 'job']);
    const z = b.bzpopmin('mk', 0.05);
    expect(await z).toBeNull();
    b.disconnect();
  });

  it('pub/sub', async () => {
    const sub = redis.duplicate();
    const got = new Promise<string>((resolve) => sub.on('message', (_c, m) => resolve(m)));
    await sub.subscribe('ch');
    expect(await redis.publish('ch', 'hello')).toBe(1);
    expect(await got).toBe('hello');
    sub.disconnect();
  });

  it('streams with consumer groups', async () => {
    const id1 = await redis.xadd('st', '*', 'a', '1');
    await redis.xadd('st', 'MAXLEN', '~', '100', '*', 'b', '2');
    expect(await redis.xlen('st')).toBe(2);
    await redis.xgroup('CREATE', 'st', 'g', '0');
    const read = (await redis.xreadgroup('GROUP', 'g', 'c1', 'COUNT', 1, 'STREAMS', 'st', '>')) as Array<[string, Array<[string, string[]]>]>;
    expect(read[0][1][0][0]).toBe(id1);
    const pending = (await redis.xpending('st', 'g')) as unknown[];
    expect(pending[0]).toBe(1);
    expect(await redis.xack('st', 'g', id1 as string)).toBe(1);
    const claimed = (await redis.xautoclaim('st', 'g', 'c2', 0, '0')) as unknown[];
    expect(claimed[0]).toBe('0-0');
    const groups = (await redis.xinfo('GROUPS', 'st')) as unknown[][];
    expect(groups[0]).toContain('last-delivered-id');
  });

  it('info and client list', async () => {
    const info = await redis.info();
    expect(info).toContain('redis_version:7.0.15');
    expect(info).toContain('maxmemory_policy:noeviction');
    await redis.client('SETNAME', 'tester');
    expect(await redis.client('LIST')).toContain('name=tester');
  });
});
