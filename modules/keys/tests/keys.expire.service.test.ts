import { describe, expect, it } from 'vitest';

import { arity, err, eventually, NOT_INT, useServer, waitPastExpiry } from '@/tests/helpers';

/**
 * EXPIRE family, TTL family, PERSIST (keys.expire.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

describe('EXPIRE / PEXPIRE / EXPIREAT / PEXPIREAT', () => {
  it('EXPIRE sets a TTL (docs example)', async () => {
    await t.call('SET', 'exp:a', 'Hello');
    expect(await t.call('EXPIRE', 'exp:a', 10)).toBe(1);
    expect(await t.call('TTL', 'exp:a')).toBe(10);
    await t.call('SET', 'exp:a', 'Hello World');
    expect(await t.call('TTL', 'exp:a')).toBe(-1);
    expect(await t.call('EXPIRE', 'exp:missing', 10)).toBe(0);
  });

  it('NX / XX / GT / LT (docs example)', async () => {
    await t.call('SET', 'exp:o', 'v');
    expect(await t.call('EXPIRE', 'exp:o', 10, 'XX')).toBe(0);
    expect(await t.call('TTL', 'exp:o')).toBe(-1);
    expect(await t.call('EXPIRE', 'exp:o', 10, 'NX')).toBe(1);
    expect(await t.call('TTL', 'exp:o')).toBe(10);
    expect(await t.call('EXPIRE', 'exp:o', 20, 'NX')).toBe(0);
    expect(await t.call('EXPIRE', 'exp:o', 20, 'XX')).toBe(1);
    expect(await t.call('EXPIRE', 'exp:o', 5, 'GT')).toBe(0);
    expect(await t.call('EXPIRE', 'exp:o', 30, 'GT')).toBe(1);
    expect(await t.call('EXPIRE', 'exp:o', 40, 'LT')).toBe(0);
    expect(await t.call('EXPIRE', 'exp:o', 15, 'LT')).toBe(1);
    expect(await t.call('TTL', 'exp:o')).toBe(15);
  });

  it('GT / LT on a key without TTL (treated as infinite)', async () => {
    await t.call('SET', 'exp:inf', 'v');
    expect(await t.call('EXPIRE', 'exp:inf', 100, 'GT')).toBe(0);
    expect(await t.call('TTL', 'exp:inf')).toBe(-1);
    expect(await t.call('EXPIRE', 'exp:inf', 100, 'LT')).toBe(1);
    expect(await t.call('TTL', 'exp:inf')).toBe(100);
  });

  it('options are case-insensitive and combinable (NX GT is not allowed, XX GT is)', async () => {
    await t.call('SET', 'exp:c', 'v', 'EX', 10);
    expect(await t.call('EXPIRE', 'exp:c', 50, 'xx', 'gt')).toBe(1);
    expect(await t.call('TTL', 'exp:c')).toBe(50);
  });

  it('zero / negative / past times delete the key', async () => {
    await t.call('SET', 'exp:z', 'v');
    expect(await t.call('EXPIRE', 'exp:z', 0)).toBe(1);
    expect(await t.call('EXISTS', 'exp:z')).toBe(0);
    await t.call('SET', 'exp:n', 'v');
    expect(await t.call('PEXPIRE', 'exp:n', -100)).toBe(1);
    expect(await t.call('EXISTS', 'exp:n')).toBe(0);
    await t.call('SET', 'exp:p', 'v');
    expect(await t.call('EXPIREAT', 'exp:p', 1000)).toBe(1);
    expect(await t.call('EXISTS', 'exp:p')).toBe(0);
    await t.call('SET', 'exp:pp', 'v');
    expect(await t.call('PEXPIREAT', 'exp:pp', 1000)).toBe(1);
    expect(await t.call('GET', 'exp:pp')).toBeNull();
  });

  it('PEXPIRE / EXPIREAT / PEXPIREAT set the expected deadlines', async () => {
    await t.call('SET', 'exp:pe', 'v');
    expect(await t.call('PEXPIRE', 'exp:pe', 100000)).toBe(1);
    const pttl = (await t.call('PTTL', 'exp:pe')) as number;
    expect(pttl).toBeGreaterThan(95000);
    expect(pttl).toBeLessThanOrEqual(100000);
    const at = Math.floor(Date.now() / 1000) + 1000;
    await t.call('SET', 'exp:at', 'v');
    expect(await t.call('EXPIREAT', 'exp:at', at)).toBe(1);
    expect(await t.call('EXPIRETIME', 'exp:at')).toBe(at);
    expect(await t.call('PEXPIRETIME', 'exp:at')).toBe(at * 1000);
    const pat = Date.now() + 500000;
    await t.call('SET', 'exp:pat', 'v');
    expect(await t.call('PEXPIREAT', 'exp:pat', pat)).toBe(1);
    expect(await t.call('PEXPIRETIME', 'exp:pat')).toBe(pat);
    expect(await t.call('EXPIRETIME', 'exp:pat')).toBe(Math.floor((pat + 500) / 1000));
    expect(await t.call('EXPIREAT', 'exp:missing', at)).toBe(0);
    expect(await t.call('PEXPIREAT', 'exp:missing', pat)).toBe(0);
  });

  it('key actually expires', async () => {
    await t.call('SET', 'exp:real', 'v');
    await t.call('PEXPIRE', 'exp:real', 40);
    await waitPastExpiry(t, 'exp:real');
    await eventually(async () => expect(await t.call('GET', 'exp:real')).toBeNull()); // retried: the wall clock can be stepped back after the wait
    expect(await t.call('TTL', 'exp:real')).toBe(-2);
  });

  it('errors', async () => {
    await t.call('SET', 'exp:e', 'v');
    expect(await err(t.call('EXPIRE', 'exp:e', 'abc'))).toBe(NOT_INT);
    expect(await err(t.call('EXPIRE', 'exp:e', '1.5'))).toBe(NOT_INT);
    expect(await err(t.call('EXPIRE', 'exp:e', 10, 'NX', 'XX'))).toBe('ERR NX and XX, GT or LT options at the same time are not compatible');
    expect(await err(t.call('EXPIRE', 'exp:e', 10, 'NX', 'GT'))).toBe('ERR NX and XX, GT or LT options at the same time are not compatible');
    expect(await err(t.call('EXPIRE', 'exp:e', 10, 'GT', 'LT'))).toBe('ERR GT and LT options at the same time are not compatible');
    expect(await err(t.call('EXPIRE', 'exp:e', 10, 'FOO'))).toBe('ERR Unsupported option FOO');
    expect(await err(t.call('EXPIRE', 'exp:e', '9223372036854775807'))).toBe("ERR invalid expire time in 'expire' command");
    expect(await err(t.call('PEXPIRE', 'exp:e', '9223372036854775807'))).toBe("ERR invalid expire time in 'pexpire' command");
    expect(await err(t.call('EXPIREAT', 'exp:e', '9223372036854775807'))).toBe("ERR invalid expire time in 'expireat' command");
    expect(await err(t.call('EXPIRE', 'exp:e'))).toBe(arity('expire'));
    expect(await err(t.call('PEXPIRE', 'exp:e'))).toBe(arity('pexpire'));
    expect(await err(t.call('EXPIREAT', 'exp:e'))).toBe(arity('expireat'));
    expect(await err(t.call('PEXPIREAT', 'exp:e'))).toBe(arity('pexpireat'));
    expect(await t.call('EXISTS', 'exp:e')).toBe(1);
  });
});

describe('TTL / PTTL / EXPIRETIME / PEXPIRETIME / PERSIST', () => {
  it('-2 for missing, -1 for no TTL', async () => {
    await t.call('SET', 'ttl:p', 'v');
    for (const cmd of ['TTL', 'PTTL', 'EXPIRETIME', 'PEXPIRETIME']) {
      expect(await t.call(cmd, 'ttl:missing')).toBe(-2);
      expect(await t.call(cmd, 'ttl:p')).toBe(-1);
    }
  });

  it('TTL rounds to the nearest second', async () => {
    await t.call('SET', 'ttl:r', 'v', 'PX', 10400);
    expect(await t.call('TTL', 'ttl:r')).toBe(10);
    await t.call('SET', 'ttl:r2', 'v', 'PX', 10900);
    expect(await t.call('TTL', 'ttl:r2')).toBe(11);
  });

  it('EXPIRETIME docs example', async () => {
    await t.call('SET', 'ttl:et', 'Hello');
    expect(await t.call('EXPIREAT', 'ttl:et', 33177117420)).toBe(1);
    expect(await t.call('EXPIRETIME', 'ttl:et')).toBe(33177117420);
    expect(await t.call('PEXPIRETIME', 'ttl:et')).toBe(33177117420000);
  });

  it('PERSIST removes the TTL', async () => {
    await t.call('SET', 'ttl:ps', 'v', 'EX', 10);
    expect(await t.call('PERSIST', 'ttl:ps')).toBe(1);
    expect(await t.call('TTL', 'ttl:ps')).toBe(-1);
    expect(await t.call('PERSIST', 'ttl:ps')).toBe(0);
    expect(await t.call('PERSIST', 'ttl:none')).toBe(0);
  });

  it('works on non-string types', async () => {
    await t.call('RPUSH', 'ttl:l', 'a');
    expect(await t.call('EXPIRE', 'ttl:l', 50)).toBe(1);
    expect(await t.call('TTL', 'ttl:l')).toBe(50);
  });

  it('arity errors', async () => {
    expect(await err(t.call('TTL'))).toBe(arity('ttl'));
    expect(await err(t.call('PTTL', 'a', 'b'))).toBe(arity('pttl'));
    expect(await err(t.call('EXPIRETIME'))).toBe(arity('expiretime'));
    expect(await err(t.call('PEXPIRETIME'))).toBe(arity('pexpiretime'));
    expect(await err(t.call('PERSIST'))).toBe(arity('persist'));
  });
});
