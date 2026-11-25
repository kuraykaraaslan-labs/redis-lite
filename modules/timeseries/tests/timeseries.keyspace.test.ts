/**
 * The time series type in the rest of the server: TYPE / SCAN TYPE / OBJECT / MEMORY USAGE / EXPIRE, WATCH, keyspace
 * notifications, DUMP / RESTORE, RDB (SAVE, DEBUG RELOAD), AOF propagation and rewrite, COMMAND metadata and ACL.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import Redis from 'ioredis';

import { RedisLite } from '@/index';
import type { RedisLiteOptions } from '@/index';
import PersistenceService from '@/modules/persistence/persistence.service';
import { err, sleep, tempDir, useServer } from '@/tests/helpers';

const t = useServer();

async function withServer(options: RedisLiteOptions, fn: (r: Redis) => Promise<void>): Promise<void> {
  const server = await RedisLite.start({ port: 0, ...options });
  const r = new Redis(server.url, { maxRetriesPerRequest: null });
  try {
    await fn(r);
  } finally {
    r.disconnect();
    await server.close();
  }
}

/** The commands of the newest incremental AOF file, as argv arrays. */
function aofCommands(dir: string): string[][] {
  const aofDir = join(dir, 'appendonlydir');
  const incr = readdirSync(aofDir).filter((f) => f.endsWith('.incr.aof')).sort().pop() as string;
  const text = readFileSync(join(aofDir, incr), 'latin1');
  const out: string[][] = [];
  for (let pos = 0; pos < text.length; ) {
    const step = PersistenceService.parseAofCommand(text, pos);
    if (!('argv' in step)) break;
    out.push(step.argv);
    pos = step.next;
  }
  return out;
}

async function seed(r: Redis | { call: (...a: Array<string | number>) => Promise<unknown> }, prefix: string): Promise<void> {
  const call = (...a: Array<string | number>): Promise<unknown> => (r as Redis).call(String(a[0]), ...a.slice(1).map(String));
  await call('TS.CREATE', `${prefix}:src`, 'RETENTION', 100000, 'DUPLICATE_POLICY', 'SUM', 'IGNORE', 2, 0.5, 'LABELS', 'room', 'lab');
  await call('TS.CREATE', `${prefix}:dst`, 'ENCODING', 'UNCOMPRESSED', 'CHUNK_SIZE', 64);
  await call('TS.CREATERULE', `${prefix}:src`, `${prefix}:dst`, 'AGGREGATION', 'avg', 10, 5);
  await call('TS.MADD', `${prefix}:src`, 5, 1, `${prefix}:src`, 9, 3, `${prefix}:src`, 16, 'nan', `${prefix}:src`, 27, 0.25);
}

// ============================================================================
// Generic commands
// ============================================================================

describe('generic keyspace commands', () => {
  it('TYPE, SCAN TYPE, OBJECT ENCODING, MEMORY USAGE, EXPIRE', async () => {
    await t.call('TS.ADD', 'ks:a', 1, 1);
    await t.call('SET', 'ks:str', 'x');
    expect(await t.call('TYPE', 'ks:a')).toBe('TSDB-TYPE');
    const [, keys] = (await t.call('SCAN', 0, 'MATCH', 'ks:*', 'TYPE', 'TSDB-TYPE', 'COUNT', 1000)) as [string, string[]];
    expect(keys).toEqual(['ks:a']);
    const [, lower] = (await t.call('SCAN', 0, 'MATCH', 'ks:*', 'TYPE', 'tsdb-type', 'COUNT', 1000)) as [string, string[]];
    expect(lower).toEqual(['ks:a']);
    expect(await t.call('OBJECT', 'ENCODING', 'ks:a')).toBe('raw');
    expect(await t.call('MEMORY', 'USAGE', 'ks:a')).toBeGreaterThan(4096);
    expect(await t.call('PEXPIRE', 'ks:a', 30)).toBe(1);
    await sleep(60);
    expect(await t.call('EXISTS', 'ks:a')).toBe(0);
    expect(await err(t.call('TS.GET', 'ks:a'))).toBe('ERR TSDB: the key does not exist');
  });

  it('WATCH sees writes to a series and to its compaction', async () => {
    await t.call('TS.CREATE', 'ks:w');
    await t.call('TS.CREATE', 'ks:w:agg');
    await t.call('TS.CREATERULE', 'ks:w', 'ks:w:agg', 'AGGREGATION', 'sum', 10);
    await t.call('TS.ADD', 'ks:w', 1, 1);
    const c = t.client();
    await c.watch('ks:w');
    await t.call('TS.ADD', 'ks:w', 2, 1);
    expect(await c.multi().call('TS.GET', 'ks:w').exec()).toBeNull();
    await c.watch('ks:w:agg');
    await t.call('TS.ADD', 'ks:w', 3, 1);
    expect(await c.multi().call('TS.GET', 'ks:w:agg').exec()).toEqual([[null, []]]);
    await c.watch('ks:w:agg');
    // closes bucket 0: the compaction is written
    await t.call('TS.ADD', 'ks:w', 15, 1);
    expect(await c.multi().call('TS.GET', 'ks:w:agg').exec()).toBeNull();
  });

  it('TS commands run inside MULTI and Lua (RESP2 shapes)', async () => {
    const res = await t.redis.multi().call('TS.ADD', 'ks:m', 1, 2).call('TS.RANGE', 'ks:m', '-', '+').exec();
    expect(res).toEqual([[null, 1], [null, [[1, '2']]]]);
    expect(await t.call('EVAL', "return redis.call('TS.GET', KEYS[1])", 1, 'ks:m')).toEqual([1, '2']);
  });
});

// ============================================================================
// Keyspace notifications
// ============================================================================

describe('keyspace notifications', () => {
  it('module events (class d)', async () => {
    await t.call('CONFIG', 'SET', 'notify-keyspace-events', 'Ed');
    const sub = t.client();
    const events: Array<[string, string]> = [];
    sub.on('pmessage', (_p: string, channel: string, key: string) => events.push([channel.replace('__keyevent@0__:', ''), key]));
    await sub.psubscribe('__keyevent@0__:*');
    try {
      await t.call('TS.CREATE', 'ev:a', 'IGNORE', 100, 1, 'DUPLICATE_POLICY', 'LAST');
      await t.call('TS.CREATE', 'ev:b');
      await t.call('TS.ADD', 'ev:a', 1, 1);
      // dropped by IGNORE: no event
      await t.call('TS.ADD', 'ev:a', 2, 1);
      await t.call('TS.MADD', 'ev:a', 500, 1, 'ev:b', 1, 1, 'ev:none', 1, 1);
      await t.call('TS.INCRBY', 'ev:a', 5, 'TIMESTAMP', 600);
      await t.call('TS.DECRBY', 'ev:a', 5, 'TIMESTAMP', 700);
      await t.call('TS.ALTER', 'ev:a', 'RETENTION', 0);
      await t.call('TS.CREATERULE', 'ev:a', 'ev:b', 'AGGREGATION', 'max', 1000);
      await t.call('TS.DELETERULE', 'ev:a', 'ev:b');
      await t.call('TS.DEL', 'ev:a', 0, 1);
      await t.call('TS.DEL', 'ev:a', 0, 1);
      await sleep(50);
      expect(events).toEqual([
        ['ts.create', 'ev:a'],
        ['ts.create', 'ev:b'],
        ['ts.add', 'ev:a'],
        ['ts.add', 'ev:a'],
        ['ts.add', 'ev:b'],
        ['ts.incrby', 'ev:a'],
        ['ts.decrby', 'ev:a'],
        ['ts.alter', 'ev:a'],
        ['ts.createrule:src', 'ev:a'],
        ['ts.createrule:dest', 'ev:b'],
        ['ts.deleterule:src', 'ev:a'],
        ['ts.deleterule:dest', 'ev:b'],
        ['ts.del', 'ev:a'],
      ]);
    } finally {
      await t.call('CONFIG', 'SET', 'notify-keyspace-events', '');
    }
  });
});

// ============================================================================
// DUMP / RESTORE, RDB, AOF
// ============================================================================

describe('persistence', () => {
  it('DUMP / RESTORE round-trips samples, settings, labels and rules', async () => {
    await seed(t.redis, 'dr');
    const before = await t.call('TS.RANGE', 'dr:src', '-', '+');
    const infoBefore = await t.call('TS.INFO', 'dr:src');
    const payload = await t.redis.dumpBuffer('dr:src');
    expect(payload[0]).toBe(7);
    await t.call('DEL', 'dr:src');
    expect(await t.call('RESTORE', 'dr:src', 0, payload)).toBe('OK');
    expect(await t.call('TS.RANGE', 'dr:src', '-', '+')).toEqual(before);
    expect(await t.call('TS.INFO', 'dr:src')).toEqual(infoBefore);
    // the rule is live again: the next bucket closes into dr:dst (the [15, 25) bucket holds only a NaN sample)
    await t.call('TS.ADD', 'dr:src', 40, 1);
    expect(await t.call('TS.RANGE', 'dr:dst', '-', '+')).toEqual([[5, '2'], [15, 'nan'], [25, '0.25']]);
    // under another name: same data, the rule does not follow
    expect(await t.call('RESTORE', 'dr:copy', 0, payload)).toBe('OK');
    expect(await t.call('TS.RANGE', 'dr:copy', '-', '+')).toEqual(before);
    expect(await err(t.call('RESTORE', 'dr:copy', 0, payload))).toBe('BUSYKEY Target key name already exists.');
  });

  it('RESTORE refuses another module type', async () => {
    // type 7, a module id for the name "Other-Typ" (encver 1), EOF
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = 0n;
    for (const ch of 'Other-Typ') id = (id << 6n) | BigInt(charset.indexOf(ch));
    id = (id << 10n) | 1n;
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64BE(id);
    const head = Buffer.concat([Buffer.from([7, 0x81]), idBytes, Buffer.from([0, 12, 0])]);
    const crc = Buffer.alloc(8);
    crc.writeBigUInt64LE(PersistenceService.crc64(head));
    expect(await err(t.call('RESTORE', 'dr:other', 0, Buffer.concat([head, crc])))).toBe('ERR Bad data format');
  });

  it('SAVE + restart and DEBUG RELOAD keep every series and its rules', async () => {
    const dir = tempDir();
    let before: unknown;
    await withServer({ dir, save: '' }, async (r) => {
      await seed(r, 'rdb');
      before = [await r.call('TS.RANGE', 'rdb:src', '-', '+'), await r.call('TS.INFO', 'rdb:src'), await r.call('TS.INFO', 'rdb:dst')];
      expect(await r.call('DEBUG', 'RELOAD')).toBe('OK');
      expect([await r.call('TS.RANGE', 'rdb:src', '-', '+'), await r.call('TS.INFO', 'rdb:src'), await r.call('TS.INFO', 'rdb:dst')]).toEqual(before);
      expect(await r.call('SAVE')).toBe('OK');
    });
    await withServer({ dir, save: '' }, async (r) => {
      expect([await r.call('TS.RANGE', 'rdb:src', '-', '+'), await r.call('TS.INFO', 'rdb:src'), await r.call('TS.INFO', 'rdb:dst')]).toEqual(before);
      await r.call('TS.ADD', 'rdb:src', 40, 1);
      expect(await r.call('TS.RANGE', 'rdb:dst', '-', '+')).toEqual([[5, '2'], [15, 'nan'], [25, '0.25']]);
    });
  });

  it('AOF: `*` timestamps are propagated resolved, and the AOF replays to the same data', async () => {
    const dir = tempDir();
    let before: unknown;
    await withServer({ dir, appendonly: true, save: '' }, async (r) => {
      await r.call('TS.CREATE', 'aof:a', 'LABELS', 'x', '1');
      await r.call('TS.CREATE', 'aof:b');
      await r.call('TS.CREATERULE', 'aof:a', 'aof:b', 'AGGREGATION', 'count', 1000);
      const ts = (await r.call('TS.ADD', 'aof:a', '*', 1)) as number;
      await sleep(5);
      const [m1, m2] = (await r.call('TS.MADD', 'aof:a', '*', 2, 'aof:a', 1, 3)) as number[];
      const inc = (await r.call('TS.INCRBY', 'aof:a', 10, 'RETENTION', 0)) as number;
      await r.call('TS.ADD', 'aof:a', inc + 5000, 1);
      const cmds = aofCommands(dir).filter((c) => c[0].toLowerCase().startsWith('ts.'));
      expect(cmds).toEqual([
        ['TS.CREATE', 'aof:a', 'LABELS', 'x', '1'],
        ['TS.CREATE', 'aof:b'],
        ['TS.CREATERULE', 'aof:a', 'aof:b', 'AGGREGATION', 'count', '1000'],
        ['TS.ADD', 'aof:a', String(ts), '1'],
        ['TS.MADD', 'aof:a', String(m1), '2', 'aof:a', String(m2), '3'],
        ['TS.INCRBY', 'aof:a', '10', 'TIMESTAMP', String(inc), 'RETENTION', '0'],
        ['TS.ADD', 'aof:a', String(inc + 5000), '1'],
      ]);
      before = [await r.call('TS.RANGE', 'aof:a', '-', '+'), await r.call('TS.RANGE', 'aof:b', '-', '+')];
    });
    await withServer({ dir, appendonly: true, save: '' }, async (r) => {
      expect([await r.call('TS.RANGE', 'aof:a', '-', '+'), await r.call('TS.RANGE', 'aof:b', '-', '+')]).toEqual(before);
    });
  });

  it('AOF rewrite without the RDB preamble restores the series', async () => {
    const dir = tempDir();
    let before: unknown;
    await withServer({ dir, appendonly: true, save: '', config: { 'aof-use-rdb-preamble': 'no' } }, async (r) => {
      await seed(r, 'rw');
      await r.call('PEXPIREAT', 'rw:dst', Date.now() + 3600000);
      before = [await r.call('TS.INFO', 'rw:src'), await r.call('TS.RANGE', 'rw:src', '-', '+'), await r.call('TS.INFO', 'rw:dst')];
      expect(await r.call('BGREWRITEAOF')).toBe('Background append only file rewriting started');
      for (let i = 0; i < 100 && (await r.info('persistence')).includes('aof_rewrite_in_progress:1'); i++) await sleep(10);
    });
    await withServer({ dir, appendonly: true, save: '' }, async (r) => {
      expect([await r.call('TS.INFO', 'rw:src'), await r.call('TS.RANGE', 'rw:src', '-', '+'), await r.call('TS.INFO', 'rw:dst')]).toEqual(before);
      expect(await r.pttl('rw:dst')).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// COMMAND metadata and ACL
// ============================================================================

describe('COMMAND and ACL', () => {
  it('COMMAND INFO / DOCS / LIST FILTERBY MODULE / GETKEYS', async () => {
    const [info] = (await t.call('COMMAND', 'INFO', 'ts.madd')) as unknown[][];
    expect(info.slice(0, 7)).toEqual(['ts.madd', -4, ['write', 'denyoom', 'module'], 1, -3, 3, ['@write', '@slow', '@timeseries']]);
    const docs = (await t.call('COMMAND', 'DOCS', 'ts.range')) as unknown[];
    const fields = docs[1] as unknown[];
    expect(fields.slice(0, 4)).toEqual(['summary', 'Query a range in forward direction', 'since', '1.0.0']);
    expect(fields[fields.indexOf('group') + 1]).toBe('module');
    expect(fields[fields.lastIndexOf('module') + 1]).toBe('timeseries');
    const list = (await t.call('COMMAND', 'LIST', 'FILTERBY', 'MODULE', 'timeseries')) as string[];
    expect(list.sort()).toEqual([
      'ts.add', 'ts.alter', 'ts.create', 'ts.createrule', 'ts.decrby', 'ts.del', 'ts.deleterule', 'ts.get', 'ts.incrby', 'ts.info',
      'ts.madd', 'ts.mget', 'ts.mrange', 'ts.mrevrange', 'ts.queryindex', 'ts.range', 'ts.revrange',
    ]);
    expect(await t.call('COMMAND', 'GETKEYS', 'TS.MADD', 'a', 1, 1, 'b', 2, 2)).toEqual(['a', 'b']);
    expect(await t.call('COMMAND', 'GETKEYS', 'TS.CREATERULE', 'a', 'b', 'AGGREGATION', 'avg', 10)).toEqual(['a', 'b']);
  });

  it('ACL @timeseries', async () => {
    const cat = (await t.call('ACL', 'CAT', 'timeseries')) as string[];
    expect(cat).toEqual(expect.arrayContaining(['ts.add', 'ts.range', 'ts.mrange', 'ts.info']));
    await t.call('ACL', 'SETUSER', 'tsreader', 'on', '>pw', '~*', '+@timeseries', '-@write');
    const c = t.client();
    await c.call('AUTH', 'tsreader', 'pw');
    await t.call('TS.ADD', 'acl:a', 1, 1);
    expect(await c.call('TS.GET', 'acl:a')).toEqual([1, '1']);
    expect(await err(c.call('TS.ADD', 'acl:a', 2, 2))).toMatch(/^NOPERM User tsreader has no permissions to run the 'ts.add' command/);
    expect(await err(c.call('GET', 'acl:a'))).toMatch(/^NOPERM/);
  });
});
