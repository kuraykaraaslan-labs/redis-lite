/**
 * TS.CREATE, TS.ADD, TS.MADD, TS.INCRBY / TS.DECRBY, TS.DEL (timeseries.ingest.service).
 * Expected values come from the redis.io TS.* command pages and the time series concepts docs.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import { arity, err, SYNTAX, useServer, WRONGTYPE } from '@/tests/helpers';

const t = useServer();

const range = (key: string, ...opts: Array<string | number>): Promise<unknown> => t.call('TS.RANGE', key, '-', '+', ...opts);

// ============================================================================
// TS.CREATE
// ============================================================================

describe('TS.CREATE', () => {
  it('creates an empty series of type TSDB-TYPE (docs example)', async () => {
    expect(await t.call('TS.CREATE', 'temperature:2:32', 'RETENTION', 60000, 'DUPLICATE_POLICY', 'MAX', 'LABELS', 'sensor_id', 2, 'area_id', 32)).toBe('OK');
    expect(await t.call('TYPE', 'temperature:2:32')).toBe('TSDB-TYPE');
    expect(await t.call('EXISTS', 'temperature:2:32')).toBe(1);
    expect(await t.call('TS.GET', 'temperature:2:32')).toEqual([]);
  });

  it('refuses an existing key of any type', async () => {
    await t.call('TS.CREATE', 'in:dup');
    expect(await err(t.call('TS.CREATE', 'in:dup'))).toBe('ERR TSDB: key already exists');
    await t.call('SET', 'in:str', 'x');
    expect(await err(t.call('TS.CREATE', 'in:str'))).toBe('ERR TSDB: key already exists');
  });

  it('validates its options', async () => {
    expect(await err(t.call('TS.CREATE', 'in:o', 'RETENTION', -1))).toBe("ERR TSDB: Couldn't parse RETENTION");
    expect(await err(t.call('TS.CREATE', 'in:o', 'RETENTION'))).toBe("ERR TSDB: Couldn't parse RETENTION");
    expect(await err(t.call('TS.CREATE', 'in:o', 'CHUNK_SIZE', 'x'))).toBe("ERR TSDB: Couldn't parse CHUNK_SIZE");
    expect(await err(t.call('TS.CREATE', 'in:o', 'CHUNK_SIZE', 47))).toBe('ERR TSDB: CHUNK_SIZE value must be a multiple of 8 in the range [48 .. 1048576]');
    expect(await err(t.call('TS.CREATE', 'in:o', 'CHUNK_SIZE', 100))).toBe('ERR TSDB: CHUNK_SIZE value must be a multiple of 8 in the range [48 .. 1048576]');
    expect(await err(t.call('TS.CREATE', 'in:o', 'CHUNK_SIZE', 1048584))).toBe('ERR TSDB: CHUNK_SIZE value must be a multiple of 8 in the range [48 .. 1048576]');
    expect(await err(t.call('TS.CREATE', 'in:o', 'ENCODING', 'ZIP'))).toBe('ERR TSDB: unknown ENCODING parameter');
    expect(await err(t.call('TS.CREATE', 'in:o', 'DUPLICATE_POLICY', 'NEWEST'))).toBe('ERR TSDB: Unknown DUPLICATE_POLICY');
    expect(await err(t.call('TS.CREATE', 'in:o', 'IGNORE', 10))).toBe("ERR TSDB: Couldn't parse IGNORE");
    expect(await err(t.call('TS.CREATE', 'in:o', 'IGNORE', 10, -1))).toBe("ERR TSDB: Couldn't parse IGNORE");
    expect(await err(t.call('TS.CREATE', 'in:o', 'LABELS', 'a'))).toBe("ERR TSDB: Couldn't parse LABELS");
    expect(await err(t.call('TS.CREATE', 'in:o', 'NOPE'))).toBe(SYNTAX);
    expect(await err(t.call('TS.CREATE'))).toBe(arity('ts.create'));
    expect(await t.call('EXISTS', 'in:o')).toBe(0);
  });

  it('accepts options in any order, case-insensitively', async () => {
    expect(await t.call('TS.CREATE', 'in:any', 'labels', 'a', '1', 'retention', 5)).toBe('OK');
    expect(await t.call('TS.CREATE', 'in:any2', 'ENCODING', 'uncompressed', 'CHUNK_SIZE', 128, 'IGNORE', 5, 0.5)).toBe('OK');
    const info = (await t.call('TS.INFO', 'in:any2')) as unknown[];
    expect(info[info.indexOf('chunkType') + 1]).toBe('uncompressed');
    expect(info[info.indexOf('chunkSize') + 1]).toBe(128);
    expect(info[info.indexOf('ignoreMaxTimeDiff') + 1]).toBe(5);
    expect(info[info.indexOf('ignoreMaxValDiff') + 1]).toBe('0.5');
  });
});

// ============================================================================
// TS.ADD
// ============================================================================

describe('TS.ADD', () => {
  it('appends samples and creates the key with the given options (docs example)', async () => {
    expect(await t.call('TS.ADD', 'temperature:3:11', 1548149183000, 27, 'RETENTION', 31536000000)).toBe(1548149183000);
    const before = Date.now();
    const ts = (await t.call('TS.ADD', 'temperature:3:11', '*', 30)) as number;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
    expect(await t.call('TS.GET', 'temperature:3:11')).toEqual([ts, '30']);
    const info = (await t.call('TS.INFO', 'temperature:3:11')) as unknown[];
    expect(info[info.indexOf('retentionTime') + 1]).toBe(31536000000);
  });

  it('keeps samples ordered whatever the arrival order', async () => {
    for (const [ts, v] of [[30, 3], [10, 1], [20, 2], [40, 4], [5, 0.5]]) await t.call('TS.ADD', 'in:order', ts, v);
    expect(await range('in:order')).toEqual([[5, '0.5'], [10, '1'], [20, '2'], [30, '3'], [40, '4']]);
  });

  it('validates the timestamp first, then the value', async () => {
    expect(await err(t.call('TS.ADD', 'in:bad', -1, 1))).toBe('ERR TSDB: invalid timestamp, must be a nonnegative integer');
    expect(await err(t.call('TS.ADD', 'in:bad', 'x', 'y'))).toBe('ERR TSDB: invalid timestamp, must be a nonnegative integer');
    expect(await err(t.call('TS.ADD', 'in:bad', 1.5, 1))).toBe('ERR TSDB: invalid timestamp, must be a nonnegative integer');
    expect(await err(t.call('TS.ADD', 'in:bad', 1, 'abc'))).toBe('ERR TSDB: invalid value');
    expect(await err(t.call('TS.ADD', 'in:bad', 1, 1, 'ON_DUPLICATE', 'x'))).toBe('ERR TSDB: Unknown ON_DUPLICATE');
    expect(await err(t.call('TS.ADD', 'in:bad', 1))).toBe(arity('ts.add'));
    expect(await t.call('EXISTS', 'in:bad')).toBe(0);
  });

  it('answers WRONGTYPE on another type, and other commands refuse a series', async () => {
    await t.call('RPUSH', 'in:list', 'a');
    expect(await err(t.call('TS.ADD', 'in:list', 1, 1))).toBe(WRONGTYPE);
    await t.call('TS.ADD', 'in:wt', 1, 1);
    expect(await err(t.call('GET', 'in:wt'))).toBe(WRONGTYPE);
    expect(await err(t.call('LPUSH', 'in:wt', 'x'))).toBe(WRONGTYPE);
  });

  it('stores doubles exactly, including inf and NaN', async () => {
    await t.call('TS.ADD', 'in:dbl', 1, '0.1');
    await t.call('TS.ADD', 'in:dbl', 2, '-1.5e3');
    await t.call('TS.ADD', 'in:dbl', 3, 'inf');
    await t.call('TS.ADD', 'in:dbl', 4, 'nan');
    expect(await range('in:dbl')).toEqual([[1, '0.1'], [2, '-1500'], [3, 'inf'], [4, 'nan']]);
  });

  it('applies the duplicate policies (BLOCK default, ON_DUPLICATE override)', async () => {
    await t.call('TS.ADD', 'in:dp', 100, 10);
    expect(await err(t.call('TS.ADD', 'in:dp', 100, 20))).toBe(
      'ERR TSDB: Error at upsert, update is not supported when DUPLICATE_POLICY is set to BLOCK mode',
    );
    expect(await t.call('TS.ADD', 'in:dp', 100, 5, 'ON_DUPLICATE', 'FIRST')).toBe(100);
    expect(await t.call('TS.GET', 'in:dp')).toEqual([100, '10']);
    await t.call('TS.ADD', 'in:dp', 100, 20, 'ON_DUPLICATE', 'LAST');
    expect(await t.call('TS.GET', 'in:dp')).toEqual([100, '20']);
    await t.call('TS.ADD', 'in:dp', 100, 15, 'ON_DUPLICATE', 'MIN');
    expect(await t.call('TS.GET', 'in:dp')).toEqual([100, '15']);
    await t.call('TS.ADD', 'in:dp', 100, 12, 'ON_DUPLICATE', 'MAX');
    expect(await t.call('TS.GET', 'in:dp')).toEqual([100, '15']);
    await t.call('TS.ADD', 'in:dp', 100, 5, 'ON_DUPLICATE', 'SUM');
    expect(await t.call('TS.GET', 'in:dp')).toEqual([100, '20']);
    expect(await range('in:dp')).toHaveLength(1);
  });

  it('uses the series DUPLICATE_POLICY, then ts-duplicate-policy', async () => {
    await t.call('TS.CREATE', 'in:sum', 'DUPLICATE_POLICY', 'SUM');
    await t.call('TS.ADD', 'in:sum', 1, 2);
    await t.call('TS.ADD', 'in:sum', 1, 3);
    expect(await t.call('TS.GET', 'in:sum')).toEqual([1, '5']);
    await t.call('CONFIG', 'SET', 'ts-duplicate-policy', 'last');
    try {
      await t.call('TS.ADD', 'in:cfg', 1, 2);
      await t.call('TS.ADD', 'in:cfg', 1, 3);
      expect(await t.call('TS.GET', 'in:cfg')).toEqual([1, '3']);
    } finally {
      await t.call('CONFIG', 'SET', 'ts-duplicate-policy', 'block');
    }
  });

  it('refuses samples older than the retention window and trims the old ones', async () => {
    await t.call('TS.CREATE', 'in:ret', 'RETENTION', 100);
    await t.call('TS.ADD', 'in:ret', 1000, 1);
    await t.call('TS.ADD', 'in:ret', 1050, 2);
    expect(await err(t.call('TS.ADD', 'in:ret', 899, 0))).toBe('ERR TSDB: Timestamp is older than retention');
    expect(await t.call('TS.ADD', 'in:ret', 950, 0)).toBe(950);
    await t.call('TS.ADD', 'in:ret', 1100, 3);
    expect(await range('in:ret')).toEqual([[1000, '1'], [1050, '2'], [1100, '3']]);
    await t.call('TS.ADD', 'in:ret', 1151, 4);
    expect(await range('in:ret')).toEqual([[1100, '3'], [1151, '4']]);
  });

  it('IGNORE drops in-order samples close to the newest one (LAST policy only)', async () => {
    await t.call('TS.CREATE', 'in:ign', 'DUPLICATE_POLICY', 'LAST', 'IGNORE', 10, 0.5);
    expect(await t.call('TS.ADD', 'in:ign', 100, 1)).toBe(100);
    // within 10 ms and 0.5: ignored, the reply is the newest timestamp
    expect(await t.call('TS.ADD', 'in:ign', 105, 1.4)).toBe(100);
    expect(await t.call('TS.ADD', 'in:ign', 110, 0.5)).toBe(100);
    // too far in time or in value: added
    expect(await t.call('TS.ADD', 'in:ign', 111, 1)).toBe(111);
    expect(await t.call('TS.ADD', 'in:ign', 112, 2)).toBe(112);
    expect(await range('in:ign')).toEqual([[100, '1'], [111, '1'], [112, '2']]);
    // a policy other than LAST never ignores
    await t.call('TS.CREATE', 'in:ign2', 'DUPLICATE_POLICY', 'MAX', 'IGNORE', 10, 0.5);
    await t.call('TS.ADD', 'in:ign2', 100, 1);
    expect(await t.call('TS.ADD', 'in:ign2', 105, 1)).toBe(105);
  });

  it('ignores creation options for an existing series', async () => {
    await t.call('TS.ADD', 'in:opt', 1, 1, 'RETENTION', 10, 'LABELS', 'a', 'b');
    await t.call('TS.ADD', 'in:opt', 2, 1, 'RETENTION', 500, 'LABELS', 'c', 'd');
    const info = (await t.call('TS.INFO', 'in:opt')) as unknown[];
    expect(info[info.indexOf('retentionTime') + 1]).toBe(10);
    expect(info[info.indexOf('labels') + 1]).toEqual([['a', 'b']]);
  });
});

// ============================================================================
// TS.MADD
// ============================================================================

describe('TS.MADD', () => {
  it('appends to several series (docs example)', async () => {
    await t.call('TS.CREATE', 'stock:A', 'LABELS', 'type', 'stock', 'name', 'A');
    await t.call('TS.CREATE', 'stock:B', 'LABELS', 'type', 'stock', 'name', 'B');
    expect(
      await t.call('TS.MADD', 'stock:A', 1000, 100, 'stock:A', 1010, 110, 'stock:A', 1020, 120, 'stock:B', 1000, 120, 'stock:B', 1010, 110, 'stock:B', 1020, 100),
    ).toEqual([1000, 1010, 1020, 1000, 1010, 1020]);
    expect(await range('stock:B')).toEqual([[1000, '120'], [1010, '110'], [1020, '100']]);
  });

  it('reports per-sample errors without failing the others', async () => {
    await t.call('TS.CREATE', 'in:m1');
    await t.call('SET', 'in:mstr', 'x');
    const reply = (await t.call('TS.MADD', 'in:m1', 1, 1, 'in:missing', 1, 1, 'in:m1', 1, 2, 'in:mstr', 1, 1, 'in:m1', 2, 2)) as unknown[];
    expect(reply[0]).toBe(1);
    expect((reply[1] as Error).message).toBe('ERR TSDB: the key does not exist');
    expect((reply[2] as Error).message).toBe('ERR TSDB: Error at upsert, update is not supported when DUPLICATE_POLICY is set to BLOCK mode');
    expect((reply[3] as Error).message).toBe(WRONGTYPE);
    expect(reply[4]).toBe(2);
    expect(await t.call('EXISTS', 'in:missing')).toBe(0);
  });

  it('checks its argument count and every sample before writing', async () => {
    expect(await err(t.call('TS.MADD', 'a', 1, 1, 'b', 2))).toBe(arity('ts.madd'));
    expect(await err(t.call('TS.MADD', 'a', 1))).toBe(arity('ts.madd'));
    await t.call('TS.CREATE', 'in:m2');
    expect(await err(t.call('TS.MADD', 'in:m2', 1, 1, 'in:m2', -2, 1))).toBe('ERR TSDB: invalid timestamp, must be a nonnegative integer');
    expect(await err(t.call('TS.MADD', 'in:m2', 1, 'x'))).toBe('ERR TSDB: invalid value');
    expect(await t.call('TS.GET', 'in:m2')).toEqual([]);
  });
});

// ============================================================================
// TS.INCRBY / TS.DECRBY
// ============================================================================

describe('TS.INCRBY / TS.DECRBY', () => {
  it('updates the newest sample at the same timestamp (docs example)', async () => {
    expect(await t.call('TS.INCRBY', 'a', 232, 'TIMESTAMP', 1657811829000)).toBe(1657811829000);
    expect(await t.call('TS.INCRBY', 'a', 157, 'TIMESTAMP', 1657811829000)).toBe(1657811829000);
    expect(await t.call('TS.INCRBY', 'a', 432, 'TIMESTAMP', 1657811829000)).toBe(1657811829000);
    expect(await t.call('TS.GET', 'a')).toEqual([1657811829000, '821']);
  });

  it('adds a new sample from the newest value at a later timestamp', async () => {
    await t.call('TS.INCRBY', 'in:c', 5, 'TIMESTAMP', 10);
    await t.call('TS.DECRBY', 'in:c', 2, 'TIMESTAMP', 20);
    await t.call('TS.INCRBY', 'in:c', 0.5, 'TIMESTAMP', 30);
    expect(await range('in:c')).toEqual([[10, '5'], [20, '3'], [30, '3.5']]);
    expect(await err(t.call('TS.INCRBY', 'in:c', 1, 'TIMESTAMP', 29))).toBe(
      'ERR TSDB: timestamp must be equal to or higher than the maximum existing timestamp',
    );
  });

  it('defaults to the server time and creates the series with the given options', async () => {
    const before = Date.now();
    const ts = (await t.call('TS.DECRBY', 'in:d', 3, 'LABELS', 'kind', 'counter')) as number;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(await t.call('TS.GET', 'in:d')).toEqual([ts, '-3']);
    expect(await t.call('TS.QUERYINDEX', 'kind=counter')).toEqual(['in:d']);
  });

  it('validates its arguments', async () => {
    expect(await err(t.call('TS.INCRBY', 'in:e', 'x'))).toBe('ERR TSDB: invalid value');
    expect(await err(t.call('TS.INCRBY', 'in:e', 1, 'TIMESTAMP', 'x'))).toBe('ERR TSDB: invalid timestamp, must be a nonnegative integer');
    expect(await err(t.call('TS.INCRBY', 'in:e', 1, 'ON_DUPLICATE', 'LAST'))).toBe(SYNTAX);
    expect(await err(t.call('TS.DECRBY', 'in:e'))).toBe(arity('ts.decrby'));
  });
});

// ============================================================================
// TS.DEL
// ============================================================================

describe('TS.DEL', () => {
  it('deletes an inclusive range and returns the count (docs example)', async () => {
    await t.call('TS.CREATE', 'temp:TLV', 'LABELS', 'type', 'temp', 'location', 'TLV');
    await t.call('TS.MADD', 'temp:TLV', 1000, 30, 'temp:TLV', 1010, 35, 'temp:TLV', 1020, 9999, 'temp:TLV', 1030, 40);
    expect(await t.call('TS.DEL', 'temp:TLV', 1020, 1020)).toBe(1);
    expect(await range('temp:TLV')).toEqual([[1000, '30'], [1010, '35'], [1030, '40']]);
    expect(await t.call('TS.DEL', 'temp:TLV', 1000, 1030)).toBe(3);
    expect(await t.call('TS.DEL', 'temp:TLV', 1000, 1030)).toBe(0);
    // the key stays, empty
    expect(await t.call('TYPE', 'temp:TLV')).toBe('TSDB-TYPE');
  });

  it('accepts - and +, and refuses a missing key', async () => {
    await t.call('TS.MADD', 'stock:A', 3000, 1, 'stock:A', 3001, 2);
    expect(await t.call('TS.DEL', 'stock:A', '-', '+')).toBe(5);
    expect(await err(t.call('TS.DEL', 'in:nokey', 0, 1))).toBe('ERR TSDB: the key does not exist');
    expect(await err(t.call('TS.DEL', 'stock:A', 'x', 1))).toBe('ERR TSDB: wrong fromTimestamp');
    expect(await err(t.call('TS.DEL', 'stock:A', 0, 'y'))).toBe('ERR TSDB: wrong toTimestamp');
  });

  it('spans many chunks', async () => {
    await t.call('TS.CREATE', 'in:big', 'CHUNK_SIZE', 48, 'ENCODING', 'UNCOMPRESSED');
    const args: Array<string | number> = [];
    for (let i = 0; i < 100; i++) args.push('in:big', i, i);
    await t.call('TS.MADD', ...args);
    const info = (await t.call('TS.INFO', 'in:big')) as unknown[];
    expect(info[info.indexOf('chunkCount') + 1]).toBe(34);
    expect(await t.call('TS.DEL', 'in:big', 10, 89)).toBe(80);
    const left = (await range('in:big')) as Array<[number, string]>;
    expect(left.map(([ts]) => ts)).toEqual([...Array.from({ length: 10 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => 90 + i)]);
  });
});
