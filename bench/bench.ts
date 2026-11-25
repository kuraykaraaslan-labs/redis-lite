/**
 * Throughput benchmark: pipelined commands through ioredis against an in-process redis-lite.
 * Not a performance promise — a tool to find hot spots. Run: npx tsx bench/bench.ts
 */
import Redis from 'ioredis';

import { RedisLite } from '../src/index';

interface Case {
  name: string;
  ops: number;
  setup?: (r: Redis) => Promise<void>;
  cmd: (p: ReturnType<Redis['pipeline']>, i: number) => void;
}

const PIPELINE = 1000;

const cases: Case[] = [
  { name: 'SET', ops: 100_000, cmd: (p, i) => p.set(`k:${i}`, 'v') },
  { name: 'GET', ops: 100_000, cmd: (p, i) => p.get(`k:${i}`) },
  { name: 'INCR', ops: 100_000, cmd: (p) => p.incr('counter') },
  { name: 'HSET (one big hash)', ops: 50_000, cmd: (p, i) => p.hset('h', `f${i}`, 'v') },
  { name: 'SADD (one big set)', ops: 50_000, cmd: (p, i) => p.sadd('s', `m${i}`) },
  { name: 'ZADD (one big zset)', ops: 50_000, cmd: (p, i) => p.zadd('z', i, `m${i}`) },
  { name: 'LPUSH (one big list)', ops: 50_000, cmd: (p, i) => p.lpush('l', `v${i}`) },
  { name: 'RPOP (big list)', ops: 50_000, cmd: (p) => p.rpop('l') },
  { name: 'XADD MAXLEN ~ 10000', ops: 50_000, cmd: (p, i) => p.xadd('x', 'MAXLEN', '~', '10000', '*', 'temp', String(i), 'dev', 'd1') },
  { name: 'PFADD', ops: 50_000, cmd: (p, i) => p.pfadd('hll', `u${i}`) },
  { name: 'EVALSHA (small script)', ops: 20_000, cmd: (p, i) => p.eval("return redis.call('INCRBY', KEYS[1], ARGV[1])", 1, 'lua', String(i)) },
];

async function main(): Promise<void> {
  const server = await RedisLite.start({ port: 0 });
  const redis = new Redis(server.url);
  console.log('case'.padEnd(26), 'ops/sec'.padStart(10), 'total ms'.padStart(10));
  for (const c of cases) {
    if (c.setup) await c.setup(redis);
    const start = performance.now();
    for (let base = 0; base < c.ops; base += PIPELINE) {
      const p = redis.pipeline();
      for (let i = base; i < Math.min(c.ops, base + PIPELINE); i++) c.cmd(p, i);
      await p.exec();
    }
    const ms = performance.now() - start;
    console.log(c.name.padEnd(26), String(Math.round((c.ops / ms) * 1000)).padStart(10), ms.toFixed(0).padStart(10));
  }
  redis.disconnect();
  await server.close();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
