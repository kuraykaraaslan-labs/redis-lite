/**
 * Helpers of the replication suites: servers started in this process on random ports, wired as master / replicas,
 * and polling for the replication state (never fixed sleeps).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { afterAll } from 'vitest';

import Redis from 'ioredis';

import { RedisLite } from '@/index';
import type { RedisLiteOptions } from '@/index';
import { tempDir, waitFor } from '@/tests/helpers';
import type { WaitOptions } from '@/tests/helpers';

/** A running server and a client on it. */
export interface Node {
  server: RedisLite;
  port: number;
  r: Redis;
  call: (...args: Array<string | number | Buffer>) => Promise<unknown>;
  /** INFO <section> as field → value. */
  info: (section?: string) => Promise<Record<string, string>>;
  /** A further connection (closed with the node). */
  client: () => Redis;
  close: () => Promise<void>;
}

/** Fast settings for tests: diskless transfers start at once. */
export const TEST_CONFIG: Record<string, string> = { 'repl-diskless-sync-delay': '0' };

/** Starts a server (closed after the file). `config` adds CONFIG values (`replicaof` makes it a replica). */
export async function startNode(config: Record<string, string> = {}, options: RedisLiteOptions = {}): Promise<Node> {
  const dir = tempDir('redis-lite-repl-');
  const server = await RedisLite.start({ port: 0, dir, save: '', ...options, config: { ...TEST_CONFIG, ...config } });
  const extra: Redis[] = [];
  const open = (): Redis => {
    const c = new Redis(server.url, { maxRetriesPerRequest: null, lazyConnect: false });
    extra.push(c);
    return c;
  };
  const r = open();
  let closed = false;
  const node: Node = {
    server,
    port: server.port,
    r,
    call: (...args) => r.call(String(args[0]), ...args.slice(1).map((a) => (Buffer.isBuffer(a) ? a : String(a)))),
    info: async (section = 'replication') => parseInfo(String(await r.call('INFO', section))),
    client: open,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const c of extra) c.disconnect();
      await server.close();
    },
  };
  afterAll(() => node.close());
  return node;
}

/** Starts a replica of `master`. */
export async function startReplica(master: Node, config: Record<string, string> = {}): Promise<Node> {
  return startNode({ replicaof: `127.0.0.1 ${master.port}`, ...config });
}

export function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** Waits until the replica's link is up and it applied everything the master fed so far. */
export async function waitSynced(master: Node, replica: Node, options?: WaitOptions): Promise<void> {
  await waitFor(async () => {
    const r = await replica.info();
    if (r.master_link_status !== 'up') return false;
    const m = await master.info();
    return r.slave_repl_offset === m.master_repl_offset;
  }, { timeout: 15_000, ...options });
}

/** Waits until the master lists `n` online replicas. */
export async function waitReplicas(master: Node, n: number, options?: WaitOptions): Promise<void> {
  await waitFor(async () => {
    const m = await master.info();
    return Object.keys(m).filter((k) => /^slave\d+$/.test(k) && m[k].includes('state=online')).length >= n;
  }, { timeout: 15_000, ...options });
}
