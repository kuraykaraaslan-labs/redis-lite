import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { Sock, enc, errOf, pairs } from './connection.test_helpers';

/**
 * Authentication and handshake: AUTH, HELLO, a server with a password.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

describe('AUTH without a configured password', () => {
  it('AUTH <password> reports that no password is configured', async () => {
    expect.soft(await errOf(t.call('AUTH', 'x'))).toBe(
      'ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?',
    );
  });

  it('AUTH default <anything> succeeds for the nopass default user', async () => {
    expect.soft(await t.call('AUTH', 'default', 'whatever')).toBe('OK');
  });

  it('AUTH with an unknown user is WRONGPASS', async () => {
    expect.soft(await errOf(t.call('AUTH', 'nobody', 'pw'))).toBe('WRONGPASS invalid username-password pair or user is disabled.');
  });

  it('AUTH arity and syntax', async () => {
    expect.soft(await errOf(t.call('AUTH'))).toBe("ERR wrong number of arguments for 'auth' command");
    expect.soft(await errOf(t.call('AUTH', 'a', 'b', 'c'))).toBe('ERR syntax error');
  });
});

describe('HELLO', () => {
  it('HELLO 3 returns the RESP3 map and switches protocol', async () => {
    const r = await t.raw();
    const hello = await r.send('HELLO', '3');
    expect.soft(hello.startsWith('%7\r\n$6\r\nserver\r\n$5\r\nredis\r\n$7\r\nversion\r\n')).toBe(true);
    expect.soft(hello).toContain('$7\r\nversion\r\n$6\r\n7.0.15\r\n');
    expect.soft(hello).toContain('$5\r\nproto\r\n:3\r\n');
    expect.soft(hello).toMatch(/\$2\r\nid\r\n:\d+\r\n/);
    expect.soft(hello).toContain('$4\r\nmode\r\n$10\r\nstandalone\r\n');
    expect.soft(hello).toContain('$4\r\nrole\r\n$6\r\nmaster\r\n');
    expect.soft(hello).toMatch(/\$7\r\nmodules\r\n\*\d+\r\n/);
    expect.soft(await r.send('GET', 'hello:missing')).toBe('_\r\n');
  });

  it('HELLO 2 returns a flat 14-element array', async () => {
    const r = await t.raw();
    const hello = await r.send('HELLO', '2');
    expect.soft(hello.startsWith('*14\r\n$6\r\nserver\r\n$5\r\nredis\r\n')).toBe(true);
    expect.soft(hello).toContain('$5\r\nproto\r\n:2\r\n');
    expect.soft(await r.send('GET', 'hello:missing')).toBe('$-1\r\n');
  });

  it('HELLO with no args reports the current protocol without switching', async () => {
    const r = await t.raw();
    expect.soft(await r.send('HELLO')).toContain('$5\r\nproto\r\n:2\r\n');
    await r.send('HELLO', '3');
    const again = await r.send('HELLO');
    expect.soft(again.startsWith('%7\r\n')).toBe(true);
    expect.soft(again).toContain('$5\r\nproto\r\n:3\r\n');
  });

  it('HELLO id matches CLIENT ID', async () => {
    const res = pairs(await t.call('HELLO', '2'));
    expect.soft(res.id).toBe(await t.call('CLIENT', 'ID'));
    expect.soft(res.server).toBe('redis');
    expect.soft(res.mode).toBe('standalone');
    expect.soft(res.role).toBe('master');
    expect.soft(Array.isArray(res.modules)).toBe(true);
  });

  it('HELLO with unsupported versions is NOPROTO', async () => {
    const r = await t.raw();
    expect.soft(await r.send('HELLO', '4')).toBe('-NOPROTO unsupported protocol version\r\n');
    expect.soft(await r.send('HELLO', '1')).toBe('-NOPROTO unsupported protocol version\r\n');
    expect.soft(await r.send('HELLO', '0')).toBe('-NOPROTO unsupported protocol version\r\n');
    expect.soft(await r.send('HELLO', 'abc')).toBe('-ERR Protocol version is not an integer or out of range\r\n');
    // the protocol stays RESP2
    expect.soft(await r.send('GET', 'hello:missing')).toBe('$-1\r\n');
  });

  it('HELLO SETNAME sets the connection name', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3', 'SETNAME', 'hello-name');
    expect.soft(await r.send('CLIENT', 'GETNAME')).toBe('$10\r\nhello-name\r\n');
    expect.soft(await r.send('HELLO', '3', 'SETNAME', 'bad name')).toBe(
      '-ERR Client names cannot contain spaces, newlines or special characters.\r\n',
    );
  });

  it('HELLO AUTH on a server without password accepts default user', async () => {
    const r = await t.raw();
    const res = await r.send('HELLO', '3', 'AUTH', 'default', 'anything');
    expect.soft(res.startsWith('%7\r\n')).toBe(true);
    expect.soft(await r.send('HELLO', '3', 'AUTH', 'nouser', 'pw')).toBe(
      '-WRONGPASS invalid username-password pair or user is disabled.\r\n',
    );
  });

  it('HELLO option syntax errors', async () => {
    const r = await t.raw();
    expect.soft(await r.send('HELLO', '3', 'FOO')).toBe("-ERR Syntax error in HELLO option 'FOO'\r\n");
    expect.soft(await r.send('HELLO', '3', 'AUTH', 'default')).toBe("-ERR Syntax error in HELLO option 'AUTH'\r\n");
    expect.soft(await r.send('HELLO', '3', 'SETNAME')).toBe("-ERR Syntax error in HELLO option 'SETNAME'\r\n");
  });
});

describe('server with a password', () => {
  const ta = useServer({ password: 'secret' });

  it('commands require authentication', async () => {
    const r = await ta.raw();
    expect.soft(await r.send('GET', 'k')).toBe('-NOAUTH Authentication required.\r\n');
    expect.soft(await r.send('PING')).toBe('-NOAUTH Authentication required.\r\n');
  });

  it('AUTH with the wrong password is WRONGPASS', async () => {
    const r = await ta.raw();
    expect.soft(await r.send('AUTH', 'nope')).toBe('-WRONGPASS invalid username-password pair or user is disabled.\r\n');
    expect.soft(await r.send('AUTH', 'default', 'nope')).toBe('-WRONGPASS invalid username-password pair or user is disabled.\r\n');
    expect.soft(await r.send('AUTH', 'other', 'secret')).toBe('-WRONGPASS invalid username-password pair or user is disabled.\r\n');
    expect.soft(await r.send('GET', 'k')).toBe('-NOAUTH Authentication required.\r\n');
  });

  it('AUTH password and AUTH default password', async () => {
    const r1 = await ta.raw();
    expect.soft(await r1.send('AUTH', 'secret')).toBe('+OK\r\n');
    expect.soft(await r1.send('PING')).toBe('+PONG\r\n');
    expect.soft(await r1.send('ACL', 'WHOAMI')).toBe('$7\r\ndefault\r\n');
    const r2 = await ta.raw();
    expect.soft(await r2.send('AUTH', 'default', 'secret')).toBe('+OK\r\n');
    expect.soft(await r2.send('GET', 'auth:missing')).toBe('$-1\r\n');
  });

  it('HELLO without AUTH on an unauthenticated connection', async () => {
    const r = await ta.raw();
    expect.soft(await r.send('HELLO', '3')).toBe(
      '-NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time\r\n',
    );
  });

  it('HELLO AUTH authenticates and switches protocol', async () => {
    const r = await ta.raw();
    expect.soft(await r.send('HELLO', '3', 'AUTH', 'default', 'wrong')).toBe(
      '-WRONGPASS invalid username-password pair or user is disabled.\r\n',
    );
    expect.soft(await r.send('GET', 'k')).toBe('-NOAUTH Authentication required.\r\n');
    const hello = await r.send('HELLO', '3', 'AUTH', 'default', 'secret', 'SETNAME', 'authed');
    expect.soft(hello.startsWith('%7\r\n')).toBe(true);
    expect.soft(await r.send('GET', 'auth:missing')).toBe('_\r\n');
    expect.soft(await r.send('CLIENT', 'GETNAME')).toBe('$6\r\nauthed\r\n');
  });

  it('QUIT works without authentication', async () => {
    const s = await Sock.open(ta.server.port);
    expect.soft(await s.write(enc('QUIT'))).toBe('+OK\r\n');
  });

  it('ACL LIST shows the password hash', async () => {
    const list = (await ta.call('ACL', 'LIST')) as string[];
    expect.soft(list).toHaveLength(1);
    // sha256('secret')
    expect.soft(list[0]).toBe('user default on #2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b ~* &* +@all');
  });

  it('CONFIG GET requirepass', async () => {
    expect.soft(await ta.call('CONFIG', 'GET', 'requirepass')).toEqual(['requirepass', 'secret']);
  });

  it('the authenticated ioredis client works', async () => {
    expect.soft(await ta.call('PING')).toBe('PONG');
  });
});
