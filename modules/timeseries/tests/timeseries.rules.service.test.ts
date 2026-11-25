/**
 * TS.CREATERULE / TS.DELETERULE and compaction (timeseries.rules.service + the ingest path): bucket closing, alignment,
 * LATEST, late samples and TS.DEL re-aggregation, rule lifetime across DEL / RENAME, ts-compaction-policy.
 * Expectations follow the redis.io TS.CREATERULE / TS.GET LATEST examples and the documented compaction semantics
 * (only samples added after the rule are aggregated; a bucket is written when it closes).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import { err, useServer } from '@/tests/helpers';

const t = useServer();

const range = (key: string, ...opts: Array<string | number>): Promise<unknown> => t.call('TS.RANGE', key, '-', '+', ...opts);

async function info(key: string): Promise<Record<string, unknown>> {
  const flat = (await t.call('TS.INFO', key)) as unknown[];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < flat.length; i += 2) out[String(flat[i])] = flat[i + 1];
  return out;
}

async function pair(src: string, dst: string, aggregator: string, bucket: number, align?: number): Promise<void> {
  await t.call('TS.CREATE', src);
  await t.call('TS.CREATE', dst);
  const extra = align === undefined ? [] : [align];
  expect(await t.call('TS.CREATERULE', src, dst, 'AGGREGATION', aggregator, bucket, ...extra)).toBe('OK');
}

// ============================================================================
// Compaction
// ============================================================================

describe('compaction', () => {
  it('writes a bucket when a sample lands in a later bucket; LATEST reports the open one', async () => {
    await pair('c:src', 'c:dst', 'sum', 10);
    for (const [ts, v] of [[1, 1], [5, 2]]) await t.call('TS.ADD', 'c:src', ts, v);
    expect(await range('c:dst')).toEqual([]);
    await t.call('TS.ADD', 'c:src', 12, 3);
    expect(await range('c:dst')).toEqual([[0, '3']]);
    await t.call('TS.ADD', 'c:src', 15, 4);
    await t.call('TS.ADD', 'c:src', 30, 5);
    // bucket 20 had no samples: nothing is written for it
    expect(await range('c:dst')).toEqual([[0, '3'], [10, '7']]);
    expect(await t.call('TS.GET', 'c:dst')).toEqual([10, '7']);
    expect(await t.call('TS.GET', 'c:dst', 'LATEST')).toEqual([30, '5']);
    expect(await range('c:dst', 'LATEST')).toEqual([[0, '3'], [10, '7'], [30, '5']]);
    expect(await t.call('TS.REVRANGE', 'c:dst', '-', '+', 'LATEST', 'COUNT', 1)).toEqual([[30, '5']]);
    expect(await t.call('TS.RANGE', 'c:dst', 0, 29, 'LATEST')).toEqual([[0, '3'], [10, '7']]);
    // LATEST on a series that is not a compaction is the plain newest sample
    expect(await t.call('TS.GET', 'c:src', 'LATEST')).toEqual([30, '5']);
  });

  it('twa compaction and TS.GET LATEST (docs example)', async () => {
    await t.call('TS.CREATE', 'temp:TLV', 'LABELS', 'type', 'temp', 'location', 'TLV');
    await t.call('TS.CREATE', 'dailyAvgTemp:TLV', 'LABELS', 'type', 'temp', 'location', 'TLV');
    await t.call('TS.CREATERULE', 'temp:TLV', 'dailyAvgTemp:TLV', 'AGGREGATION', 'twa', 86400000);
    await t.call('TS.MADD', 'temp:TLV', 1000, 30, 'temp:TLV', 1010, 35, 'temp:TLV', 1020, 9999, 'temp:TLV', 1030, 40);
    expect(await t.call('TS.GET', 'dailyAvgTemp:TLV')).toEqual([]);
    // the area under (1000,30)(1010,35)(1020,9999)(1030,40), over the 30 ms it spans
    expect(await t.call('TS.GET', 'dailyAvgTemp:TLV', 'LATEST')).toEqual([0, String((325 + 50170 + 50195) / 30)]);
    expect(await t.call('TS.MGET', 'LATEST', 'FILTER', 'location=TLV')).toEqual([
      ['dailyAvgTemp:TLV', [], [0, String((325 + 50170 + 50195) / 30)]],
      ['temp:TLV', [], [1030, '40']],
    ]);
  });

  it('only samples added after TS.CREATERULE are aggregated', async () => {
    await t.call('TS.ADD', 'c:pre', 0, 100);
    await t.call('TS.CREATE', 'c:pre:avg');
    await t.call('TS.CREATERULE', 'c:pre', 'c:pre:avg', 'AGGREGATION', 'avg', 10);
    await t.call('TS.ADD', 'c:pre', 5, 1);
    await t.call('TS.ADD', 'c:pre', 10, 2);
    expect(await range('c:pre:avg')).toEqual([[0, '1']]);
  });

  it('alignTimestamp shifts the buckets (docs: range over aligned days, scaled down)', async () => {
    await pair('c:al', 'c:al:range', 'range', 10, 3);
    for (const [ts, v] of [[3, 5], [8, 9], [12, 1], [13, 10], [23, 0]]) await t.call('TS.ADD', 'c:al', ts, v);
    expect(await range('c:al:range')).toEqual([[3, '8'], [13, '0']]);
    expect((await info('c:al')).rules).toEqual([['c:al:range', 10, 'RANGE', 3]]);
  });

  it('late samples and updates re-aggregate closed buckets', async () => {
    await pair('c:late', 'c:late:sum', 'sum', 10);
    await t.call('TS.MADD', 'c:late', 1, 1, 'c:late', 11, 1, 'c:late', 21, 1);
    expect(await range('c:late:sum')).toEqual([[0, '1'], [10, '1']]);
    await t.call('TS.ADD', 'c:late', 5, 10);
    expect(await range('c:late:sum')).toEqual([[0, '11'], [10, '1']]);
    await t.call('TS.ADD', 'c:late', 11, 5, 'ON_DUPLICATE', 'LAST');
    expect(await range('c:late:sum')).toEqual([[0, '11'], [10, '5']]);
    // a sample in the open bucket changes only LATEST
    await t.call('TS.ADD', 'c:late', 22, 2);
    expect(await range('c:late:sum')).toEqual([[0, '11'], [10, '5']]);
    expect(await t.call('TS.GET', 'c:late:sum', 'LATEST')).toEqual([20, '3']);
  });

  it('TS.DEL re-aggregates or removes the compacted buckets it touched', async () => {
    await pair('c:del', 'c:del:sum', 'sum', 10);
    await t.call('TS.MADD', 'c:del', 1, 1, 'c:del', 2, 2, 'c:del', 11, 4, 'c:del', 21, 8, 'c:del', 31, 16);
    expect(await range('c:del:sum')).toEqual([[0, '3'], [10, '4'], [20, '8']]);
    expect(await t.call('TS.DEL', 'c:del', 2, 2)).toBe(1);
    expect(await range('c:del:sum')).toEqual([[0, '1'], [10, '4'], [20, '8']]);
    expect(await t.call('TS.DEL', 'c:del', 10, 19)).toBe(1);
    expect(await range('c:del:sum')).toEqual([[0, '1'], [20, '8']]);
    // deleting the newest samples re-opens the bucket of the new newest sample
    expect(await t.call('TS.DEL', 'c:del', 30, 40)).toBe(1);
    expect(await range('c:del:sum')).toEqual([[0, '1']]);
    expect(await t.call('TS.GET', 'c:del:sum', 'LATEST')).toEqual([20, '8']);
  });

  it('a source feeds several destinations', async () => {
    await t.call('TS.CREATE', 'c:multi');
    for (const [dst, a] of [['c:multi:min', 'min'], ['c:multi:max', 'max'], ['c:multi:count', 'count']]) {
      await t.call('TS.CREATE', dst);
      await t.call('TS.CREATERULE', 'c:multi', dst, 'AGGREGATION', a, 100);
    }
    await t.call('TS.MADD', 'c:multi', 10, 4, 'c:multi', 20, -2, 'c:multi', 50, 9, 'c:multi', 100, 0);
    expect(await range('c:multi:min')).toEqual([[0, '-2']]);
    expect(await range('c:multi:max')).toEqual([[0, '9']]);
    expect(await range('c:multi:count')).toEqual([[0, '3']]);
    expect(((await info('c:multi')).rules as unknown[]).length).toBe(3);
  });
});

// ============================================================================
// Rule lifetime and errors
// ============================================================================

describe('TS.CREATERULE / TS.DELETERULE', () => {
  it('TS.INFO shows both sides; TS.DELETERULE stops the compaction', async () => {
    await pair('r:src', 'r:dst', 'avg', 60000);
    expect((await info('r:src')).rules).toEqual([['r:dst', 60000, 'AVG', 0]]);
    expect((await info('r:dst')).sourceKey).toBe('r:src');
    expect(await t.call('TS.DELETERULE', 'r:src', 'r:dst')).toBe('OK');
    expect((await info('r:src')).rules).toEqual([]);
    expect((await info('r:dst')).sourceKey).toBeNull();
    await t.call('TS.MADD', 'r:src', 1, 1, 'r:src', 60001, 1);
    expect(await range('r:dst')).toEqual([]);
    expect(await err(t.call('TS.DELETERULE', 'r:src', 'r:dst'))).toBe('ERR TSDB: compaction rule does not exist');
  });

  it('errors', async () => {
    await t.call('TS.CREATE', 'r:a');
    await t.call('TS.CREATE', 'r:b');
    await t.call('TS.CREATE', 'r:c');
    expect(await err(t.call('TS.CREATERULE', 'r:a', 'r:a', 'AGGREGATION', 'avg', 10))).toBe(
      'ERR TSDB: the source key and destination key should be different',
    );
    expect(await err(t.call('TS.CREATERULE', 'r:a', 'r:none', 'AGGREGATION', 'avg', 10))).toBe('ERR TSDB: the key does not exist');
    expect(await err(t.call('TS.CREATERULE', 'r:a', 'r:b', 'AGGREGATION', 'avg', 0))).toBe('ERR TSDB: bucketDuration must be greater than zero');
    expect(await err(t.call('TS.CREATERULE', 'r:a', 'r:b', 'AGGREGATION', 'mean', 10))).toBe('ERR TSDB: Unknown aggregation type');
    expect(await err(t.call('TS.CREATERULE', 'r:a', 'r:b', 'AGGR', 'avg', 10))).toBe("ERR TSDB: Couldn't parse AGGREGATION");
    expect(await t.call('TS.CREATERULE', 'r:a', 'r:b', 'AGGREGATION', 'avg', 10)).toBe('OK');
    expect(await err(t.call('TS.CREATERULE', 'r:c', 'r:b', 'AGGREGATION', 'avg', 10))).toBe('ERR TSDB: the destination key already has a src rule');
    expect(await err(t.call('TS.CREATERULE', 'r:b', 'r:c', 'AGGREGATION', 'avg', 10))).toBe('ERR TSDB: the source key already has a source rule');
    expect(await err(t.call('TS.CREATERULE', 'r:c', 'r:a', 'AGGREGATION', 'avg', 10))).toBe('ERR TSDB: the destination key already has a dst rule');
    await t.call('SET', 'r:str', 'x');
    expect(await err(t.call('TS.CREATERULE', 'r:a', 'r:str', 'AGGREGATION', 'avg', 10))).toBe(
      'WRONGTYPE Operation against a key holding the wrong kind of value',
    );
    expect(await err(t.call('TS.DELETERULE', 'r:a', 'r:c'))).toBe('ERR TSDB: compaction rule does not exist');
  });

  it('deleting the destination ends the rule; deleting the source frees the destination', async () => {
    await pair('r:s1', 'r:d1', 'max', 10);
    await t.call('DEL', 'r:d1');
    expect((await info('r:s1')).rules).toEqual([]);
    await t.call('TS.MADD', 'r:s1', 1, 1, 'r:s1', 20, 1);
    await t.call('TS.CREATE', 'r:d1');
    expect(await range('r:d1')).toEqual([]);
    await pair('r:s2', 'r:d2', 'max', 10);
    await t.call('DEL', 'r:s2');
    expect((await info('r:d2')).sourceKey).toBeNull();
    await t.call('TS.CREATE', 'r:s3');
    expect(await t.call('TS.CREATERULE', 'r:s3', 'r:d2', 'AGGREGATION', 'min', 10)).toBe('OK');
  });

  it('RENAME of either side keeps the rule', async () => {
    await pair('r:old', 'r:olddst', 'sum', 10);
    await t.call('RENAME', 'r:old', 'r:new');
    expect((await info('r:olddst')).sourceKey).toBe('r:new');
    await t.call('RENAME', 'r:olddst', 'r:newdst');
    expect((await info('r:new')).rules).toEqual([['r:newdst', 10, 'SUM', 0]]);
    await t.call('TS.MADD', 'r:new', 1, 2, 'r:new', 11, 3);
    expect(await range('r:newdst')).toEqual([[0, '2']]);
  });

  it('COPY gives an independent series without rules', async () => {
    await pair('r:cs', 'r:cd', 'sum', 10);
    await t.call('TS.MADD', 'r:cs', 1, 2, 'r:cs', 11, 3);
    expect(await t.call('COPY', 'r:cs', 'r:cs2')).toBe(1);
    expect(await t.call('COPY', 'r:cd', 'r:cd2')).toBe(1);
    expect((await info('r:cs2')).rules).toEqual([]);
    expect((await info('r:cd2')).sourceKey).toBeNull();
    expect(await range('r:cs2')).toEqual([[1, '2'], [11, '3']]);
    await t.call('TS.ADD', 'r:cs2', 30, 1);
    expect(await range('r:cs')).toEqual([[1, '2'], [11, '3']]);
  });
});

// ============================================================================
// ts-compaction-policy
// ============================================================================

describe('ts-compaction-policy', () => {
  it('creates the compactions of every new series', async () => {
    expect(await t.call('CONFIG', 'SET', 'ts-compaction-policy', 'max:10ms:0;avg:1s:1h')).toBe('OK');
    try {
      await t.call('TS.CREATE', 'p:temp', 'LABELS', 'room', 'kitchen');
      expect((await info('p:temp')).rules).toEqual([
        ['p:temp_MAX_10', 10, 'MAX', 0],
        ['p:temp_AVG_1000', 1000, 'AVG', 0],
      ]);
      const avg = await info('p:temp_AVG_1000');
      expect(avg.retentionTime).toBe(3600000);
      expect(avg.sourceKey).toBe('p:temp');
      expect(avg.labels).toEqual([['room', 'kitchen']]);
      await t.call('TS.MADD', 'p:temp', 1, 5, 'p:temp', 4, 7, 'p:temp', 12, 1);
      expect(await range('p:temp_MAX_10')).toEqual([[0, '7']]);
      // TS.ADD creating a key applies the policy too
      await t.call('TS.ADD', 'p:auto', 1, 1);
      expect(await t.call('EXISTS', 'p:auto_MAX_10', 'p:auto_AVG_1000')).toBe(2);
    } finally {
      await t.call('CONFIG', 'SET', 'ts-compaction-policy', '');
    }
    await t.call('TS.CREATE', 'p:none');
    expect((await info('p:none')).rules).toEqual([]);
  });

  it('CONFIG SET validates the policy', async () => {
    expect(await err(t.call('CONFIG', 'SET', 'ts-compaction-policy', 'max:10x:0'))).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'ts-compaction-policy') - Invalid compaction policy",
    );
    expect(await err(t.call('CONFIG', 'SET', 'ts-compaction-policy', 'median:1m:1d'))).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'ts-compaction-policy') - Invalid compaction policy",
    );
    expect(await t.call('CONFIG', 'GET', 'ts-compaction-policy')).toEqual(['ts-compaction-policy', '']);
  });
});
