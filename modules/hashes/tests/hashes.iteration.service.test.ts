import { describe, expect, it } from 'vitest';

import { arity, err, NOT_INT, SYNTAX, useServer } from '@/tests/helpers';

/**
 * HSCAN, HRANDFIELD (hashes.iteration.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

const enc = (key: string) => t.call('OBJECT', 'ENCODING', key);

const sorted = (v: unknown) => [...(v as string[])].sort();

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

describe('hashes: HSCAN', () => {
  it('compact hash returns everything in one call regardless of COUNT', async () => {
    await t.call('HSET', 'h:scan', 'a', '1', 'b', '2', 'c', '3');
    expect(await t.call('HSCAN', 'h:scan', 0)).toEqual(['0', ['a', '1', 'b', '2', 'c', '3']]);
    expect(await t.call('HSCAN', 'h:scan', 0, 'COUNT', 1)).toEqual(['0', ['a', '1', 'b', '2', 'c', '3']]);
    expect(await t.call('HSCAN', 'h:scan', 0, 'NOVALUES')).toEqual(['0', ['a', 'b', 'c']]);
    expect(await t.call('HSCAN', 'h:scan', 0, 'MATCH', 'b*')).toEqual(['0', ['b', '2']]);
    expect(await t.call('HSCAN', 'h:scan', 0, 'MATCH', '[ac]', 'NOVALUES')).toEqual(['0', ['a', 'c']]);
    expect(await t.call('HSCAN', 'h:scan-missing', 0)).toEqual(['0', []]);
  });

  it('hashtable hash iterates with a cursor and visits every field', async () => {
    const args: string[] = [];
    for (let i = 0; i < 300; i++) args.push(`f${i}`, `v${i}`);
    await t.call('HSET', 'h:scanbig', ...args);
    expect(await enc('h:scanbig')).toBe('hashtable');
    const seen = new Map<string, string>();
    let cursor = '0';
    let calls = 0;
    do {
      const [next, items] = (await t.call('HSCAN', 'h:scanbig', cursor, 'COUNT', 20)) as [string, string[]];
      for (let i = 0; i < items.length; i += 2) seen.set(items[i], items[i + 1]);
      cursor = next;
      calls++;
    } while (cursor !== '0');
    expect(calls).toBeGreaterThan(1);
    expect(seen.size).toBe(300);
    expect(seen.get('f42')).toBe('v42');
    // NOVALUES on hashtable
    const keys = new Set<string>();
    cursor = '0';
    do {
      const [next, items] = (await t.call('HSCAN', 'h:scanbig', cursor, 'NOVALUES', 'MATCH', 'f1*')) as [string, string[]];
      for (const k of items) keys.add(k);
      cursor = next;
    } while (cursor !== '0');
    // f1, f10-f19, f100-f199
    expect(keys.size).toBe(111);
    expect([...keys].every((k) => k.startsWith('f1'))).toBe(true);
  });

  it('errors', async () => {
    await t.call('HSET', 'h:scanerr', 'a', '1');
    await expect(t.call('HSCAN', 'h:scanerr', 'abc')).rejects.toThrow('ERR invalid cursor');
    await expect(t.call('HSCAN', 'h:scanerr', 0, 'COUNT', 0)).rejects.toThrow(SYNTAX);
    await expect(t.call('HSCAN', 'h:scanerr', 0, 'COUNT', 'x')).rejects.toThrow(NOT_INT);
    await expect(t.call('HSCAN', 'h:scanerr', 0, 'FOO')).rejects.toThrow(SYNTAX);
    await expect(t.call('HSCAN', 'h:scanerr', 0, 'MATCH')).rejects.toThrow(SYNTAX);
    await expect(t.call('HSCAN', 'h:scanerr')).rejects.toThrow(arity('hscan'));
  });

  it('RESP3 reply stays a two-element array', async () => {
    await t.call('HSET', 'h:scan3', 'a', '1');
    const r = await resp3();
    expect(await r.send('HSCAN', 'h:scan3', '0')).toBe('*2\r\n$1\r\n0\r\n*2\r\n$1\r\na\r\n$1\r\n1\r\n');
  });
});

describe('hashes: HRANDFIELD', () => {
  it('no count, positive count, negative count, WITHVALUES', async () => {
    await t.call('HSET', 'h:rand', 'heads', 'obverse', 'tails', 'reverse', 'edge', 'null');
    expect(['heads', 'tails', 'edge']).toContain(await t.call('HRANDFIELD', 'h:rand'));
    const two = (await t.call('HRANDFIELD', 'h:rand', 2)) as string[];
    expect(two).toHaveLength(2);
    expect(new Set(two).size).toBe(2);
    expect(sorted(await t.call('HRANDFIELD', 'h:rand', 10))).toEqual(['edge', 'heads', 'tails']);
    const neg = (await t.call('HRANDFIELD', 'h:rand', -5)) as string[];
    expect(neg).toHaveLength(5);
    for (const f of neg) expect(['heads', 'tails', 'edge']).toContain(f);
    const wv = (await t.call('HRANDFIELD', 'h:rand', -5, 'WITHVALUES')) as string[];
    expect(wv).toHaveLength(10);
    const map: Record<string, string> = { heads: 'obverse', tails: 'reverse', edge: 'null' };
    for (let i = 0; i < wv.length; i += 2) expect(map[wv[i]]).toBe(wv[i + 1]);
    const all = (await t.call('HRANDFIELD', 'h:rand', 3, 'WITHVALUES')) as string[];
    expect(all).toHaveLength(6);
    expect(await t.call('HRANDFIELD', 'h:rand', 0)).toEqual([]);
    expect(await t.call('HRANDFIELD', 'h:rand', 0, 'WITHVALUES')).toEqual([]);
  });

  it('missing key: nil without count, empty array with count', async () => {
    expect(await t.call('HRANDFIELD', 'h:rand-missing')).toBeNull();
    expect(await t.call('HRANDFIELD', 'h:rand-missing', 3)).toEqual([]);
    expect(await t.call('HRANDFIELD', 'h:rand-missing', -3, 'WITHVALUES')).toEqual([]);
  });

  it('errors', async () => {
    await t.call('HSET', 'h:rand-err', 'a', '1');
    await expect(t.call('HRANDFIELD', 'h:rand-err', 'x')).rejects.toThrow(NOT_INT);
    await expect(t.call('HRANDFIELD', 'h:rand-err', 'WITHVALUES')).rejects.toThrow(NOT_INT);
    await expect(t.call('HRANDFIELD')).rejects.toThrow(arity('hrandfield'));
  });

  it('extra args after count are a syntax error', async () => {
    await t.call('HSET', 'h:rand-err2', 'a', '1');
    await expect(t.call('HRANDFIELD', 'h:rand-err2', 1, 'FOO')).rejects.toThrow(SYNTAX);
    await expect(t.call('HRANDFIELD', 'h:rand-err2', 1, 'WITHVALUES', 'x')).rejects.toThrow(SYNTAX);
  });

  it('RESP3: WITHVALUES returns pairs', async () => {
    await t.call('HSET', 'h:rand3', 'a', '1');
    const r = await resp3();
    expect(await r.send('HRANDFIELD', 'h:rand3', '1', 'WITHVALUES')).toBe('*1\r\n*2\r\n$1\r\na\r\n$1\r\n1\r\n');
    expect(await r.send('HRANDFIELD', 'h:rand3', '-2', 'WITHVALUES')).toBe(
      '*2\r\n*2\r\n$1\r\na\r\n$1\r\n1\r\n*2\r\n$1\r\na\r\n$1\r\n1\r\n',
    );
    expect(await r.send('HRANDFIELD', 'h:rand3', '-2')).toBe('*2\r\n$1\r\na\r\n$1\r\na\r\n');
    expect(await r.send('HRANDFIELD', 'h:rand3-missing')).toBe('_\r\n');
    const r2 = await t.raw();
    expect(await r2.send('HRANDFIELD', 'h:rand3', '-2', 'WITHVALUES')).toBe('*4\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\na\r\n$1\r\n1\r\n');
  });
});
