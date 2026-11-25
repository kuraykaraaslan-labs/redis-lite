import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';

/**
 * Transaction commands.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

/** Returns the error message a promise rejects with. */
async function errOf(p: Promise<unknown>): Promise<string> {
  let res: unknown;
  try {
    res = await p;
  } catch (e) {
    return (e as Error).message;
  }
  return `<no error, got ${JSON.stringify(res)}>`;
}

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
    expect.soft(await errOf(t.call('EXEC', 'x'))).toBe("ERR wrong number of arguments for 'exec' command");
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
