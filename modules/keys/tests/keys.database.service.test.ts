import { describe, expect, it } from 'vitest';

import { arity, err, NOT_INT, useServer } from '@/tests/helpers';

/**
 * MOVE (keys.database.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

describe('MOVE', () => {
  it('moves a key to another db', async () => {
    await t.call('SET', 'mv:a', 'v', 'EX', 100);
    expect(await t.call('MOVE', 'mv:a', 1)).toBe(1);
    expect(await t.call('EXISTS', 'mv:a')).toBe(0);
    const c = t.client();
    await c.select(1);
    expect(await c.get('mv:a')).toBe('v');
    expect(await c.ttl('mv:a')).toBeGreaterThan(95);
  });

  it('returns 0 when the destination exists or the source is missing', async () => {
    const c = t.client();
    await c.select(1);
    await c.set('mv:b', 'there');
    await t.call('SET', 'mv:b', 'here');
    expect(await t.call('MOVE', 'mv:b', 1)).toBe(0);
    expect(await t.call('GET', 'mv:b')).toBe('here');
    expect(await c.get('mv:b')).toBe('there');
    expect(await t.call('MOVE', 'mv:missing', 1)).toBe(0);
  });

  it('errors', async () => {
    await t.call('SET', 'mv:e', 'v');
    expect(await err(t.call('MOVE', 'mv:e', 0))).toBe('ERR source and destination objects are the same');
    expect(await err(t.call('MOVE', 'mv:e', 99999))).toBe('ERR DB index is out of range');
    expect(await err(t.call('MOVE', 'mv:e', 'abc'))).toBe(NOT_INT);
    expect(await err(t.call('MOVE', 'mv:e'))).toBe(arity('move'));
  });
});
