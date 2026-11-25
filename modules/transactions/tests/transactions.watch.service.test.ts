import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';

/**
 * WATCH, UNWATCH.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

describe('WATCH / UNWATCH', () => {
  it('EXEC succeeds when watched keys are untouched', async () => {
    const r = await t.raw();
    await t.call('SET', 'w:a', '1');
    expect.soft(await r.send('WATCH', 'w:a')).toBe('+OK\r\n');
    await r.send('MULTI');
    await r.send('INCR', 'w:a');
    expect.soft(await r.send('EXEC')).toBe('*1\r\n:2\r\n');
  });

  it('EXEC aborts with null when another client modifies a watched key', async () => {
    const r = await t.raw();
    await t.call('SET', 'w:b', '1');
    await r.send('WATCH', 'w:b');
    await t.call('SET', 'w:b', '2');
    await r.send('MULTI');
    await r.send('SET', 'w:b', '3');
    expect.soft(await r.send('EXEC')).toBe('*-1\r\n');
    expect.soft(await t.call('GET', 'w:b')).toBe('2');
  });

  it('aborted EXEC is null in RESP3', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    await r.send('WATCH', 'w:b3');
    await t.call('SET', 'w:b3', '2');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('_\r\n');
  });

  it('own modification of a watched key also aborts', async () => {
    const r = await t.raw();
    await r.send('WATCH', 'w:c');
    await r.send('SET', 'w:c', '1');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*-1\r\n');
  });

  it('setting the same value still counts as a modification', async () => {
    const r = await t.raw();
    await t.call('SET', 'w:same', 'v');
    await r.send('WATCH', 'w:same');
    await t.call('SET', 'w:same', 'v');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*-1\r\n');
  });

  it('watching a key that is created aborts', async () => {
    const r = await t.raw();
    await r.send('WATCH', 'w:new');
    await t.call('LPUSH', 'w:new', 'x');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*-1\r\n');
  });

  it('no-op writes do not abort the transaction', async () => {
    const r = await t.raw();
    await t.call('SADD', 'w:set', 'a');
    await r.send('WATCH', 'w:noop', 'w:set');
    await t.call('DEL', 'w:noop');
    await t.call('SREM', 'w:set', 'zzz');
    await t.call('EXPIRE', 'w:noop', '100');
    await t.call('PERSIST', 'w:set');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*1\r\n+PONG\r\n');
  });

  it('a watched key that expires aborts the transaction', async () => {
    const r = await t.raw();
    await t.call('SET', 'w:exp', 'v', 'PX', '50');
    await r.send('WATCH', 'w:exp');
    await sleep(120);
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*-1\r\n');
  });

  it('FLUSHALL / FLUSHDB abort transactions watching existing keys', async () => {
    const r = await t.raw();
    await r.send('SELECT', '14');
    await r.send('SET', 'w:fl', '1');
    await r.send('WATCH', 'w:fl');
    const o = await t.raw();
    await o.send('SELECT', '14');
    await o.send('FLUSHDB');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*-1\r\n');
  });

  it('FLUSHDB does not abort when the watched key did not exist', async () => {
    const r = await t.raw();
    await r.send('SELECT', '14');
    await r.send('WATCH', 'w:flmissing');
    const o = await t.raw();
    await o.send('SELECT', '14');
    await o.send('FLUSHDB');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*1\r\n+PONG\r\n');
  });

  it('SWAPDB aborts transactions watching keys in the swapped db', async () => {
    const r = await t.raw();
    await r.send('SELECT', '15');
    await r.send('FLUSHDB');
    await r.send('SET', 'w:swap', '1');
    await r.send('WATCH', 'w:swap');
    await t.call('SWAPDB', '15', '14');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*-1\r\n');
    await t.call('SWAPDB', '15', '14');
    await r.send('FLUSHDB');
  });

  it('watched keys are per database', async () => {
    const r = await t.raw();
    await r.send('SELECT', '2');
    await r.send('WATCH', 'w:db');
    await t.call('SET', 'w:db', 'in db0');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*1\r\n+PONG\r\n');
  });

  it('UNWATCH forgets watched keys', async () => {
    const r = await t.raw();
    await r.send('WATCH', 'w:u');
    expect.soft(await r.send('UNWATCH')).toBe('+OK\r\n');
    await t.call('SET', 'w:u', '1');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*1\r\n+PONG\r\n');
  });

  it('EXEC and DISCARD unwatch all keys', async () => {
    const r = await t.raw();
    await r.send('WATCH', 'w:e');
    await r.send('MULTI');
    await r.send('DISCARD');
    await t.call('SET', 'w:e', '1');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*1\r\n+PONG\r\n');
    await r.send('WATCH', 'w:e');
    await t.call('SET', 'w:e', '2');
    await r.send('MULTI');
    expect.soft(await r.send('EXEC')).toBe('*-1\r\n');
    await t.call('SET', 'w:e', '3');
    await r.send('MULTI');
    expect.soft(await r.send('EXEC')).toBe('*0\r\n');
  });

  it('UNWATCH inside MULTI is queued', async () => {
    const r = await t.raw();
    await r.send('MULTI');
    expect.soft(await r.send('UNWATCH')).toBe('+QUEUED\r\n');
    expect.soft(await r.send('EXEC')).toBe('*1\r\n+OK\r\n');
  });

  it('WATCH several keys, any modification aborts', async () => {
    const r = await t.raw();
    await r.send('WATCH', 'w:m1', 'w:m2', 'w:m3');
    await t.call('SET', 'w:m3', 'x');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*-1\r\n');
  });
});
