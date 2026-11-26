import { describe, expect, it } from 'vitest';

import { arity, err, NOT_INT, SYNTAX, useServer } from '@/tests/helpers';

/**
 * DUMP / RESTORE (keys.dump.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

describe('DUMP / RESTORE', () => {
  it('round-trips every type', async () => {
    await t.call('SET', 'dr:s', 'hello');
    await t.call('SET', 'dr:i', '12345');
    await t.call('RPUSH', 'dr:l', 'a', 'b', 'c');
    await t.call('SADD', 'dr:set', 'x', 'y');
    await t.call('ZADD', 'dr:z', 1, 'a', 2.5, 'b');
    await t.call('HSET', 'dr:h', 'f1', 'v1', 'f2', 'v2');
    for (const k of ['dr:s', 'dr:i', 'dr:l', 'dr:set', 'dr:z', 'dr:h']) {
      const payload = await t.redis.dumpBuffer(k);
      expect(Buffer.isBuffer(payload)).toBe(true);
      expect(await t.call('RESTORE', `${k}:copy`, 0, payload)).toBe('OK');
      expect(await t.call('TYPE', `${k}:copy`)).toBe(await t.call('TYPE', k));
      expect(await t.call('TTL', `${k}:copy`)).toBe(-1);
    }
    expect(await t.call('GET', 'dr:s:copy')).toBe('hello');
    expect(await t.call('GET', 'dr:i:copy')).toBe('12345');
    expect(await t.call('LRANGE', 'dr:l:copy', 0, -1)).toEqual(['a', 'b', 'c']);
    expect(((await t.call('SMEMBERS', 'dr:set:copy')) as string[]).sort()).toEqual(['x', 'y']);
    expect(await t.call('ZRANGE', 'dr:z:copy', 0, -1, 'WITHSCORES')).toEqual(['a', '1', 'b', '2.5']);
    expect(await t.call('HGETALL', 'dr:h:copy')).toEqual(['f1', 'v1', 'f2', 'v2']);
  });

  it('binary values round-trip', async () => {
    const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await t.call('SET', 'dr:bin', bin);
    await t.call('RESTORE', 'dr:bin2', 0, await t.redis.dumpBuffer('dr:bin'));
    expect(await t.redis.getBuffer('dr:bin2')).toEqual(bin);
  });

  it('TTL, ABSTTL, REPLACE, BUSYKEY', async () => {
    await t.call('SET', 'dr:t', 'v');
    const payload = await t.redis.dumpBuffer('dr:t');
    expect(await t.call('RESTORE', 'dr:t2', 100000, payload)).toBe('OK');
    expect(await t.call('PTTL', 'dr:t2')).toBeGreaterThan(95000);
    expect(await err(t.call('RESTORE', 'dr:t2', 0, payload))).toBe('BUSYKEY Target key name already exists.');
    expect(await t.call('RESTORE', 'dr:t2', 0, payload, 'REPLACE')).toBe('OK');
    expect(await t.call('TTL', 'dr:t2')).toBe(-1);
    const at = Date.now() + 200000;
    expect(await t.call('RESTORE', 'dr:t3', at, payload, 'ABSTTL')).toBe('OK');
    expect(await t.call('PEXPIRETIME', 'dr:t3')).toBe(at);
    expect(await t.call('RESTORE', 'dr:t4', 0, payload, 'IDLETIME', 100)).toBe('OK');
    expect(await t.call('OBJECT', 'IDLETIME', 'dr:t4')).toBeGreaterThanOrEqual(100);
  });

  it('DUMP of a missing key is nil', async () => {
    expect(await t.call('DUMP', 'dr:missing')).toBeNull();
    const r = await resp3();
    expect(await r.send('DUMP', 'dr:missing')).toBe('_\r\n');
  });

  it('errors', async () => {
    await t.call('SET', 'dr:e', 'v');
    const payload = await t.redis.dumpBuffer('dr:e');
    expect(await err(t.call('RESTORE', 'dr:e2', -1, payload))).toBe('ERR Invalid TTL value, must be >= 0');
    expect(await err(t.call('RESTORE', 'dr:e2', 'x', payload))).toBe(NOT_INT);
    expect(await err(t.call('RESTORE', 'dr:e2', 0, 'garbage'))).toBe('ERR DUMP payload version or checksum are wrong');
    expect(await err(t.call('RESTORE', 'dr:e2', 0, payload, 'FOO'))).toBe(SYNTAX);
    expect(await t.call('EXISTS', 'dr:e2')).toBe(0);
    expect(await err(t.call('DUMP'))).toBe(arity('dump'));
    expect(await err(t.call('RESTORE', 'dr:e2', 0))).toBe(arity('restore'));
  });
});
