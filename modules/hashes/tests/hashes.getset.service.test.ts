import { describe, expect, it } from 'vitest';

import { arity, NOT_INT, useServer } from '@/tests/helpers';

/**
 * HGETDEL, HGETEX, HSETEX (hashes.getset.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

describe('hashes: HGETDEL / HGETEX / HSETEX', () => {
  it('HGETDEL returns values and deletes; the key goes when empty', async () => {
    await t.call('HSET', 'h:gd', 'a', '1', 'b', '2', 'c', '3');
    expect(await t.call('HGETDEL', 'h:gd', 'FIELDS', 2, 'a', 'zz')).toEqual(['1', null]);
    expect(await t.call('HKEYS', 'h:gd')).toEqual(['b', 'c']);
    expect(await t.call('HGETDEL', 'h:gd', 'FIELDS', 2, 'b', 'c')).toEqual(['2', '3']);
    expect(await t.call('EXISTS', 'h:gd')).toBe(0);
    expect(await t.call('HGETDEL', 'h:gd', 'FIELDS', 1, 'a')).toEqual([null]);
    await expect(t.call('HGETDEL', 'h:gd', 'FIELDS', 2, 'a')).rejects.toThrow(
      'ERR The `numfields` parameter must match the number of arguments',
    );
    await expect(t.call('HGETDEL', 'h:gd', 'FIELDS', 0, 'a')).rejects.toThrow('ERR Number of fields must be a positive integer');
    await expect(t.call('HGETDEL', 'h:gd', 'a')).rejects.toThrow(arity('hgetdel'));
  });

  it('HGETEX sets / clears TTLs while reading', async () => {
    await t.call('HSET', 'h:gex', 'a', '1', 'b', '2');
    expect(await t.call('HGETEX', 'h:gex', 'FIELDS', 2, 'a', 'zz')).toEqual(['1', null]);
    expect(await t.call('HTTL', 'h:gex', 'FIELDS', 1, 'a')).toEqual([-1]);
    expect(await t.call('HGETEX', 'h:gex', 'EX', 100, 'FIELDS', 1, 'a')).toEqual(['1']);
    const ttl = (await t.call('HTTL', 'h:gex', 'FIELDS', 1, 'a')) as number[];
    expect(ttl[0]).toBeGreaterThan(95);
    expect(await t.call('HGETEX', 'h:gex', 'PX', 200000, 'FIELDS', 1, 'b')).toEqual(['2']);
    const pttl = (await t.call('HPTTL', 'h:gex', 'FIELDS', 1, 'b')) as number[];
    expect(pttl[0]).toBeGreaterThan(190000);
    const at = Math.floor(Date.now() / 1000) + 1000;
    expect(await t.call('HGETEX', 'h:gex', 'EXAT', at, 'FIELDS', 1, 'a')).toEqual(['1']);
    expect(await t.call('HEXPIRETIME', 'h:gex', 'FIELDS', 1, 'a')).toEqual([at]);
    const atMs = Date.now() + 1000000;
    expect(await t.call('HGETEX', 'h:gex', 'PXAT', atMs, 'FIELDS', 1, 'a')).toEqual(['1']);
    expect(await t.call('HPEXPIRETIME', 'h:gex', 'FIELDS', 1, 'a')).toEqual([atMs]);
    expect(await t.call('HGETEX', 'h:gex', 'PERSIST', 'FIELDS', 2, 'a', 'b')).toEqual(['1', '2']);
    expect(await t.call('HTTL', 'h:gex', 'FIELDS', 2, 'a', 'b')).toEqual([-1, -1]);
    expect(await t.call('HGETEX', 'h:gex-missing', 'EX', 10, 'FIELDS', 1, 'a')).toEqual([null]);
    await expect(t.call('HGETEX', 'h:gex', 'EX', 10, 'FIELDS', 2, 'a')).rejects.toThrow(
      'ERR The `numfields` parameter must match the number of arguments',
    );
    await expect(t.call('HGETEX', 'h:gex', 'EX', 'x', 'FIELDS', 1, 'a')).rejects.toThrow(NOT_INT);
    await expect(t.call('HGETEX', 'h:gex', 'a')).rejects.toThrow(arity('hgetex'));
  });

  it('HSETEX with FNX / FXX / EX / KEEPTTL', async () => {
    expect(await t.call('HSETEX', 'h:sex', 'FIELDS', 2, 'a', '1', 'b', '2')).toBe(1);
    expect(await t.call('HMGET', 'h:sex', 'a', 'b')).toEqual(['1', '2']);
    expect(await t.call('HSETEX', 'h:sex', 'FNX', 'FIELDS', 2, 'a', 'x', 'c', '3')).toBe(0);
    expect(await t.call('HMGET', 'h:sex', 'a', 'c')).toEqual(['1', null]);
    expect(await t.call('HSETEX', 'h:sex', 'FXX', 'FIELDS', 2, 'a', 'x', 'c', '3')).toBe(0);
    expect(await t.call('HMGET', 'h:sex', 'a', 'c')).toEqual(['1', null]);
    expect(await t.call('HSETEX', 'h:sex', 'FNX', 'FIELDS', 1, 'c', '3')).toBe(1);
    expect(await t.call('HSETEX', 'h:sex', 'FXX', 'EX', 100, 'FIELDS', 2, 'a', 'A', 'b', 'B')).toBe(1);
    expect(await t.call('HMGET', 'h:sex', 'a', 'b')).toEqual(['A', 'B']);
    const ttl = (await t.call('HTTL', 'h:sex', 'FIELDS', 2, 'a', 'b')) as number[];
    expect(ttl.every((x) => x > 95 && x <= 100)).toBe(true);
    expect(await t.call('HSETEX', 'h:sex', 'KEEPTTL', 'FIELDS', 1, 'a', 'AA')).toBe(1);
    const kept = (await t.call('HTTL', 'h:sex', 'FIELDS', 1, 'a')) as number[];
    expect(kept[0]).toBeGreaterThan(95);
    expect(await t.call('HSETEX', 'h:sex', 'FIELDS', 1, 'a', 'AAA')).toBe(1);
    expect(await t.call('HTTL', 'h:sex', 'FIELDS', 1, 'a')).toEqual([-1]);
    expect(await t.call('HSETEX', 'h:sex', 'PX', 100000, 'FIELDS', 1, 'b', 'x')).toBe(1);
    const pttl = (await t.call('HPTTL', 'h:sex', 'FIELDS', 1, 'b')) as number[];
    expect(pttl[0]).toBeGreaterThan(99000);
    // FXX on a missing key: nothing to update
    expect(await t.call('HSETEX', 'h:sex-missing', 'FXX', 'FIELDS', 1, 'a', '1')).toBe(0);
    expect(await t.call('EXISTS', 'h:sex-missing')).toBe(0);
  });

  it('HSETEX errors', async () => {
    // unverified: exact text of the numfields mismatch error for HSETEX; only assert that it errors
    await expect(t.call('HSETEX', 'h:sexerr', 'FIELDS', 2, 'a', '1')).rejects.toThrow();
    await expect(t.call('HSETEX', 'h:sexerr', 'FIELDS', 1, 'a')).rejects.toThrow(arity('hsetex'));
    expect(await t.call('EXISTS', 'h:sexerr')).toBe(0);
  });

  it('HSETEX rejects two expiration options', async () => {
    // unverified (high confidence): only one of EX/PX/EXAT/PXAT/KEEPTTL is allowed; exact error text not asserted
    await expect(t.call('HSETEX', 'h:sexerr2', 'EX', 10, 'PX', 10, 'FIELDS', 1, 'a', '1')).rejects.toThrow();
    expect(await t.call('EXISTS', 'h:sexerr2')).toBe(0);
  });

  it('HSETEX rejects FNX together with FXX', async () => {
    // unverified (high confidence): FNX and FXX are mutually exclusive; exact error text not asserted
    await expect(t.call('HSETEX', 'h:sexerr', 'FNX', 'FXX', 'FIELDS', 1, 'a', '1')).rejects.toThrow();
  });
});
