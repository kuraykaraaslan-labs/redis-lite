/**
 * TS.INFO [DEBUG], TS.ALTER and the ts-* config parameters (timeseries.info.service). The TS.INFO field list and order
 * follow the redis.io TS.INFO example.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import { err, resp3Client, SYNTAX, useServer } from '@/tests/helpers';

const t = useServer();

async function info(key: string, ...extra: string[]): Promise<Record<string, unknown>> {
  const flat = (await t.call('TS.INFO', key, ...extra)) as unknown[];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < flat.length; i += 2) out[String(flat[i])] = flat[i + 1];
  return out;
}

// ============================================================================
// TS.INFO
// ============================================================================

describe('TS.INFO', () => {
  it('reports every field in the documented order (docs example)', async () => {
    await t.call('TS.CREATE', 'telemetry:study:temperature', 'LABELS', 'room', 'study', 'type', 'temperature');
    const flat = (await t.call('TS.INFO', 'telemetry:study:temperature')) as unknown[];
    expect(flat.filter((_, i) => i % 2 === 0)).toEqual([
      'totalSamples', 'memoryUsage', 'firstTimestamp', 'lastTimestamp', 'retentionTime', 'chunkCount', 'chunkSize', 'chunkType',
      'duplicatePolicy', 'labels', 'sourceKey', 'rules', 'ignoreMaxTimeDiff', 'ignoreMaxValDiff',
    ]);
    const i = await info('telemetry:study:temperature');
    expect(i).toMatchObject({
      totalSamples: 0,
      firstTimestamp: 0,
      lastTimestamp: 0,
      retentionTime: 0,
      chunkCount: 1,
      chunkSize: 4096,
      chunkType: 'compressed',
      duplicatePolicy: null,
      labels: [['room', 'study'], ['type', 'temperature']],
      sourceKey: null,
      rules: [],
      ignoreMaxTimeDiff: 0,
      ignoreMaxValDiff: '0',
    });
    expect(i.memoryUsage).toBeGreaterThan(4096);
  });

  it('tracks samples, chunks and the explicit duplicate policy', async () => {
    await t.call('TS.CREATE', 'inf:a', 'DUPLICATE_POLICY', 'LAST', 'CHUNK_SIZE', 64, 'ENCODING', 'UNCOMPRESSED');
    for (let ts = 10; ts <= 100; ts += 10) await t.call('TS.ADD', 'inf:a', ts, ts / 10);
    const i = await info('inf:a');
    expect(i).toMatchObject({ totalSamples: 10, firstTimestamp: 10, lastTimestamp: 100, chunkCount: 3, chunkType: 'uncompressed', duplicatePolicy: 'last' });
  });

  it('DEBUG adds keySelfName and the chunks', async () => {
    const i = await info('inf:a', 'DEBUG');
    expect(i.keySelfName).toBe('inf:a');
    expect(i.Chunks).toEqual([
      ['startTimestamp', 10, 'endTimestamp', 40, 'samples', 4, 'size', 64, 'bytesPerSample', '16'],
      ['startTimestamp', 50, 'endTimestamp', 80, 'samples', 4, 'size', 64, 'bytesPerSample', '16'],
      ['startTimestamp', 90, 'endTimestamp', 100, 'samples', 2, 'size', 64, 'bytesPerSample', '32'],
    ]);
    expect(await err(t.call('TS.INFO', 'inf:a', 'VERBOSE'))).toBe(SYNTAX);
    expect(await err(t.call('TS.INFO', 'inf:none'))).toBe('ERR TSDB: the key does not exist');
  });

  it('compressed chunks hold more than CHUNK_SIZE / 16 samples of regular data', async () => {
    await t.call('TS.CREATE', 'inf:gorilla', 'CHUNK_SIZE', 128);
    const args: Array<string | number> = [];
    for (let i = 0; i < 200; i++) args.push('inf:gorilla', 1000 + i * 10, 20);
    await t.call('TS.MADD', ...args);
    const i = await info('inf:gorilla');
    expect(i.totalSamples).toBe(200);
    expect(i.chunkCount as number).toBeLessThan(200 / 8);
    expect((await t.call('TS.RANGE', 'inf:gorilla', '-', '+')) as unknown[]).toHaveLength(200);
  });

  it('RESP3: a map, labels as a map', async () => {
    await t.call('TS.CREATE', 'inf:r3', 'LABELS', 'a', 'b');
    const r = await resp3Client(t);
    const reply = await r.send('TS.INFO', 'inf:r3');
    expect(reply.startsWith('%14\r\n$12\r\ntotalSamples\r\n:0\r\n')).toBe(true);
    expect(reply).toContain('$9\r\nchunkType\r\n$10\r\ncompressed\r\n$15\r\nduplicatePolicy\r\n_\r\n$6\r\nlabels\r\n%1\r\n$1\r\na\r\n$1\r\nb\r\n');
    expect(reply).toContain('$5\r\nrules\r\n%0\r\n');
    expect(reply.endsWith('$16\r\nignoreMaxValDiff\r\n,0\r\n')).toBe(true);
  });
});

// ============================================================================
// TS.ALTER
// ============================================================================

describe('TS.ALTER', () => {
  it('changes retention (trimming at once), labels, policy, chunk size and IGNORE (docs example)', async () => {
    await t.call('TS.CREATE', 'temperature:2:32', 'LABELS', 'sensor_id', 2, 'area_id', 32);
    await t.call('TS.MADD', 'temperature:2:32', 1000, 1, 'temperature:2:32', 2000, 2, 'temperature:2:32', 3000, 3);
    expect(await t.call('TS.ALTER', 'temperature:2:32', 'LABELS', 'sensor_id', 2, 'area_id', 32, 'sub_area_id', 15)).toBe('OK');
    expect((await info('temperature:2:32')).labels).toEqual([['sensor_id', '2'], ['area_id', '32'], ['sub_area_id', '15']]);
    await t.call('TS.ALTER', 'temperature:2:32', 'RETENTION', 1000, 'DUPLICATE_POLICY', 'MIN', 'CHUNK_SIZE', 256, 'IGNORE', 3, 0.25);
    const i = await info('temperature:2:32');
    expect(i).toMatchObject({ retentionTime: 1000, duplicatePolicy: 'min', chunkSize: 256, ignoreMaxTimeDiff: 3, ignoreMaxValDiff: '0.25' });
    // labels untouched when LABELS is not given
    expect(i.labels).toHaveLength(3);
    expect(await t.call('TS.RANGE', 'temperature:2:32', '-', '+')).toEqual([[2000, '2'], [3000, '3']]);
    await t.call('TS.ADD', 'temperature:2:32', 3000, 1);
    expect(await t.call('TS.GET', 'temperature:2:32')).toEqual([3000, '1']);
  });

  it('LABELS without pairs removes every label', async () => {
    await t.call('TS.ALTER', 'temperature:2:32', 'LABELS');
    expect((await info('temperature:2:32')).labels).toEqual([]);
    expect(await t.call('TS.QUERYINDEX', 'sensor_id=2')).toEqual([]);
  });

  it('errors', async () => {
    expect(await err(t.call('TS.ALTER', 'inf:none', 'RETENTION', 1))).toBe('ERR TSDB: the key does not exist');
    expect(await err(t.call('TS.ALTER', 'temperature:2:32', 'ENCODING', 'COMPRESSED'))).toBe(SYNTAX);
    expect(await err(t.call('TS.ALTER', 'temperature:2:32', 'RETENTION', 'x'))).toBe("ERR TSDB: Couldn't parse RETENTION");
    expect(await err(t.call('TS.ALTER', 'temperature:2:32', 'LABELS', 'odd'))).toBe("ERR TSDB: Couldn't parse LABELS");
  });
});

// ============================================================================
// Config
// ============================================================================

describe('ts-* config parameters', () => {
  it('defaults', async () => {
    expect(await t.call('CONFIG', 'GET', 'ts-*')).toEqual(
      expect.arrayContaining([
        'ts-retention-policy', '0', 'ts-duplicate-policy', 'block', 'ts-chunk-size-bytes', '4096', 'ts-encoding', 'compressed',
        'ts-ignore-max-time-diff', '0', 'ts-ignore-max-val-diff', '0', 'ts-compaction-policy', '', 'ts-num-threads', '3',
      ]),
    );
  });

  it('apply to series created afterwards', async () => {
    const set = async (name: string, value: string | number): Promise<void> => {
      expect(await t.call('CONFIG', 'SET', name, value)).toBe('OK');
    };
    await set('ts-retention-policy', 5000);
    await set('ts-chunk-size-bytes', 512);
    await set('ts-encoding', 'UNCOMPRESSED');
    await set('ts-ignore-max-time-diff', 7);
    await set('ts-ignore-max-val-diff', '0.5');
    try {
      await t.call('TS.CREATE', 'cfg:a');
      expect(await info('cfg:a')).toMatchObject({
        retentionTime: 5000,
        chunkSize: 512,
        chunkType: 'uncompressed',
        ignoreMaxTimeDiff: 7,
        ignoreMaxValDiff: '0.5',
        duplicatePolicy: null,
      });
      // explicit options win
      await t.call('TS.CREATE', 'cfg:b', 'RETENTION', 1, 'ENCODING', 'COMPRESSED');
      expect(await info('cfg:b')).toMatchObject({ retentionTime: 1, chunkType: 'compressed', chunkSize: 512 });
    } finally {
      await set('ts-retention-policy', 0);
      await set('ts-chunk-size-bytes', 4096);
      await set('ts-encoding', 'compressed');
      await set('ts-ignore-max-time-diff', 0);
      await set('ts-ignore-max-val-diff', 0);
    }
  });

  it('validates values', async () => {
    const fail = (name: string, reason: string): string => `ERR CONFIG SET failed (possibly related to argument '${name}') - ${reason}`;
    expect(await err(t.call('CONFIG', 'SET', 'ts-duplicate-policy', 'newest'))).toBe(
      fail('ts-duplicate-policy', 'argument(s) must be one of the following: block, first, last, min, max, sum'),
    );
    expect(await err(t.call('CONFIG', 'SET', 'ts-chunk-size-bytes', 8))).toBe(fail('ts-chunk-size-bytes', 'argument must be between 48 and 1048576 inclusive'));
    expect(await err(t.call('CONFIG', 'SET', 'ts-ignore-max-val-diff', '-1'))).toBe(fail('ts-ignore-max-val-diff', 'argument must be a non-negative number'));
    expect(await err(t.call('CONFIG', 'SET', 'ts-num-threads', 4))).toBe(fail('ts-num-threads', "can't set immutable config"));
  });
});
