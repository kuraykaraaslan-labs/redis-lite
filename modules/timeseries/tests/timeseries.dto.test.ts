/**
 * Unit tests of the stateless argument grammar (no server): parsed shapes and which error wins.
 * The end-to-end behaviour of every command is covered by the timeseries.*.service suites.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { firstIssue } from '@/libs/schemas';

import { AddDTO, CompactionPolicySchema, CreateDTO, CreateRuleDTO, IncrByDTO, MAddDTO, MGetDTO, MRangeDTO, QueryIndexDTO, RangeDTO } from '../timeseries.dto';

/** The error text a DTO reports for `args`, or the parsed value when it succeeds. */
function parse(dto: z.ZodType, args: string[]): unknown {
  const result = dto.safeParse(args);
  return result.success ? result.data : firstIssue(result.error);
}

describe('series options', () => {
  it('parses every option; LABELS takes the rest', () => {
    expect(parse(CreateDTO, ['k', 'retention', '5', 'ENCODING', 'Uncompressed', 'CHUNK_SIZE', '48', 'DUPLICATE_POLICY', 'sum', 'IGNORE', '1', '0.5', 'LABELS', 'RETENTION', 'x'])).toEqual({
      key: 'k',
      options: {
        retention: 5,
        encoding: 'uncompressed',
        chunkSize: 48,
        duplicatePolicy: 'sum',
        ignore: { maxTimeDiff: 1, maxValDiff: 0.5 },
        labels: [['RETENTION', 'x']],
      },
    });
    expect(parse(CreateDTO, ['k'])).toEqual({ key: 'k', options: { labels: null } });
  });

  it('reports the first problem', () => {
    expect(parse(CreateDTO, ['k', 'RETENTION', 'x', 'ENCODING', 'bad'])).toBe("ERR TSDB: Couldn't parse RETENTION");
    expect(parse(CreateDTO, ['k', 'ENCODING', 'bad', 'RETENTION', 'x'])).toBe('ERR TSDB: unknown ENCODING parameter');
    expect(parse(CreateDTO, ['k', 'ON_DUPLICATE', 'last'])).toBe('ERR syntax error');
    expect(parse(AddDTO, ['k', 'x', 'y'])).toBe('ERR TSDB: invalid timestamp, must be a nonnegative integer');
    expect(parse(AddDTO, ['k', '1', 'y', 'RETENTION', 'x'])).toBe('ERR TSDB: invalid value');
  });

  it('TS.ADD: `*`, ON_DUPLICATE, NaN', () => {
    expect(parse(AddDTO, ['k', '*', 'nan', 'ON_DUPLICATE', 'max'])).toEqual({ key: 'k', timestamp: '*', value: NaN, options: { labels: null }, onDuplicate: 'max' });
  });

  it('TS.INCRBY: TIMESTAMP and a signed delta', () => {
    expect(parse(IncrByDTO, ['k', '-2.5', 'TIMESTAMP', '7'])).toEqual({ key: 'k', delta: -2.5, timestamp: 7, options: { labels: null } });
    expect(parse(IncrByDTO, ['k', '1'])).toMatchObject({ timestamp: '*' });
  });

  it('TS.MADD: triples, validated before anything is written', () => {
    expect(parse(MAddDTO, ['a', '1', '2', 'b', '*', '3'])).toEqual({
      samples: [
        { key: 'a', timestamp: 1, value: 2 },
        { key: 'b', timestamp: '*', value: 3 },
      ],
    });
    expect(parse(MAddDTO, ['a', '1'])).toBe("ERR wrong number of arguments for 'ts.madd' command");
  });
});

describe('range options', () => {
  it('parses aggregation with its modifiers in any order', () => {
    const r = parse(RangeDTO, ['k', '-', '+', 'EMPTY', 'BUCKETTIMESTAMP', '~', 'AGGREGATION', 'TWA', '5', 'ALIGN', '+', 'COUNT', '3', 'LATEST']);
    expect(r).toEqual({
      key: 'k',
      query: {
        from: 0,
        to: Number.MAX_SAFE_INTEGER,
        latest: true,
        filterByTs: null,
        filterByValue: null,
        count: 3,
        aggregation: { aggregator: 'twa', bucketDuration: 5, align: { kind: 'end' }, bucketTimestamp: 'mid', empty: true },
      },
    });
  });

  it('FILTER_BY_TS takes the timestamps that follow it', () => {
    expect(parse(RangeDTO, ['k', '0', '10', 'FILTER_BY_TS', '1', '2', '3', 'COUNT', '1'])).toMatchObject({ query: { filterByTs: [1, 2, 3], count: 1 } });
  });
});

describe('filters', () => {
  it('parses every matcher form', () => {
    expect(parse(QueryIndexDTO, ['a=1', 'b!=2', 'c=', 'd!=', 'e=(x,y)', 'f!=(z)'])).toEqual({
      filters: [
        { label: 'a', negate: false, values: ['1'] },
        { label: 'b', negate: true, values: ['2'] },
        { label: 'c', negate: false, values: [] },
        { label: 'd', negate: true, values: [] },
        { label: 'e', negate: false, values: ['x', 'y'] },
        { label: 'f', negate: true, values: ['z'] },
      ],
    });
    expect(parse(QueryIndexDTO, ['e=(x,y)'])).toMatchObject({ filters: [{ values: ['x', 'y'] }] });
    expect(parse(QueryIndexDTO, ['a!=1'])).toBe('ERR TSDB: please provide at least one matcher');
  });

  it('TS.MGET and TS.MRANGE take FILTER last (before GROUPBY)', () => {
    expect(parse(MGetDTO, ['SELECTED_LABELS', 'a', 'b', 'FILTER', 'x=1'])).toEqual({
      latest: false,
      labels: { kind: 'selected', labels: ['a', 'b'] },
      filters: [{ label: 'x', negate: false, values: ['1'] }],
    });
    expect(parse(MRangeDTO, ['-', '+', 'WITHLABELS', 'FILTER', 'x=1', 'y!=', 'GROUPBY', 'x', 'REDUCE', 'SUM'])).toMatchObject({
      labels: { kind: 'all' },
      filters: [{ label: 'x' }, { label: 'y', negate: true }],
      groupBy: { label: 'x', reducer: 'sum' },
    });
    expect(parse(MRangeDTO, ['-', '+', 'FILTER', 'x=1', 'GROUPBY', 'x', 'REDUCE', 'sum', 'extra'])).toBe("ERR TSDB: Couldn't parse GROUPBY");
  });
});

describe('rules and policy', () => {
  it('TS.CREATERULE', () => {
    expect(parse(CreateRuleDTO, ['s', 'd', 'aggregation', 'Range', '86400000', '21600000'])).toEqual({
      sourceKey: 's',
      destKey: 'd',
      aggregator: 'range',
      bucketDuration: 86400000,
      alignTimestamp: 21600000,
    });
    expect(parse(CreateRuleDTO, ['s', 'd', 'AGGREGATION', 'avg', '10', '0', 'x'])).toBe('ERR syntax error');
  });

  it('ts-compaction-policy', () => {
    expect(CompactionPolicySchema.parse('max:1m:1d;min:10s:1h;avg:2h:10d;avg:3d:100d')).toEqual([
      { aggregator: 'max', bucketDuration: 60000, retention: 86400000, alignTimestamp: 0 },
      { aggregator: 'min', bucketDuration: 10000, retention: 3600000, alignTimestamp: 0 },
      { aggregator: 'avg', bucketDuration: 7200000, retention: 864000000, alignTimestamp: 0 },
      { aggregator: 'avg', bucketDuration: 259200000, retention: 8640000000, alignTimestamp: 0 },
    ]);
    expect(CompactionPolicySchema.parse('twa:1d:0:6h')).toEqual([{ aggregator: 'twa', bucketDuration: 86400000, retention: 0, alignTimestamp: 21600000 }]);
    expect(CompactionPolicySchema.parse('')).toEqual([]);
    expect(CompactionPolicySchema.safeParse('max:0:1d').success).toBe(false);
    expect(CompactionPolicySchema.safeParse('max:1m').success).toBe(false);
  });
});
