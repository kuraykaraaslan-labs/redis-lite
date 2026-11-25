/**
 * Throughput benchmark: pipelined commands through ioredis against an in-process redis-lite.
 * Not a performance promise — a tool to find hot spots.
 *
 * Run: npx tsx bench/bench.ts [--runs N] [--only <substring>[,<substring>…]]
 * Every run starts a fresh server; with several runs the best ops/sec of each case is reported (the machine may be
 * loaded, the best run is the least disturbed one).
 */
import Redis from 'ioredis';

import { RedisLite } from '@/index';

// ============================================================================
// Cases
// ============================================================================

type Pipeline = ReturnType<Redis['pipeline']>;

interface Case {
  name: string;
  ops: number;
  setup?: (r: Redis) => Promise<void>;
  cmd: (p: Pipeline, i: number) => void;
  /** Stop early after this many ms (cases that are quadratic before an optimisation); ops/sec covers what ran. */
  budgetMs?: number;
}

const PIPELINE = 1000;
const HOT_KEYS = 16;
const QUEUE_SIZE = 100_000;
const BIG_LIST_PUSH_WIDTH = 10;

/** A BullMQ-like "add job" script: job id counter, job hash, wait list, event stream capped by MAXLEN ~. */
const ADD_JOB_LUA = `
local id = redis.call('INCR', KEYS[1])
local jobKey = KEYS[2] .. id
redis.call('HSET', jobKey, 'name', ARGV[1], 'data', ARGV[2], 'timestamp', ARGV[3], 'attempts', '0')
redis.call('LPUSH', KEYS[3], id)
redis.call('XADD', KEYS[4], 'MAXLEN', '~', '10000', '*', 'event', 'waiting', 'jobId', id)
return id
`;
let addJobSha = '';

const TEN_KEYS = Array.from({ length: 10 }, (_, k) => `mk:${k}`);

async function fillQueue(r: Redis): Promise<void> {
  for (let base = 0; base < QUEUE_SIZE; base += PIPELINE) {
    const items = Array.from({ length: PIPELINE }, (_, i) => `job:${base + i}`);
    await r.rpush('queue', ...items);
  }
}

const cases: Case[] = [
  { name: 'SET', ops: 100_000, cmd: (p, i) => p.set(`k:${i}`, 'v') },
  { name: 'GET', ops: 100_000, cmd: (p, i) => p.get(`k:${i}`) },
  { name: 'INCR', ops: 100_000, cmd: (p) => p.incr('counter') },
  { name: 'INCR (16 hot keys)', ops: 100_000, cmd: (p, i) => p.incr(`hot:${i % HOT_KEYS}`) },
  { name: 'HINCRBY (hot fields)', ops: 100_000, cmd: (p, i) => p.hincrby(`metrics:${i % 4}`, `f${i % HOT_KEYS}`, 1) },
  { name: 'MSET 10 keys', ops: 50_000, cmd: (p, i) => p.mset(...TEN_KEYS.flatMap((k) => [k, String(i)])) },
  { name: 'MGET 10 keys', ops: 50_000, cmd: (p) => p.mget(...TEN_KEYS) },
  { name: 'HSET (one big hash)', ops: 50_000, cmd: (p, i) => p.hset('h', `f${i}`, 'v') },
  { name: 'SADD (one big set)', ops: 50_000, cmd: (p, i) => p.sadd('s', `m${i}`) },
  { name: 'ZADD (one big zset)', ops: 50_000, cmd: (p, i) => p.zadd('z', i, `m${i}`) },
  { name: 'LPUSH (one big list)', ops: 50_000, cmd: (p, i) => p.lpush('l', `v${i}`) },
  { name: 'RPOP (big list)', ops: 50_000, cmd: (p) => p.rpop('l') },
  {
    name: 'LPUSH+RPOP (100k queue)',
    ops: 100_000,
    setup: fillQueue,
    cmd: (p, i) => (i % 2 === 0 ? p.lpush('queue', `job:n${i}`) : p.rpop('queue')),
  },
  {
    name: 'LPUSH x10 to 1M list',
    ops: 1_000_000 / BIG_LIST_PUSH_WIDTH,
    budgetMs: 60_000,
    cmd: (p, i) => p.lpush('biglist', ...Array.from({ length: BIG_LIST_PUSH_WIDTH }, (_, j) => `e${i}:${j}`)),
  },
  { name: 'XADD MAXLEN ~ 10000', ops: 50_000, cmd: (p, i) => p.xadd('x', 'MAXLEN', '~', '10000', '*', 'temp', String(i), 'dev', 'd1') },
  { name: 'PFADD', ops: 50_000, cmd: (p, i) => p.pfadd('hll', `u${i}`) },
  { name: 'EVAL (small script)', ops: 20_000, cmd: (p, i) => p.eval("return redis.call('INCRBY', KEYS[1], ARGV[1])", 1, 'lua', String(i)) },
  {
    name: 'EVALSHA (BullMQ-like add)',
    ops: 20_000,
    setup: async (r) => {
      addJobSha = (await r.script('LOAD', ADD_JOB_LUA)) as string;
    },
    cmd: (p, i) => p.evalsha(addJobSha, 4, 'q:id', 'q:job:', 'q:wait', 'q:events', 'job', `{"n":${i}}`, String(i)),
  },
];

// ============================================================================
// Runner
// ============================================================================

interface Options {
  runs: number;
  only: string[] | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { runs: 1, only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') options.runs = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === '--only') options.only = (argv[++i] ?? '').toLowerCase().split(',');
  }
  return options;
}

/** One case: its ops/sec and elapsed ms (`partial` when the budget stopped it early). */
async function runCase(redis: Redis, c: Case): Promise<{ opsPerSec: number; ms: number; partial: boolean }> {
  if (c.setup) await c.setup(redis);
  const start = performance.now();
  let done = 0;
  for (let base = 0; base < c.ops; base += PIPELINE) {
    const p = redis.pipeline();
    const end = Math.min(c.ops, base + PIPELINE);
    for (let i = base; i < end; i++) c.cmd(p, i);
    await p.exec();
    done = end;
    if (c.budgetMs !== undefined && performance.now() - start > c.budgetMs) break;
  }
  const ms = performance.now() - start;
  return { opsPerSec: (done / ms) * 1000, ms, partial: done < c.ops };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const only = options.only;
  const selected = cases.filter((c) => only === null || only.some((o) => c.name.toLowerCase().includes(o)));
  const best = new Map<string, { opsPerSec: number; ms: number; partial: boolean }>();
  for (let run = 0; run < options.runs; run++) {
    const server = await RedisLite.start({ port: 0 });
    const redis = new Redis(server.url);
    for (const c of selected) {
      const result = await runCase(redis, c);
      const prev = best.get(c.name);
      if (!prev || result.opsPerSec > prev.opsPerSec) best.set(c.name, result);
    }
    redis.disconnect();
    await server.close();
  }
  console.log('case'.padEnd(28), 'ops/sec'.padStart(10), 'total ms'.padStart(10));
  for (const c of selected) {
    const r = best.get(c.name);
    if (!r) continue;
    const note = r.partial ? `  (stopped after ${c.budgetMs} ms budget)` : '';
    console.log(c.name.padEnd(28), String(Math.round(r.opsPerSec)).padStart(10), r.ms.toFixed(0).padStart(10) + note);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
