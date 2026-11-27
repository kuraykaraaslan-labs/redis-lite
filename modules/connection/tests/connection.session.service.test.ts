import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { Sock, enc, errOf } from './connection.test_helpers';

/**
 * Session commands: PING, ECHO, SELECT (with SWAPDB / DBSIZE / FLUSHDB / FLUSHALL), RESET, QUIT.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

describe('PING / ECHO', () => {
  it('PING replies with a status PONG, PING msg with a bulk string', async () => {
    const r = await t.raw();
    expect.soft(await r.send('PING')).toBe('+PONG\r\n');
    expect.soft(await r.send('PING', 'hello world')).toBe('$11\r\nhello world\r\n');
    expect.soft(await r.send('PING', '')).toBe('$0\r\n\r\n');
    expect.soft(await r.send('ping')).toBe('+PONG\r\n');
  });

  it('PING arity', async () => {
    expect.soft(await errOf(t.call('PING', 'a', 'b'))).toBe("ERR wrong number of arguments for 'ping' command");
  });

  it('PING in RESP3 is the same', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('PING')).toBe('+PONG\r\n');
    expect.soft(await r.send('PING', 'x')).toBe('$1\r\nx\r\n');
  });

  it('ECHO returns its argument as a bulk string', async () => {
    const r = await t.raw();
    expect.soft(await r.send('ECHO', 'Hello World!')).toBe('$12\r\nHello World!\r\n');
    expect.soft(await r.send('ECHO', '')).toBe('$0\r\n\r\n');
    expect.soft(await t.call('ECHO', 'bin\x00ary')).toBe('bin\x00ary');
  });

  it('ECHO arity', async () => {
    expect.soft(await errOf(t.call('ECHO'))).toBe("ERR wrong number of arguments for 'echo' command");
    expect.soft(await errOf(t.call('ECHO', 'a', 'b'))).toBe("ERR wrong number of arguments for 'echo' command");
  });
});

describe('SELECT / SWAPDB / DBSIZE / FLUSHDB / FLUSHALL', () => {
  it('SELECT switches database and keys are isolated', async () => {
    const r = await t.raw();
    expect.soft(await r.send('SELECT', '3')).toBe('+OK\r\n');
    expect.soft(await r.send('SET', 'sel:k', 'db3')).toBe('+OK\r\n');
    expect.soft(await r.send('SELECT', '0')).toBe('+OK\r\n');
    expect.soft(await r.send('GET', 'sel:k')).toBe('$-1\r\n');
    await r.send('SELECT', '3');
    expect.soft(await r.send('GET', 'sel:k')).toBe('$3\r\ndb3\r\n');
    await r.send('DEL', 'sel:k');
  });

  it('SELECT errors', async () => {
    const r = await t.raw();
    expect.soft(await r.send('SELECT', '16')).toBe('-ERR DB index is out of range\r\n');
    expect.soft(await r.send('SELECT', '-1')).toBe('-ERR DB index is out of range\r\n');
    expect.soft(await r.send('SELECT', 'abc')).toBe('-ERR value is not an integer or out of range\r\n');
    expect.soft(await r.send('SELECT')).toBe("-ERR wrong number of arguments for 'select' command\r\n");
    expect.soft(await r.send('SELECT', '1', '2')).toBe("-ERR wrong number of arguments for 'select' command\r\n");
  });

  it('DBSIZE counts keys of the selected db', async () => {
    const r = await t.raw();
    await r.send('SELECT', '7');
    await r.send('FLUSHDB');
    expect.soft(await r.send('DBSIZE')).toBe(':0\r\n');
    await r.send('SET', 'a', '1');
    await r.send('SET', 'b', '2');
    expect.soft(await r.send('DBSIZE')).toBe(':2\r\n');
    expect.soft(await r.send('DBSIZE', 'x')).toBe("-ERR wrong number of arguments for 'dbsize' command\r\n");
    await r.send('FLUSHDB');
  });

  it('FLUSHDB empties only the selected db, supports ASYNC/SYNC', async () => {
    const r = await t.raw();
    await r.send('SELECT', '8');
    await r.send('SET', 'f1', '1');
    await r.send('SELECT', '9');
    await r.send('SET', 'f2', '1');
    expect.soft(await r.send('FLUSHDB')).toBe('+OK\r\n');
    expect.soft(await r.send('DBSIZE')).toBe(':0\r\n');
    await r.send('SELECT', '8');
    expect.soft(await r.send('DBSIZE')).toBe(':1\r\n');
    expect.soft(await r.send('FLUSHDB', 'ASYNC')).toBe('+OK\r\n');
    expect.soft(await r.send('DBSIZE')).toBe(':0\r\n');
    await r.send('SET', 'f1', '1');
    expect.soft(await r.send('FLUSHDB', 'sync')).toBe('+OK\r\n');
    expect.soft(await r.send('DBSIZE')).toBe(':0\r\n');
    expect.soft(await r.send('FLUSHDB', 'foo')).toBe('-ERR syntax error\r\n');
    expect.soft(await r.send('FLUSHDB', 'ASYNC', 'SYNC')).toBe('-ERR syntax error\r\n');
  });

  it('SWAPDB swaps the contents of two databases', async () => {
    const r = await t.raw();
    await r.send('SELECT', '10');
    await r.send('FLUSHDB');
    await r.send('SET', 'sw', 'ten');
    await r.send('SELECT', '11');
    await r.send('FLUSHDB');
    expect.soft(await r.send('SWAPDB', '10', '11')).toBe('+OK\r\n');
    expect.soft(await r.send('GET', 'sw')).toBe('$3\r\nten\r\n');
    await r.send('SELECT', '10');
    expect.soft(await r.send('GET', 'sw')).toBe('$-1\r\n');
    expect.soft(await r.send('SWAPDB', '10', '10')).toBe('+OK\r\n');
    await r.send('SELECT', '11');
    await r.send('FLUSHDB');
  });

  it('SWAPDB errors', async () => {
    const r = await t.raw();
    expect.soft(await r.send('SWAPDB', '0', '99')).toBe('-ERR DB index is out of range\r\n');
    expect.soft(await r.send('SWAPDB', 'a', '1')).toBe('-ERR invalid first DB index\r\n');
    expect.soft(await r.send('SWAPDB', '0', 'b')).toBe('-ERR invalid second DB index\r\n');
    expect.soft(await r.send('SWAPDB', '0')).toBe("-ERR wrong number of arguments for 'swapdb' command\r\n");
  });

  it('FLUSHALL empties every db', async () => {
    const r = await t.raw();
    await r.send('SELECT', '12');
    await r.send('SET', 'fa', '1');
    await r.send('SELECT', '13');
    await r.send('SET', 'fb', '1');
    expect.soft(await r.send('FLUSHALL')).toBe('+OK\r\n');
    expect.soft(await r.send('DBSIZE')).toBe(':0\r\n');
    await r.send('SELECT', '12');
    expect.soft(await r.send('DBSIZE')).toBe(':0\r\n');
    expect.soft(await r.send('FLUSHALL', 'ASYNC')).toBe('+OK\r\n');
    expect.soft(await r.send('FLUSHALL', 'SYNC')).toBe('+OK\r\n');
    expect.soft(await r.send('FLUSHALL', 'bad')).toBe('-ERR syntax error\r\n');
  });
});

describe('RESET / QUIT', () => {
  it('RESET restores connection defaults', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    await r.send('SELECT', '4');
    await r.send('CLIENT', 'SETNAME', 'to-reset');
    await r.send('MULTI');
    expect.soft(await r.send('RESET')).toBe('+RESET\r\n');
    // back to RESP2, no name, db 0, not in MULTI
    expect.soft(await r.send('CLIENT', 'GETNAME')).toBe('$-1\r\n');
    const info = await r.send('CLIENT', 'INFO');
    expect.soft(info).toMatch(/ db=0 /);
    expect.soft(info).toMatch(/ resp=2\n\r\n$/);
    expect.soft(await r.send('EXEC')).toBe('-ERR EXEC without MULTI\r\n');
  });

  it('RESET leaves subscriber mode', async () => {
    const r = await t.raw();
    await r.send('SUBSCRIBE', 'reset-ch');
    expect.soft(await r.send('RESET')).toBe('+RESET\r\n');
    expect.soft(await r.send('GET', 'reset:missing')).toBe('$-1\r\n');
  });

  it('RESET clears WATCH', async () => {
    const r = await t.raw();
    await r.send('WATCH', 'reset:w');
    await r.send('RESET');
    await t.call('SET', 'reset:w', '1');
    await r.send('MULTI');
    await r.send('PING');
    expect.soft(await r.send('EXEC')).toBe('*1\r\n+PONG\r\n');
  });

  it('RESET arity', async () => {
    expect.soft(await errOf(t.call('RESET', 'x'))).toBe("ERR wrong number of arguments for 'reset' command");
  });

  it('QUIT replies OK and closes the connection', async () => {
    const s = await Sock.open(t.server.port);
    expect.soft(await s.write(enc('QUIT'))).toBe('+OK\r\n');
    expect.soft(await s.waitClosed()).toBe(true);
  });
});
