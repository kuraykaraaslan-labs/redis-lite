/**
 * The label index (timeseries.index, timeseries.index.structure): TS.QUERYINDEX / TS.MGET / TS.MRANGE answers equal a
 * brute-force scan of the keyspace on randomized label sets while series are created, relabeled, overwritten, renamed,
 * copied, moved, restored, deleted, expired, flushed, swapped and reloaded; and a selective filter stays fast with many
 * series.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import Redis from 'ioredis';

import { RedisLite } from '@/index';
import { sleep, tempDir, useServer } from '@/tests/helpers';

const t = useServer();

// ============================================================================
// Helpers
// ============================================================================

const LABELS = ['host', 'region', 'kind', 'tier'];
const VALUES = ['a', 'b', 'c'];
const KEYS = Array.from({ length: 40 }, (_, i) => `s:${i}`);

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

type Matcher = { label: string; negate: boolean; values: string[] };

/** The documented FILTER semantics, written independently of the server's code. */
function matches(labels: Map<string, string>, filter: Matcher[]): boolean {
  return filter.every(({ label, negate, values }) => {
    const v = labels.get(label);
    if (!values.length) return negate ? v !== undefined : v === undefined;
    return negate ? v === undefined || !values.includes(v) : v !== undefined && values.includes(v);
  });
}

function expr({ label, negate, values }: Matcher): string {
  const op = negate ? '!=' : '=';
  if (values.length === 1) return `${label}${op}${values[0]}`;
  return values.length ? `${label}${op}(${values.join(',')})` : `${label}${op}`;
}

function randomFilter(rnd: () => number): Matcher[] {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const some = (): string[] => VALUES.filter(() => rnd() < 0.5);
  const first = some();
  const out: Matcher[] = [{ label: pick(LABELS), negate: false, values: first.length ? first : [pick(VALUES)] }];
  for (let n = Math.floor(rnd() * 3); n > 0; n--) out.push({ label: pick(LABELS), negate: rnd() < 0.5, values: rnd() < 0.3 ? [] : some() });
  return out;
}

function randomLabels(rnd: () => number): string[] {
  const out: string[] = [];
  for (const label of LABELS) if (rnd() < 0.6) out.push(label, VALUES[Math.floor(rnd() * VALUES.length)]);
  return out;
}

/** Every series of the connection's database with its labels, read key by key (KEYS + TYPE + TS.INFO). */
async function scan(r: Redis): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  for (const key of (await r.keys('*')).sort()) {
    if ((await r.type(key)) !== 'TSDB-TYPE') continue;
    const info = (await r.call('TS.INFO', key)) as unknown[];
    const pairs = info[info.indexOf('labels') + 1] as Array<[string, string]>;
    out.set(key, new Map(pairs));
  }
  return out;
}

/** Compares the index-backed commands with the brute-force answer for a few random filters. */
async function check(r: Redis, rnd: () => number, round: number): Promise<void> {
  const all = await scan(r);
  for (let n = 0; n < 6; n++) {
    const filter = randomFilter(rnd);
    const exprs = filter.map(expr);
    const expected = [...all].filter(([, labels]) => matches(labels, filter)).map(([key]) => key);
    const context = `round ${round}, FILTER ${exprs.join(' ')}`;
    expect(await r.call('TS.QUERYINDEX', ...exprs), context).toEqual(expected);
    const mget = (await r.call('TS.MGET', 'FILTER', ...exprs)) as Array<[string]>;
    expect(mget.map(([key]) => key), context).toEqual(expected);
    const mrange = (await r.call('TS.MREVRANGE', '-', '+', 'FILTER', ...exprs)) as Array<[string]>;
    expect(mrange.map(([key]) => key), context).toEqual(expected);
  }
}

// ============================================================================
// Equivalence with a scan
// ============================================================================

describe('label index equivalence', () => {
  it('matches a brute-force scan through every kind of keyspace change', async () => {
    const rnd = prng(20261125);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    const db0 = t.redis;
    const db1 = t.client();
    await db1.select(1);
    await db0.flushall();
    // COPY / RESTORE / DEBUG RELOAD build series the index was not told about (it then rebuilds): they stay rare, so
    // most checks run on an index kept up to date by the module's own upkeep alone
    for (let round = 0; round < 120; round++) {
      for (let n = 0; n < 4; n++) {
        const r = rnd() < 0.75 ? db0 : db1;
        const key = pick(KEYS);
        const other = pick(KEYS);
        const op = rnd() * 100;
        if (op < 30) await r.call('TS.CREATE', key, 'LABELS', ...randomLabels(rnd)).catch(() => undefined);
        else if (op < 40) await r.call('TS.ADD', key, '*', 1, 'LABELS', ...randomLabels(rnd)).catch(() => undefined);
        else if (op < 50) await r.call('TS.ALTER', key, 'LABELS', ...randomLabels(rnd)).catch(() => undefined);
        else if (op < 58) await r.call(pick(['DEL', 'UNLINK']), key);
        else if (op < 70) await r.call(pick(['RENAME', 'RENAMENX']), key, other).catch(() => undefined);
        else if (op < 78) await r.call('MOVE', key, r === db0 ? 1 : 0).catch(() => undefined);
        else if (op < 84) await r.call('PEXPIRE', key, 1);
        else if (op < 89) await r.call('SET', key, 'not a series');
        else if (op < 94) await r.call('SWAPDB', 0, 1);
        else if (op < 96) await r.call('COPY', key, other, ...(rnd() < 0.5 ? ['DB', '1'] : []), 'REPLACE').catch(() => undefined);
        else if (op < 98) {
          const dump = (await r.callBuffer('DUMP', key)) as Buffer | null;
          if (dump) await r.call('RESTORE', other, 0, dump, 'REPLACE');
        } else if (op < 99.3) await r.call(pick(['FLUSHDB', 'FLUSHALL']));
      }
      if (round % 40 === 39) expect(await db0.call('DEBUG', 'RELOAD')).toBe('OK');
      await sleep(3); // PEXPIRE 1 keys are expired, not reclaimed
      await check(db0, rnd, round);
      await check(db1, rnd, round);
    }
  }, 60000);

  it('keeps answering after the same names hold different series in two databases', async () => {
    const db1 = t.client();
    await db1.select(1);
    await t.call('FLUSHALL');
    await t.call('TS.CREATE', 'x', 'LABELS', 'k', 'v0');
    await db1.call('TS.CREATE', 'x', 'LABELS', 'k', 'v1');
    expect(await t.call('TS.QUERYINDEX', 'k=v0')).toEqual(['x']);
    expect(await t.call('TS.QUERYINDEX', 'k=v1')).toEqual([]);
    await t.call('SWAPDB', 0, 1);
    expect(await t.call('TS.QUERYINDEX', 'k=v0')).toEqual([]);
    expect(await t.call('TS.QUERYINDEX', 'k=v1')).toEqual(['x']);
    expect(await db1.call('TS.QUERYINDEX', 'k=v0')).toEqual(['x']);
    await db1.call('RENAME', 'x', 'y');
    expect(await db1.call('TS.QUERYINDEX', 'k=v0')).toEqual(['y']);
    await db1.call('MOVE', 'y', 0);
    expect(await t.call('TS.QUERYINDEX', 'k=(v0,v1)')).toEqual(['x', 'y']);
    expect(await db1.call('TS.QUERYINDEX', 'k=(v0,v1)')).toEqual([]);
  });
});

// ============================================================================
// Scale
// ============================================================================

describe('label index at scale', () => {
  it('answers a selective filter over 50k series without scanning them', async () => {
    const server = await RedisLite.start({ port: 0, dir: tempDir(), save: '' });
    const r = new Redis(server.url, { maxRetriesPerRequest: null });
    try {
      const SERIES = 50000;
      for (let start = 0; start < SERIES; start += 5000) {
        const p = r.pipeline();
        for (let i = start; i < start + 5000; i++) {
          p.call('TS.CREATE', `metric:${i}`, 'LABELS', 'id', String(i), 'shard', String(i % 1000), 'kind', i % 2 ? 'odd' : 'even');
          p.call('TS.ADD', `metric:${i}`, 1000, i);
        }
        await p.exec();
      }
      // first query: the index is built from the keyspace once
      expect(await r.call('TS.QUERYINDEX', 'shard=7')).toHaveLength(50);
      const QUERIES = 200;
      const begin = performance.now();
      for (let q = 0; q < QUERIES; q++) {
        const reply = (await r.call('TS.MGET', 'FILTER', `shard=${q % 1000}`, 'kind=odd')) as unknown[];
        expect(reply).toHaveLength(q % 2 ? 50 : 0);
      }
      const perQuery = (performance.now() - begin) / QUERIES;
      // a scan of the 50k keys took about 21 ms per query; the index about 1 ms (the round trip included)
      expect(perQuery).toBeLessThan(8);
      // a DEL / RENAME on the way keeps the answers exact
      await r.call('DEL', 'metric:7');
      await r.call('RENAME', 'metric:1007', 'renamed:1007');
      const keys = (await r.call('TS.QUERYINDEX', 'shard=7', 'id=(7,1007,2007)')) as string[];
      expect(keys).toEqual(['metric:2007', 'renamed:1007']);
    } finally {
      r.disconnect();
      await server.close();
    }
  }, 120000);
});
