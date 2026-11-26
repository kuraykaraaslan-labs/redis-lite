import { describe, expect, it } from 'vitest';

import { arity, eventually, NOT_INT, useServer, waitFor, waitForServerTime } from '@/tests/helpers';

/**
 * Hash field TTLs: HEXPIRE family, HTTL family, HPERSIST (hashes.ttl.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

describe('hashes: field TTL', () => {
  it('HEXPIRE sets TTL, return codes -2 / 1 / 2', async () => {
    await t.call('HSET', 'h:ex', 'a', '1', 'b', '2', 'c', '3');
    expect(await t.call('HEXPIRE', 'h:ex', 100, 'FIELDS', 2, 'a', 'nope')).toEqual([1, -2]);
    const ttl = (await t.call('HTTL', 'h:ex', 'FIELDS', 3, 'a', 'b', 'nope')) as number[];
    expect(ttl[0]).toBeGreaterThan(95);
    expect(ttl[0]).toBeLessThanOrEqual(100);
    expect(ttl.slice(1)).toEqual([-1, -2]);
    expect(await t.call('HEXPIRE', 'h:ex', 0, 'FIELDS', 1, 'b')).toEqual([2]);
    expect(await t.call('HEXISTS', 'h:ex', 'b')).toBe(0);
    expect(await t.call('HEXPIRE', 'h:ex-missing', 100, 'FIELDS', 2, 'a', 'b')).toEqual([-2, -2]);
  });

  it('NX / XX / GT / LT conditions', async () => {
    await t.call('HSET', 'h:cond', 'a', '1', 'b', '2');
    expect(await t.call('HEXPIRE', 'h:cond', 100, 'XX', 'FIELDS', 1, 'a')).toEqual([0]);
    expect(await t.call('HEXPIRE', 'h:cond', 100, 'GT', 'FIELDS', 1, 'a')).toEqual([0]);
    expect(await t.call('HEXPIRE', 'h:cond', 100, 'NX', 'FIELDS', 1, 'a')).toEqual([1]);
    expect(await t.call('HEXPIRE', 'h:cond', 200, 'NX', 'FIELDS', 1, 'a')).toEqual([0]);
    expect(await t.call('HEXPIRE', 'h:cond', 200, 'XX', 'FIELDS', 1, 'a')).toEqual([1]);
    expect(await t.call('HEXPIRE', 'h:cond', 100, 'GT', 'FIELDS', 1, 'a')).toEqual([0]);
    expect(await t.call('HEXPIRE', 'h:cond', 300, 'GT', 'FIELDS', 1, 'a')).toEqual([1]);
    expect(await t.call('HEXPIRE', 'h:cond', 400, 'LT', 'FIELDS', 1, 'a')).toEqual([0]);
    expect(await t.call('HEXPIRE', 'h:cond', 50, 'lt', 'FIELDS', 1, 'a')).toEqual([1]);
    // LT on a field without TTL: no TTL counts as infinite, so it is set
    expect(await t.call('HEXPIRE', 'h:cond', 50, 'LT', 'FIELDS', 2, 'b', 'zz')).toEqual([1, -2]);
    const ttl = (await t.call('HTTL', 'h:cond', 'FIELDS', 2, 'a', 'b')) as number[];
    expect(ttl.every((x) => x > 45 && x <= 50)).toBe(true);
  });

  it('HPEXPIRE / HEXPIREAT / HPEXPIREAT and the time getters', async () => {
    await t.call('HSET', 'h:pex', 'a', '1', 'b', '2', 'c', '3', 'd', '4');
    expect(await t.call('HPEXPIRE', 'h:pex', 100000, 'FIELDS', 1, 'a')).toEqual([1]);
    const pttl = (await t.call('HPTTL', 'h:pex', 'FIELDS', 1, 'a')) as number[];
    expect(pttl[0]).toBeGreaterThan(95000);
    expect(pttl[0]).toBeLessThanOrEqual(100000);
    const nowS = Math.floor(Date.now() / 1000);
    expect(await t.call('HEXPIREAT', 'h:pex', nowS + 1000, 'FIELDS', 1, 'b')).toEqual([1]);
    expect(await t.call('HEXPIRETIME', 'h:pex', 'FIELDS', 3, 'b', 'c', 'zz')).toEqual([nowS + 1000, -1, -2]);
    const atMs = Date.now() + 500000;
    expect(await t.call('HPEXPIREAT', 'h:pex', atMs, 'FIELDS', 1, 'c')).toEqual([1]);
    expect(await t.call('HPEXPIRETIME', 'h:pex', 'FIELDS', 1, 'c')).toEqual([atMs]);
    expect(await t.call('HEXPIRETIME', 'h:pex', 'FIELDS', 1, 'c')).toEqual([Math.floor(atMs / 1000)]);
    // past absolute time deletes the field
    expect(await t.call('HEXPIREAT', 'h:pex', 1, 'FIELDS', 1, 'd')).toEqual([2]);
    expect(await t.call('HPEXPIREAT', 'h:pex', 1, 'FIELDS', 1, 'zz')).toEqual([-2]);
    expect(await t.call('HEXISTS', 'h:pex', 'd')).toBe(0);
    expect(await t.call('HTTL', 'h:pex-missing', 'FIELDS', 1, 'a')).toEqual([-2]);
    expect(await t.call('HPTTL', 'h:pex-missing', 'FIELDS', 1, 'a')).toEqual([-2]);
    expect(await t.call('HEXPIRETIME', 'h:pex-missing', 'FIELDS', 1, 'a')).toEqual([-2]);
    expect(await t.call('HPEXPIRETIME', 'h:pex-missing', 'FIELDS', 1, 'a')).toEqual([-2]);
  });

  it('expired fields disappear; the key goes when the last field expires', async () => {
    await t.call('HSET', 'h:lazy', 'a', '1', 'b', '2');
    expect(await t.call('HPEXPIRE', 'h:lazy', 50, 'FIELDS', 1, 'a')).toEqual([1]);
    await waitForServerTime(t, ((await t.call('HPEXPIRETIME', 'h:lazy', 'FIELDS', 1, 'a')) as number[])[0]);
    await eventually(async () => expect(await t.call('HGET', 'h:lazy', 'a')).toBeNull()); // retried: the wall clock can be stepped back after the wait
    expect(await t.call('HGETALL', 'h:lazy')).toEqual(['b', '2']);
    // unverified: HLEN may still count an expired-but-not-yet-reclaimed field in Redis, so it is not asserted here
    expect(await t.call('HPEXPIRE', 'h:lazy', 50, 'FIELDS', 1, 'b')).toEqual([1]);
    await waitForServerTime(t, ((await t.call('HPEXPIRETIME', 'h:lazy', 'FIELDS', 1, 'b')) as number[])[0]);
    await eventually(async () => expect(await t.call('HGETALL', 'h:lazy')).toEqual([]));
    // Redis's active expire cycle reclaims expired fields (and then the empty key) within a few cycles
    // (polled with a generous cap: how many cycles run in a given time depends on the load)
    expect(await waitFor(async () => (await t.call('EXISTS', 'h:lazy')) === 0, { timeout: 20_000, interval: 50 })).toBe(true);
  });

  it('HPERSIST returns -2 / -1 / 1', async () => {
    await t.call('HSET', 'h:persist', 'a', '1', 'b', '2');
    await t.call('HEXPIRE', 'h:persist', 100, 'FIELDS', 1, 'a');
    expect(await t.call('HPERSIST', 'h:persist', 'FIELDS', 3, 'a', 'b', 'zz')).toEqual([1, -1, -2]);
    expect(await t.call('HTTL', 'h:persist', 'FIELDS', 1, 'a')).toEqual([-1]);
    expect(await t.call('HPERSIST', 'h:persist-missing', 'FIELDS', 1, 'a')).toEqual([-2]);
  });

  it('HSET on a field with a TTL clears the TTL', async () => {
    await t.call('HSET', 'h:hsetttl', 'a', '1');
    await t.call('HEXPIRE', 'h:hsetttl', 100, 'FIELDS', 1, 'a');
    await t.call('HSET', 'h:hsetttl', 'a', '2');
    expect(await t.call('HTTL', 'h:hsetttl', 'FIELDS', 1, 'a')).toEqual([-1]);
  });

  it('FIELDS / numfields errors', async () => {
    await t.call('HSET', 'h:experr', 'a', '1');
    const mismatch = 'ERR The `numfields` parameter must match the number of arguments';
    const missing = 'ERR Mandatory argument FIELDS is missing or not at the right position';
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'FIELDS', 2, 'a')).rejects.toThrow(mismatch);
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'FIELDS', 1, 'a', 'b')).rejects.toThrow(mismatch);
    await expect(t.call('HTTL', 'h:experr', 'FIELDS', 2, 'a')).rejects.toThrow(mismatch);
    await expect(t.call('HPERSIST', 'h:experr', 'FIELDS', 2, 'a')).rejects.toThrow(mismatch);
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'FOO', 'FIELDS', 1, 'a')).rejects.toThrow(missing);
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'NX', 1, 'a', 'b')).rejects.toThrow(missing);
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'FIELDS', 0, 'a')).rejects.toThrow('ERR Number of fields must be a positive integer');
    await expect(t.call('HEXPIRE', 'h:experr', 'x', 'FIELDS', 1, 'a')).rejects.toThrow(NOT_INT);
    await expect(t.call('HEXPIRE', 'h:experr', 10, 'FIELDS', 1)).rejects.toThrow(arity('hexpire'));
    await expect(t.call('HTTL', 'h:experr', 'FIELDS', 1)).rejects.toThrow(arity('httl'));
    await expect(t.call('HPERSIST', 'h:experr', 'a')).rejects.toThrow(arity('hpersist'));
  });

  it('RESP3 HTTL is an array of integers', async () => {
    await t.call('HSET', 'h:ttl3', 'a', '1');
    const r = await resp3();
    expect(await r.send('HTTL', 'h:ttl3', 'FIELDS', '2', 'a', 'b')).toBe('*2\r\n:-1\r\n:-2\r\n');
  });
});
