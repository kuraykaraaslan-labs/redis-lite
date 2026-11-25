/**
 * Unit tests of the TimeSeries data structure (no server): ordering, duplicate policies, chunking, deletion,
 * retention trimming, copies.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import { TimeSeries } from '../timeseries.structure';
import type { SeriesSettings } from '../timeseries.types';

const settings = (over: Partial<SeriesSettings> = {}): SeriesSettings => ({
  retention: 0,
  chunkSize: 4096,
  encoding: 'compressed',
  duplicatePolicy: null,
  ignoreMaxTimeDiff: 0,
  ignoreMaxValDiff: 0,
  ...over,
});

const stamps = (s: TimeSeries): number[] => s.range(0, Number.MAX_SAFE_INTEGER).map((x) => x.timestamp);

describe('TimeSeries', () => {
  it('keeps samples sorted and resolves duplicates by policy', () => {
    const s = new TimeSeries(settings());
    expect(s.upsert(20, 2, 'block')).toBe('added');
    expect(s.upsert(10, 1, 'block')).toBe('added');
    expect(s.upsert(30, 3, 'block')).toBe('added');
    expect(s.upsert(20, 9, 'block')).toBe('blocked');
    expect(s.upsert(20, 9, 'first')).toBe('unchanged');
    expect(s.upsert(20, 9, 'last')).toBe('updated');
    expect(s.upsert(20, 4, 'min')).toBe('updated');
    expect(s.upsert(20, 1, 'max')).toBe('unchanged');
    expect(s.upsert(20, 1, 'sum')).toBe('updated');
    expect(s.range(0, 100)).toEqual([
      { timestamp: 10, value: 1 },
      { timestamp: 20, value: 5 },
      { timestamp: 30, value: 3 },
    ]);
    expect(s.totalSamples).toBe(3);
    expect([s.firstTimestamp, s.lastTimestamp]).toEqual([10, 30]);
    expect(s.before(20)).toEqual({ timestamp: 10, value: 1 });
    expect(s.after(20)).toEqual({ timestamp: 30, value: 3 });
    expect(s.before(10)).toBeUndefined();
    expect(s.after(30)).toBeUndefined();
  });

  it('uncompressed chunks hold CHUNK_SIZE / 16 samples and split when an insert overflows them', () => {
    const s = new TimeSeries(settings({ encoding: 'uncompressed', chunkSize: 64 }));
    for (let ts = 0; ts < 80; ts += 10) s.upsert(ts, ts, 'block');
    expect(s.chunkInfo().map((c) => c.samples)).toEqual([4, 4]);
    s.upsert(5, 5, 'block');
    expect(s.chunkInfo().map((c) => c.samples)).toEqual([2, 3, 4]);
    expect(stamps(s)).toEqual([0, 5, 10, 20, 30, 40, 50, 60, 70]);
  });

  it('compressed chunks fit many regular samples and stay within CHUNK_SIZE', () => {
    const s = new TimeSeries(settings({ chunkSize: 48 }));
    for (let i = 0; i < 1000; i++) s.upsert(1000 + i * 10, 42, 'block');
    expect(s.chunks.length).toBeLessThan(20);
    for (const c of s.chunks) expect(c.bytes).toBeLessThanOrEqual(48);
    // irregular data takes more room
    const noisy = new TimeSeries(settings({ chunkSize: 48 }));
    for (let i = 0; i < 1000; i++) noisy.upsert(i * 7 + (i % 3), Math.sin(i), 'block');
    expect(noisy.chunks.length).toBeGreaterThan(s.chunks.length);
    expect(noisy.totalSamples).toBe(1000);
  });

  it('deleteRange removes inclusive ranges across chunks', () => {
    const s = new TimeSeries(settings({ encoding: 'uncompressed', chunkSize: 48 }));
    for (let ts = 0; ts < 20; ts++) s.upsert(ts, ts, 'block');
    expect(s.deleteRange(3, 16)).toBe(14);
    expect(stamps(s)).toEqual([0, 1, 2, 17, 18, 19]);
    expect(s.totalSamples).toBe(6);
    expect(s.deleteRange(100, 200)).toBe(0);
    expect(s.deleteRange(0, 100)).toBe(6);
    expect(s.isEmpty).toBe(true);
    expect(s.chunkCount).toBe(1);
    expect([s.firstTimestamp, s.lastTimestamp]).toEqual([0, 0]);
  });

  it('trim keeps the samples within retention of the newest one', () => {
    const s = new TimeSeries(settings({ retention: 10 }));
    for (const ts of [0, 5, 10, 15, 20]) s.upsert(ts, 1, 'block');
    s.trim();
    expect(stamps(s)).toEqual([10, 15, 20]);
  });

  it('clone copies samples deeply, relations only on request', () => {
    const s = new TimeSeries(settings());
    s.upsert(1, 1, 'block');
    s.labels.set('a', 'b');
    s.rules.push({ destKey: 'd', aggregator: 'avg', bucketDuration: 10, alignTimestamp: 0, since: 1 });
    s.srcKey = 'src';
    const bare = s.clone(false);
    const full = s.clone(true);
    bare.upsert(2, 2, 'block');
    expect(s.totalSamples).toBe(1);
    expect(bare.labels.get('a')).toBe('b');
    expect([bare.rules, bare.srcKey]).toEqual([[], null]);
    expect([full.rules.length, full.srcKey]).toEqual([1, 'src']);
    full.rules[0].since = 99;
    expect(s.rules[0].since).toBe(1);
  });
});
