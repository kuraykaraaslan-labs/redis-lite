import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

import Redis from 'ioredis';

import type { Reply } from '@/libs/resp';

import { RedisLite } from '@/index';
import type { RedisLiteOptions } from '@/index';
import HashesService from '@/modules/hashes/hashes.service';
import { LuaEngine } from '@/modules/scripting/scripting.engine';
import { RedisLiteServer } from '@/modules/server/server.core';
import { idToString } from '@/modules/streams/streams.structure';

import { Persistence } from '../persistence.core';
import type { PropagatedOp } from '../persistence.types';

/** Shared fixtures of the persistence suites: temp dirs, a server + Persistence harness, a sample dataset. */
const roots: string[] = [];
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'redis-lite-persist-'));
  roots.push(d);
  return d;
}
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

export const FUNCTION_CODE = "#!lua name=mylib\nredis.register_function('myfunc', function(keys, args) return 'hi' end)";

export interface Harness {
  server: RedisLiteServer;
  p: Persistence;
  /** Runs a command the way the wired server will: inside a propagation unit, recording the dirty delta. */
  run: (...argv: string[]) => Reply;
  /** Every unit the propagator emitted. */
  units: PropagatedOp[][];
}

export async function harness(dir: string, cfg: Record<string, string> = {}): Promise<Harness> {
  const server = new RedisLiteServer({ port: 0, host: '127.0.0.1', databases: 16, logLevel: 'silent' });
  server.lua = await LuaEngine.create(server);
  server.config.set('dir', dir);
  for (const [k, v] of Object.entries(cfg)) server.config.set(k, v);
  const p = new Persistence(server);
  const units: PropagatedOp[][] = [];
  p.propagator.addSink((ops) => units.push([...ops]));
  const client = server.createInternalClient();
  const run = (...argv: string[]): Reply => {
    p.propagator.enter(argv[0]);
    const before = server.dirty;
    const r = server.execute(client, argv, { inScript: false, noBlock: true }) as Reply;
    p.markDirty(server.dirty - before);
    p.propagator.record(client.dbIndex, argv, r, server.dirty - before);
    p.propagator.exit();
    return r;
  };
  return { server, p, run, units };
}

export function populate(run: Harness['run']): void {
  run('SET', 'str', 'hello');
  run('SET', 'bin', '\x00\xff\r\n\x80binary');
  run('SET', 'num', '12345');
  run('SET', 'ttl', 'v', 'PX', '1000000');
  run('RPUSH', 'list', 'a', 'b', 'c');
  run('RPUSH', 'biglist', ...Array.from({ length: 300 }, (_, i) => `item-${i}`));
  run('SADD', 'set', 'x', 'y', 'z');
  run('SADD', 'iset', '1', '2', '3');
  run('ZADD', 'zset', '1.5', 'a', '-2', 'b', 'inf', 'c', '0.1', 'd');
  run('HSET', 'hash', 'f1', 'v1', 'f2', 'v2', 'f3', 'v3');
  run('HPEXPIRE', 'hash', '1000000', 'FIELDS', '1', 'f1');
  run('PEXPIRE', 'list', '2000000');
  run('XADD', 'stream', '1-1', 'a', '1');
  run('XADD', 'stream', '2-1', 'b', '2');
  run('XADD', 'stream', '3-1', 'c', '3');
  run('XDEL', 'stream', '3-1');
  run('XGROUP', 'CREATE', 'stream', 'g', '0');
  run('XREADGROUP', 'GROUP', 'g', 'alice', 'COUNT', '1', 'STREAMS', 'stream', '>');
  run('XGROUP', 'CREATECONSUMER', 'stream', 'g', 'bob');
  run('SELECT', '3');
  run('SET', 'db3key', 'in-db-3');
  run('SELECT', '0');
  run('FUNCTION', 'LOAD', FUNCTION_CODE);
}

/** Dataset as plain data: values, TTLs, hash field TTLs, stream groups / PEL (not consumer seen/active times). */
export function logical(server: RedisLiteServer): unknown {
  return server.databases.map((db) => {
    const out: Record<string, unknown> = {};
    for (const key of db.keys().sort()) {
      const v = db.peek(key);
      if (!v) continue;
      let value: unknown;
      switch (v.type) {
        case 'string':
          value = v.value;
          break;
        case 'list':
          value = [...v.value];
          break;
        case 'set':
          value = [...v.value].sort();
          break;
        case 'zset':
          value = v.value.entries.map((e) => [e.member, e.score]);
          break;
        case 'hash':
          value = { fields: [...v.value].sort(), ttl: [...(HashesService.hashFieldExpires(v.value) ?? [])].sort() };
          break;
        case 'stream': {
          const s = v.value;
          value = {
            entries: s.entries.map((e) => [idToString(e.id), e.fields]),
            lastId: idToString(s.lastId),
            entriesAdded: s.entriesAdded,
            maxDeletedId: idToString(s.maxDeletedId),
            groups: [...s.groups.values()].map((g) => ({
              name: g.name,
              lastId: idToString(g.lastId),
              entriesRead: g.entriesRead,
              pending: [...g.pending.values()].map((p) => [idToString(p.id), p.consumer, p.deliveryTime, p.deliveryCount]),
              consumers: [...g.consumers.keys()].sort(),
            })),
          };
          break;
        }
      }
      out[key] = { type: v.type, value, expire: db.getExpire(key) ?? null };
    }
    return out;
  });
}

export function fcall(h: Harness): Reply {
  return h.run('FCALL', 'myfunc', '0');
}


export const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

export async function withServer<T>(options: RedisLiteOptions, fn: (r: Redis, server: RedisLite) => Promise<T>): Promise<T> {
  const server = await RedisLite.start({ port: 0, logLevel: 'silent', ...options });
  const r = new Redis(server.url, { maxRetriesPerRequest: null, lazyConnect: false });
  try {
    return await fn(r, server);
  } finally {
    r.disconnect();
    await server.close();
  }
}

export async function errMsg(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'no error';
}

export const infoField = (text: string, name: string): string | undefined => new RegExp(`(?:^|\\r\\n)${name}:([^\\r]*)`).exec(text)?.[1];
