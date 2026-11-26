import { describe, expect, it } from 'vitest';

import { arity, SYNTAX, useServer } from '@/tests/helpers';

/**
 * SSCAN (sets.scan.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

describe('sets: SSCAN', () => {
  it('SSCAN', async () => {
    await t.call('SADD', 's:scan', 'a', 'b', 'c');
    const [cur, items] = (await t.call('SSCAN', 's:scan', 0)) as [string, string[]];
    expect(cur).toBe('0');
    expect([...items].sort()).toEqual(['a', 'b', 'c']);
    expect(await t.call('SSCAN', 's:scan', 0, 'MATCH', 'b')).toEqual(['0', ['b']]);
    expect(await t.call('SSCAN', 's:scan-missing', 0)).toEqual(['0', []]);
    const members: string[] = [];
    for (let i = 0; i < 300; i++) members.push(`m${i}`);
    await t.call('SADD', 's:scan-big', ...members);
    const seen = new Set<string>();
    let cursor = '0';
    let calls = 0;
    do {
      const [next, batch] = (await t.call('SSCAN', 's:scan-big', cursor, 'COUNT', 20)) as [string, string[]];
      for (const m of batch) seen.add(m);
      cursor = next;
      calls++;
    } while (cursor !== '0');
    expect(calls).toBeGreaterThan(1);
    expect(seen.size).toBe(300);
    await expect(t.call('SSCAN', 's:scan', 'abc')).rejects.toThrow('ERR invalid cursor');
    await expect(t.call('SSCAN', 's:scan', 0, 'COUNT', 0)).rejects.toThrow(SYNTAX);
    await expect(t.call('SSCAN', 's:scan', 0, 'FOO')).rejects.toThrow(SYNTAX);
    await expect(t.call('SSCAN', 's:scan')).rejects.toThrow(arity('sscan'));
    // NOVALUES is HSCAN's, TYPE the keyspace SCAN's
    await expect(t.call('SSCAN', 's:scan', 0, 'NOVALUES')).rejects.toThrow(SYNTAX);
    await expect(t.call('SSCAN', 's:scan', 0, 'TYPE', 'set')).rejects.toThrow(SYNTAX);
  });
});
