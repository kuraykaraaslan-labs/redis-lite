import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { errOf } from './transactions.test_helpers';

/**
 * MULTI, EXEC, DISCARD.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

describe('MULTI / EXEC / DISCARD', () => {
  it('queues commands and EXEC returns all replies', async () => {
    const r = await t.raw();
    expect.soft(await r.send('MULTI')).toBe('+OK\r\n');
    expect.soft(await r.send('SET', 'tx:a', '1')).toBe('+QUEUED\r\n');
    expect.soft(await r.send('INCR', 'tx:a')).toBe('+QUEUED\r\n');
    expect.soft(await r.send('GET', 'tx:a')).toBe('+QUEUED\r\n');
    expect.soft(await r.send('EXEC')).toBe('*3\r\n+OK\r\n:2\r\n$1\r\n2\r\n');
  });

  it('empty transaction returns an empty array', async () => {
    const r = await t.raw();
    await r.send('MULTI');
    expect.soft(await r.send('EXEC')).toBe('*0\r\n');
  });

  it('runtime errors are returned inside the EXEC array, other commands still run', async () => {
    const r = await t.raw();
    await r.send('MULTI');
    await r.send('SET', 'tx:b', 'abc');
    await r.send('INCR', 'tx:b');
    await r.send('LPUSH', 'tx:b', 'x');
    await r.send('SET', 'tx:b2', 'ok');
    expect.soft(await r.send('EXEC')).toBe(
      '*4\r\n+OK\r\n-ERR value is not an integer or out of range\r\n' +
        '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n+OK\r\n',
    );
    expect.soft(await t.call('GET', 'tx:b2')).toBe('ok');
  });

  it('queue-time errors abort the transaction with EXECABORT', async () => {
    const r = await t.raw();
    await r.send('MULTI');
    expect.soft(await r.send('SET', 'tx:c', '1')).toBe('+QUEUED\r\n');
    expect.soft(await r.send('GET')).toBe("-ERR wrong number of arguments for 'get' command\r\n");
    expect.soft(await r.send('EXEC')).toBe('-EXECABORT Transaction discarded because of previous errors.\r\n');
    expect.soft(await t.call('GET', 'tx:c')).toBeNull();
    expect.soft(await r.send('EXEC')).toBe('-ERR EXEC without MULTI\r\n');
  });

  it('unknown command inside MULTI aborts too', async () => {
    const r = await t.raw();
    await r.send('MULTI');
    expect.soft(await r.send('NOSUCHCMD', 'x')).toBe("-ERR unknown command 'NOSUCHCMD', with args beginning with: 'x' \r\n");
    expect.soft(await r.send('EXEC')).toBe('-EXECABORT Transaction discarded because of previous errors.\r\n');
  });

  it('nested MULTI is an error', async () => {
    const r = await t.raw();
    await r.send('MULTI');
    expect.soft(await r.send('MULTI')).toBe('-ERR MULTI calls can not be nested\r\n');
    await r.send('DISCARD');
  });

  it('WATCH inside MULTI is an error', async () => {
    const r = await t.raw();
    await r.send('MULTI');
    expect.soft(await r.send('WATCH', 'tx:w0')).toBe('-ERR WATCH inside MULTI is not allowed\r\n');
    await r.send('DISCARD');
  });

  it('EXEC / DISCARD without MULTI', async () => {
    expect.soft(await errOf(t.call('EXEC'))).toBe('ERR EXEC without MULTI');
    expect.soft(await errOf(t.call('DISCARD'))).toBe('ERR DISCARD without MULTI');
  });

  it('DISCARD drops queued commands', async () => {
    const r = await t.raw();
    await r.send('MULTI');
    await r.send('SET', 'tx:d', '1');
    expect.soft(await r.send('DISCARD')).toBe('+OK\r\n');
    expect.soft(await t.call('GET', 'tx:d')).toBeNull();
    expect.soft(await r.send('EXEC')).toBe('-ERR EXEC without MULTI\r\n');
  });

  it('arity of MULTI / EXEC / DISCARD / WATCH / UNWATCH', async () => {
    expect.soft(await errOf(t.call('MULTI', 'x'))).toBe("ERR wrong number of arguments for 'multi' command");
    // Redis answers a wrong-arity EXEC with EXECABORT, even outside MULTI (verified against the oracle).
    expect.soft(await errOf(t.call('EXEC', 'x'))).toBe("EXECABORT Transaction discarded because of: wrong number of arguments for 'exec' command");
    expect.soft(await errOf(t.call('DISCARD', 'x'))).toBe("ERR wrong number of arguments for 'discard' command");
    expect.soft(await errOf(t.call('WATCH'))).toBe("ERR wrong number of arguments for 'watch' command");
    expect.soft(await errOf(t.call('UNWATCH', 'x'))).toBe("ERR wrong number of arguments for 'unwatch' command");
  });

  it('MULTI in RESP3 returns typed replies', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    await t.call('HSET', 'tx:h3', 'f', 'v');
    await r.send('MULTI');
    await r.send('HGETALL', 'tx:h3');
    await r.send('GET', 'tx:missing3');
    expect.soft(await r.send('EXEC')).toBe('*2\r\n%1\r\n$1\r\nf\r\n$1\r\nv\r\n_\r\n');
  });

  it('CLIENT LIST shows the multi flag and queued count', async () => {
    const r = await t.raw();
    const id = Number((await r.send('CLIENT', 'ID')).slice(1, -2));
    await r.send('MULTI');
    await r.send('PING');
    const list = String(await t.call('CLIENT', 'LIST', 'ID', id));
    expect.soft(list).toMatch(/ flags=x /);
    expect.soft(list).toMatch(/ multi=1 /);
    await r.send('DISCARD');
  });
});
