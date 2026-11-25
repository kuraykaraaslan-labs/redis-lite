import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

/**
 * HyperLogLog commands: PFADD, PFCOUNT, PFMERGE (hyperloglog.value.service). Expected values come from the redis.io command docs (and their examples) and Redis
 * error strings; anything not certain is marked `// unverified:`.
 */
const t = useServer();

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const HLL_WRONGTYPE = 'WRONGTYPE Key is not a valid HyperLogLog string value.';

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

/** Resolves to the error message, or to a marker describing the non-error reply. */
const err = async (p: Promise<unknown>): Promise<string> => {
  try {
    return `(no error; reply: ${JSON.stringify(await p)})`;
  } catch (e) {
    return (e as Error).message;
  }
};

// ─────────────────────────── HyperLogLog ───────────────────────────
describe('PFADD / PFCOUNT', () => {
  it('PFADD docs example', async () => {
    expect(await t.call('PFADD', 'hll:doc', 'a', 'b', 'c', 'd', 'e', 'f', 'g')).toBe(1);
    expect(await t.call('PFCOUNT', 'hll:doc')).toBe(7);
  });

  it('PFCOUNT docs example (single and multi key)', async () => {
    expect(await t.call('PFADD', 'hll:c', 'foo', 'bar', 'zap')).toBe(1);
    expect(await t.call('PFADD', 'hll:c', 'zap', 'zap', 'zap')).toBe(0);
    expect(await t.call('PFADD', 'hll:c', 'foo', 'bar')).toBe(0);
    expect(await t.call('PFCOUNT', 'hll:c')).toBe(3);
    expect(await t.call('PFADD', 'hll:other', 1, 2, 3)).toBe(1);
    expect(await t.call('PFCOUNT', 'hll:c', 'hll:other')).toBe(6);
    expect(await t.call('PFCOUNT', 'hll:c', 'hll:other', 'hll:nokey')).toBe(6);
    expect(await t.call('PFCOUNT', 'hll:nokey')).toBe(0);
    expect(await t.call('EXISTS', 'hll:nokey')).toBe(0);
  });

  it('PFADD with no elements creates the key once', async () => {
    expect(await t.call('PFADD', 'hll:empty')).toBe(1);
    expect(await t.call('PFADD', 'hll:empty')).toBe(0);
    expect(await t.call('PFCOUNT', 'hll:empty')).toBe(0);
    expect(await t.call('TYPE', 'hll:empty')).toBe('string');
  });

  it('a stored HLL is a string that starts with HYLL', async () => {
    await t.call('PFADD', 'hll:str', 'x');
    const raw = await t.redis.getBuffer('hll:str');
    expect(raw?.subarray(0, 4).toString('latin1')).toBe('HYLL');
  });

  it('errors', async () => {
    await t.call('SET', 'hll:bad', 'not an hll');
    expect.soft(await err(t.call('PFADD', 'hll:bad', 'x'))).toBe(HLL_WRONGTYPE);
    expect.soft(await err(t.call('PFCOUNT', 'hll:bad'))).toBe(HLL_WRONGTYPE);
    await t.call('PFADD', 'hll:ok', 'x');
    expect.soft(await err(t.call('PFCOUNT', 'hll:ok', 'hll:bad'))).toBe(HLL_WRONGTYPE);
    await t.call('LPUSH', 'hll:list', 'x');
    expect.soft(await err(t.call('PFADD', 'hll:list', 'x'))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('PFCOUNT', 'hll:list'))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('PFCOUNT', 'hll:ok', 'hll:list'))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('PFADD'))).toBe(arity('pfadd'));
    expect.soft(await err(t.call('PFCOUNT'))).toBe(arity('pfcount'));
  });

  it('approximates larger cardinalities within the standard error', async () => {
    const els: string[] = [];
    for (let i = 0; i < 5000; i++) els.push(`e${i}`);
    expect(await t.call('PFADD', 'hll:big', ...els)).toBe(1);
    const n = (await t.call('PFCOUNT', 'hll:big')) as number;
    expect(Math.abs(n - 5000) / 5000).toBeLessThan(0.0081 * 3);
  });
});

describe('PFMERGE', () => {
  it('docs example', async () => {
    await t.call('PFADD', 'hm:1', 'foo', 'bar', 'zap', 'a');
    await t.call('PFADD', 'hm:2', 'a', 'b', 'c', 'foo');
    expect(await t.call('PFMERGE', 'hm:3', 'hm:1', 'hm:2')).toBe('OK');
    expect(await t.call('PFCOUNT', 'hm:3')).toBe(6);
  });

  it('dest participates as a source; no sources creates an empty HLL', async () => {
    await t.call('PFADD', 'hm:d', 'x', 'y');
    await t.call('PFADD', 'hm:s', 'y', 'z');
    expect(await t.call('PFMERGE', 'hm:d', 'hm:s')).toBe('OK');
    expect(await t.call('PFCOUNT', 'hm:d')).toBe(3);
    expect(await t.call('PFMERGE', 'hm:new')).toBe('OK');
    expect(await t.call('EXISTS', 'hm:new')).toBe(1);
    expect(await t.call('PFCOUNT', 'hm:new')).toBe(0);
    expect(await t.call('PFMERGE', 'hm:new2', 'hm:missing')).toBe('OK');
    expect(await t.call('PFCOUNT', 'hm:new2')).toBe(0);
  });

  it('errors', async () => {
    await t.call('PFADD', 'hm:ok', 'x');
    await t.call('SET', 'hm:bad', 'nope');
    expect.soft(await err(t.call('PFMERGE', 'hm:dst', 'hm:ok', 'hm:bad'))).toBe(HLL_WRONGTYPE);
    expect.soft(await err(t.call('PFMERGE', 'hm:bad', 'hm:ok'))).toBe(HLL_WRONGTYPE);
    await t.call('SADD', 'hm:set', 'x');
    expect.soft(await err(t.call('PFMERGE', 'hm:dst', 'hm:set'))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('PFMERGE'))).toBe(arity('pfmerge'));
  });
});
