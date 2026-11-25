import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisLiteServer } from '@/modules/server/server.core';
import { sleep, useServer } from '@/tests/helpers';

/**
 * End-to-end ACL behaviour over sockets. Expected replies are Redis 8 (acl.c / server.c / multi.c / script.c) texts.
 */

const t = useServer();

/** Raw RESP connection that also notices when the server closes it. */
class Conn {
  private buffer = '';
  private waiters: Array<() => void> = [];
  closed = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('latin1');
    socket.on('data', (d: string) => {
      this.buffer += d;
      for (const w of this.waiters.splice(0)) w();
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static open(port: number): Promise<Conn> {
    return new Promise((resolve) => {
      const s = connect(port, '127.0.0.1', () => resolve(new Conn(s)));
    });
  }

  async send(...args: Array<string | number>): Promise<string> {
    this.buffer = '';
    const parts = args.map(String);
    const payload = `*${parts.length}\r\n${parts.map((a) => `$${Buffer.byteLength(a, 'latin1')}\r\n${a}\r\n`).join('')}`;
    if (!this.closed) this.socket.write(payload, 'latin1');
    if (!this.buffer && !this.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await sleep(15);
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  /** Resolves once the server has closed the connection (false after `ms`). */
  async waitClosed(ms = 1000): Promise<boolean> {
    const until = Date.now() + ms;
    while (!this.closed && Date.now() < until) await sleep(10);
    return this.closed;
  }

  close(): void {
    this.socket.destroy();
  }
}

const conns: Conn[] = [];
afterAll(() => {
  for (const c of conns) c.close();
});

async function raw(port?: number): Promise<Conn> {
  const c = await Conn.open(port ?? t.server.port);
  conns.push(c);
  return c;
}

const sha = (pw: string): string => createHash('sha256').update(pw).digest('hex');

async function errOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'NO ERROR';
}

/** A raw connection authenticated as `user` (password `pw`). */
async function login(user: string, pw: string): Promise<Conn> {
  const r = await raw();
  expect(await r.send('AUTH', user, pw)).toBe('+OK\r\n');
  return r;
}

const bulk = (s: string): string => `$${s.length}\r\n${s}\r\n`;
const err = (s: string): string => `-${s}\r\n`;

/** ACL LOG entries (RESP2) as objects. */
async function aclLog(count?: number): Promise<Array<Record<string, unknown>>> {
  const raw = (count === undefined ? await t.call('ACL', 'LOG') : await t.call('ACL', 'LOG', count)) as unknown[][];
  return raw.map((flat) => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < flat.length; i += 2) o[String(flat[i])] = flat[i + 1];
    return o;
  });
}

function closed(r: Conn): Promise<boolean> {
  return r.waitClosed();
}

describe('users and AUTH', () => {
  it('SETUSER creates a user that AUTH accepts', async () => {
    expect(await t.call('ACL', 'SETUSER', 'alice', 'on', '>p1', '~cached:*', '+get')).toBe('OK');
    expect(await t.call('ACL', 'GETUSER', 'alice')).toEqual([
      'flags', ['on', 'sanitize-payload'],
      'passwords', [sha('p1')],
      'commands', '-@all +get',
      'keys', '~cached:*',
      'channels', '',
      'selectors', [],
    ]);
    const list = (await t.call('ACL', 'LIST')) as string[];
    expect(list).toContain(`user alice on sanitize-payload #${sha('p1')} ~cached:* resetchannels -@all +get`);
    expect(await t.call('ACL', 'USERS')).toEqual(['alice', 'default']);

    const r = await raw();
    expect(await r.send('AUTH', 'alice', 'nope')).toBe(err('WRONGPASS invalid username-password pair or user is disabled.'));
    expect(await r.send('ACL', 'WHOAMI')).toBe(bulk('default'));
    expect(await r.send('AUTH', 'alice', 'p1')).toBe('+OK\r\n');
    // ACL WHOAMI needs +acl|whoami: alice may only run GET
    expect(await r.send('ACL', 'WHOAMI')).toBe(err("NOPERM User alice has no permissions to run the 'acl|whoami' command"));
    expect(await r.send('GET', 'cached:1')).toBe('$-1\r\n');
  });

  it('WHOAMI and CLIENT LIST / INFO show the authenticated user', async () => {
    await t.call('ACL', 'SETUSER', 'bob', 'on', '>bobpw', '+@connection', '+acl|whoami');
    const r = await login('bob', 'bobpw');
    expect(await r.send('ACL', 'WHOAMI')).toBe(bulk('bob'));
    expect(await r.send('CLIENT', 'INFO')).toMatch(/ user=bob /);
    const id = Number(/^:(\d+)/.exec(await r.send('CLIENT', 'ID'))?.[1]);
    const list = String(await t.call('CLIENT', 'LIST', 'ID', id));
    expect(list).toMatch(/ user=bob /);
    expect(String(await t.call('CLIENT', 'INFO'))).toMatch(/ user=default /);
  });

  it('disabled users, unknown users and nopass users', async () => {
    await t.call('ACL', 'SETUSER', 'offuser', 'off', '>pw', '+@all');
    await t.call('ACL', 'SETUSER', 'free', 'on', 'nopass', '+ping');
    const r = await raw();
    expect(await r.send('AUTH', 'offuser', 'pw')).toBe(err('WRONGPASS invalid username-password pair or user is disabled.'));
    expect(await r.send('AUTH', 'ghost', 'pw')).toBe(err('WRONGPASS invalid username-password pair or user is disabled.'));
    expect(await r.send('AUTH', 'free', 'anything at all')).toBe('+OK\r\n');
    expect(await r.send('PING')).toBe('+PONG\r\n');
  });

  it('HELLO AUTH logs in, and a failed HELLO AUTH applies nothing', async () => {
    await t.call('ACL', 'SETUSER', 'hello-user', 'on', '>hpw', '+@all', '~*');
    const r = await raw();
    await r.send('CLIENT', 'SETNAME', 'before');
    expect(await r.send('HELLO', '2', 'AUTH', 'hello-user', 'bad', 'SETNAME', 'after')).toBe(
      err('WRONGPASS invalid username-password pair or user is disabled.'),
    );
    expect(await r.send('CLIENT', 'GETNAME')).toBe(bulk('before'));
    const hello = await r.send('HELLO', '3', 'AUTH', 'hello-user', 'hpw');
    expect(hello.startsWith('%7\r\n')).toBe(true);
    expect(await r.send('ACL', 'WHOAMI')).toBe(bulk('hello-user'));
  });

  it('RESET returns the connection to the default user', async () => {
    await t.call('ACL', 'SETUSER', 'resetter', 'on', '>rpw', '+@all');
    const r = await login('resetter', 'rpw');
    expect(await r.send('ACL', 'WHOAMI')).toBe(bulk('resetter'));
    expect(await r.send('RESET')).toBe('+RESET\r\n');
    expect(await r.send('ACL', 'WHOAMI')).toBe(bulk('default'));
  });

  it('SETUSER errors use the Redis texts', async () => {
    expect(await errOf(t.call('ACL', 'SETUSER', 'e1', '+nosuchcommand'))).toBe(
      "ERR Error in ACL SETUSER modifier '+nosuchcommand': Unknown command or category name in ACL",
    );
    expect(await errOf(t.call('ACL', 'SETUSER', 'e1', 'bogus'))).toBe("ERR Error in ACL SETUSER modifier 'bogus': Syntax error");
    expect(await errOf(t.call('ACL', 'SETUSER', 'e 1', 'on'))).toBe("ERR Usernames can't contain spaces or null characters");
    expect(await t.call('ACL', 'GETUSER', 'e1')).toBeNull();
  });

  it('DELUSER of the default user is refused', async () => {
    expect(await errOf(t.call('ACL', 'DELUSER', 'default'))).toBe("ERR The 'default' user cannot be removed");
    expect(await t.call('ACL', 'DELUSER', 'nosuchuser')).toBe(0);
  });
});

describe('permissions', () => {
  it('commands, subcommands and categories', async () => {
    await t.call('ACL', 'SETUSER', 'cfg', 'on', '>pw', '+config|get', '+@string', '-set', '~*');
    const r = await login('cfg', 'pw');
    expect(await r.send('CONFIG', 'GET', 'maxmemory')).toBe('*2\r\n$9\r\nmaxmemory\r\n$1\r\n0\r\n');
    expect(await r.send('CONFIG', 'SET', 'maxmemory', '0')).toBe(err("NOPERM User cfg has no permissions to run the 'config|set' command"));
    expect(await r.send('INCR', 'cnt')).toBe(':1\r\n');
    expect(await r.send('SET', 'k', 'v')).toBe(err("NOPERM User cfg has no permissions to run the 'set' command"));
    expect(await r.send('LPUSH', 'l', 'a')).toBe(err("NOPERM User cfg has no permissions to run the 'lpush' command"));
  });

  it('key patterns, including %R~ and %W~', async () => {
    await t.call('ACL', 'SETUSER', 'keys', 'on', '>pw', '+@all', 'resetkeys', '~app:*', '%R~ro:*', '%W~wo:*');
    const r = await login('keys', 'pw');
    expect(await r.send('SET', 'app:1', 'v')).toBe('+OK\r\n');
    expect(await r.send('GET', 'other')).toBe(err('NOPERM No permissions to access a key'));
    expect(await r.send('GET', 'ro:1')).toBe('$-1\r\n');
    expect(await r.send('SET', 'ro:1', 'v')).toBe(err('NOPERM No permissions to access a key'));
    // SET without GET only writes its key; with GET it also reads it
    expect(await r.send('SET', 'wo:1', 'v')).toBe('+OK\r\n');
    expect(await r.send('SET', 'wo:1', 'v', 'GET')).toBe(err('NOPERM No permissions to access a key'));
    expect(await r.send('GET', 'wo:1')).toBe(err('NOPERM No permissions to access a key'));
    // EXISTS neither reads nor writes the value: any pattern grants it
    expect(await r.send('EXISTS', 'wo:1', 'ro:1')).toBe(':1\r\n');
    // COPY reads the source and writes the destination
    expect(await r.send('COPY', 'app:1', 'wo:2')).toBe(':1\r\n');
    expect(await r.send('COPY', 'wo:1', 'app:2')).toBe(err('NOPERM No permissions to access a key'));
  });

  it('channels: PUBLISH, SUBSCRIBE and literal PSUBSCRIBE patterns', async () => {
    await t.call('ACL', 'SETUSER', 'pub', 'on', '>pw', '+@all', 'resetchannels', '&news.*');
    const r = await login('pub', 'pw');
    expect(await r.send('PUBLISH', 'news.today', 'hi')).toBe(':0\r\n');
    expect(await r.send('PUBLISH', 'sport', 'hi')).toBe(err('NOPERM No permissions to access a channel'));
    expect(await r.send('PSUBSCRIBE', 'news.a*')).toBe(err('NOPERM No permissions to access a channel'));
    expect(await r.send('SUBSCRIBE', 'sport')).toBe(err('NOPERM No permissions to access a channel'));
    expect(await r.send('PSUBSCRIBE', 'news.*')).toBe('*3\r\n$10\r\npsubscribe\r\n$6\r\nnews.*\r\n:1\r\n');
  });

  it('selectors grant alternative permission sets', async () => {
    await t.call('ACL', 'SETUSER', 'sel', 'on', '>pw', '+get', '~a:*', '(+set ~b:*)');
    expect(await t.call('ACL', 'GETUSER', 'sel')).toEqual([
      'flags', ['on', 'sanitize-payload'],
      'passwords', [sha('pw')],
      'commands', '-@all +get',
      'keys', '~a:*',
      'channels', '',
      'selectors', [['commands', '-@all +set', 'keys', '~b:*', 'channels', '']],
    ]);
    const r = await login('sel', 'pw');
    expect(await r.send('GET', 'a:1')).toBe('$-1\r\n');
    expect(await r.send('SET', 'b:1', 'x')).toBe('+OK\r\n');
    expect(await r.send('SET', 'a:1', 'x')).toBe(err('NOPERM No permissions to access a key'));
    expect(await r.send('GET', 'b:1')).toBe(err('NOPERM No permissions to access a key'));
  });

  it('first-arg rules (+select|0)', async () => {
    await t.call('ACL', 'SETUSER', 'db0', 'on', '>pw', '+select|0', '+ping');
    const r = await login('db0', 'pw');
    expect(await r.send('SELECT', '0')).toBe('+OK\r\n');
    expect(await r.send('SELECT', '1')).toBe(err("NOPERM User db0 has no permissions to run the 'select' command"));
  });

  it('unknown commands and arity errors come before NOPERM', async () => {
    await t.call('ACL', 'SETUSER', 'nothing', 'on', '>pw');
    const r = await login('nothing', 'pw');
    expect(await r.send('NOSUCHCMD')).toBe(err("ERR unknown command 'NOSUCHCMD', with args beginning with: "));
    expect(await r.send('GET')).toBe(err("ERR wrong number of arguments for 'get' command"));
    expect(await r.send('GET', 'k')).toBe(err("NOPERM User nothing has no permissions to run the 'get' command"));
    // AUTH has the no_auth flag: the command bit is not checked
    expect(await r.send('AUTH', 'nothing', 'pw')).toBe('+OK\r\n');
  });
});

describe('MULTI / EXEC', () => {
  it('a denied command is rejected at queue time and aborts the transaction', async () => {
    await t.call('ACL', 'SETUSER', 'tx', 'on', '>pw', '+multi', '+exec', '+set', '~*');
    await t.call('ACL', 'LOG', 'RESET');
    const r = await login('tx', 'pw');
    expect(await r.send('MULTI')).toBe('+OK\r\n');
    expect(await r.send('SET', 'k', 'v')).toBe('+QUEUED\r\n');
    expect(await r.send('INCR', 'k')).toBe(err("NOPERM User tx has no permissions to run the 'incr' command"));
    expect(await r.send('EXEC')).toBe(err('EXECABORT Transaction discarded because of previous errors.'));
    const [entry] = await aclLog();
    expect(entry).toMatchObject({ count: 1, reason: 'command', context: 'multi', object: 'incr', username: 'tx' });
    expect(String(entry['client-info'])).toMatch(/ cmd=incr /);
  });

  it('permissions are checked again at EXEC time', async () => {
    await t.call('ACL', 'SETUSER', 'tx2', 'on', '>pw', '+multi', '+exec', '+incr', '+get', '~*');
    await t.call('ACL', 'LOG', 'RESET');
    const r = await login('tx2', 'pw');
    expect(await r.send('MULTI')).toBe('+OK\r\n');
    expect(await r.send('INCR', 'tx2:n')).toBe('+QUEUED\r\n');
    expect(await r.send('GET', 'tx2:n')).toBe('+QUEUED\r\n');
    await t.call('ACL', 'SETUSER', 'tx2', '-incr');
    expect(await r.send('EXEC')).toBe(
      '*2\r\n' +
        err(
          'NOPERM ACLs rules changed between the moment the transaction was accumulated and the EXEC call. ' +
            'This command is no longer allowed for the following reason: no permission to execute the command or subcommand',
        ) +
        '$-1\r\n',
    );
    const [entry] = await aclLog();
    expect(entry).toMatchObject({ reason: 'command', context: 'multi', object: 'incr', username: 'tx2' });
    expect(String(entry['client-info'])).toMatch(/ cmd=exec /);
  });

  it('a denied EXEC discards the transaction with EXECABORT', async () => {
    await t.call('ACL', 'SETUSER', 'tx3', 'on', '>pw', '+multi', '+ping');
    const r = await login('tx3', 'pw');
    expect(await r.send('MULTI')).toBe('+OK\r\n');
    expect(await r.send('PING')).toBe('+QUEUED\r\n');
    expect(await r.send('EXEC')).toBe(
      err("EXECABORT Transaction discarded because of: NOPERM User tx3 has no permissions to run the 'exec' command"),
    );
    // the transaction is gone
    expect(await r.send('PING')).toBe('+PONG\r\n');
  });
});

describe('scripts', () => {
  it('redis.call is checked with the script caller permissions (context lua)', async () => {
    await t.call('ACL', 'SETUSER', 'lua', 'on', '>pw', '+eval', '+get', '~*');
    await t.call('ACL', 'LOG', 'RESET');
    const r = await login('lua', 'pw');
    expect(await r.send('EVAL', "return redis.call('get', KEYS[1])", '1', 'lua:k')).toBe('$-1\r\n');
    const reply = await r.send('EVAL', "return redis.call('set', KEYS[1], 'x')", '1', 'lua:k');
    expect(reply).toMatch(
      /^-ERR ACL failure in script: User lua has no permissions to run the 'set' command script: [0-9a-f]{40}, on @user_script:1\.\r\n$/,
    );
    const pcall = await r.send('EVAL', "local e = redis.pcall('set', KEYS[1], 'x'); return e['err']", '1', 'lua:k');
    expect(pcall).toBe(bulk("ERR ACL failure in script: User lua has no permissions to run the 'set' command"));
    const [entry] = await aclLog();
    expect(entry).toMatchObject({ count: 2, reason: 'command', context: 'lua', object: 'set', username: 'lua' });
    expect(String(entry['client-info'])).toMatch(/ cmd=eval /);
  });

  it('key permissions apply inside scripts', async () => {
    await t.call('ACL', 'SETUSER', 'lua2', 'on', '>pw', '+eval', '+get', '~mine:*');
    const r = await login('lua2', 'pw');
    expect(await r.send('EVAL', "return redis.call('get', 'theirs')", '0')).toMatch(
      /^-ERR ACL failure in script: No permissions to access a key script: /,
    );
    expect(await r.send('EVAL', "return redis.call('get', 'x')", '1', 'theirs')).toBe(err('NOPERM No permissions to access a key'));
  });
});

describe('ACL LOG', () => {
  it('records denials with Redis fields, grouping repeated events', async () => {
    await t.call('ACL', 'SETUSER', 'logger', 'on', '>pw', '+get', '~obj:*', 'resetchannels', '+publish');
    await t.call('ACL', 'LOG', 'RESET');
    const r = await login('logger', 'pw');
    await r.send('SET', 'k', 'v');
    await r.send('SET', 'k', 'v');
    await r.send('SET', 'k', 'v');
    await r.send('GET', 'notallowed');
    await r.send('PUBLISH', 'chan', 'msg');
    const log = await aclLog();
    expect(log).toHaveLength(3);
    expect(Object.keys(log[0])).toEqual([
      'count', 'reason', 'context', 'object', 'username', 'age-seconds', 'client-info', 'entry-id', 'timestamp-created',
      'timestamp-last-updated',
    ]);
    expect(log[0]).toMatchObject({ count: 1, reason: 'channel', context: 'toplevel', object: 'chan', username: 'logger' });
    expect(log[1]).toMatchObject({ count: 1, reason: 'key', object: 'notallowed' });
    expect(log[2]).toMatchObject({ count: 3, reason: 'command', object: 'set' });
    expect(log[0]['entry-id']).toBe(Number(log[2]['entry-id']) + 2);
    expect(String(log[2]['client-info'])).toMatch(/ cmd=set user=logger /);
    expect(Number(log[0]['age-seconds'])).toBeGreaterThanOrEqual(0);
    expect(await aclLog(1)).toHaveLength(1);
    expect(await aclLog(-5)).toHaveLength(0);
    expect(await errOf(t.call('ACL', 'LOG', 'abc'))).toBe('ERR value is not an integer or out of range');
    expect(await errOf(t.call('ACL', 'LOG', '1', '2'))).toBe(
      "ERR unknown subcommand or wrong number of arguments for 'LOG'. Try ACL HELP.",
    );
  });

  it('records failed AUTH with the command name as object', async () => {
    await t.call('ACL', 'LOG', 'RESET');
    const r = await raw();
    await r.send('AUTH', 'antirez', 'wrong');
    await r.send('hello', '3', 'AUTH', 'antirez', 'wrong');
    const log = await aclLog();
    expect(log[0]).toMatchObject({ reason: 'auth', context: 'toplevel', object: 'hello', username: 'antirez' });
    expect(log[1]).toMatchObject({ reason: 'auth', context: 'toplevel', object: 'AUTH', username: 'antirez' });
  });

  it('acllog-max-len bounds the log', async () => {
    await t.call('ACL', 'LOG', 'RESET');
    await t.call('CONFIG', 'SET', 'acllog-max-len', '3');
    await t.call('ACL', 'SETUSER', 'bounded', 'on', '>pw', '+set');
    const r = await login('bounded', 'pw');
    for (let i = 0; i < 6; i++) await r.send('SET', `obj:${i}`, '1');
    expect(await aclLog()).toHaveLength(3);
    await t.call('CONFIG', 'SET', 'acllog-max-len', '128');
  });

  it('INFO stats counts denials', async () => {
    const info = String(await t.call('INFO', 'stats'));
    for (const f of ['auth', 'cmd', 'key', 'channel']) {
      expect(Number(new RegExp(`acl_access_denied_${f}:(\\d+)`).exec(info)?.[1])).toBeGreaterThan(0);
    }
  });
});

describe('ACL DRYRUN', () => {
  it('reports what would be denied without running anything', async () => {
    await t.call('ACL', 'SETUSER', 'dry', 'on', 'nopass', '+get', '+publish', '~k:*', 'resetchannels', '&c');
    expect(await t.call('ACL', 'DRYRUN', 'dry', 'GET', 'k:1')).toBe('OK');
    expect(await t.call('ACL', 'DRYRUN', 'dry', 'SET', 'k:1', 'v')).toBe("User dry has no permissions to run the 'set' command");
    expect(await t.call('ACL', 'DRYRUN', 'dry', 'GET', 'other')).toBe("No permissions to access the 'other' key");
    expect(await t.call('ACL', 'DRYRUN', 'dry', 'PUBLISH', 'x', 'm')).toBe("No permissions to access the 'x' channel");
    expect(await errOf(t.call('ACL', 'DRYRUN', 'dry', 'GET'))).toBe("ERR wrong number of arguments for 'get' command");
    expect(await errOf(t.call('ACL', 'DRYRUN', 'ghost', 'GET', 'k'))).toBe("ERR User 'ghost' not found");
    expect(await errOf(t.call('ACL', 'DRYRUN', 'dry', 'NOPE'))).toBe("ERR Command 'NOPE' not found");
    expect(await t.call('ACL', 'DRYRUN', 'dry', 'CONFIG', 'GET', 'x')).toBe("User dry has no permissions to run the 'config|get' command");
  });
});

describe('effects of user changes on connections', () => {
  it('DELUSER closes the connections of the user (the caller after its reply)', async () => {
    await t.call('ACL', 'SETUSER', 'gone', 'on', '>pw', '+@all', '~*');
    const other = await login('gone', 'pw');
    const self = await login('gone', 'pw');
    const bystander = await raw();
    expect(await self.send('ACL', 'DELUSER', 'gone', 'gone')).toBe(':1\r\n');
    await sleep(20);
    expect(await closed(self)).toBe(true);
    expect(await closed(other)).toBe(true);
    expect(await bystander.send('PING')).toBe('+PONG\r\n');
    expect(await t.call('ACL', 'GETUSER', 'gone')).toBeNull();
  });

  it('CLIENT KILL USER', async () => {
    await t.call('ACL', 'SETUSER', 'victim', 'on', '>pw', '+@all');
    const a = await login('victim', 'pw');
    const b = await login('victim', 'pw');
    expect(await t.call('CLIENT', 'KILL', 'USER', 'victim')).toBe(2);
    expect(await closed(a)).toBe(true);
    expect(await closed(b)).toBe(true);
    expect(await errOf(t.call('CLIENT', 'KILL', 'USER', 'ghost'))).toBe("ERR No such user 'ghost'");
  });

  it('SETUSER that revokes a channel closes the affected subscribers only', async () => {
    await t.call('ACL', 'SETUSER', 'ps', 'on', '>pw', '+@all', 'resetchannels', '&foo:1', '&bar:*', '&orders');
    const doomed = await login('ps', 'pw');
    expect(await doomed.send('SUBSCRIBE', 'orders')).toBe('*3\r\n$9\r\nsubscribe\r\n$6\r\norders\r\n:1\r\n');
    const pardoned = await login('ps', 'pw');
    expect(await pardoned.send('PSUBSCRIBE', 'bar:*')).toBe('*3\r\n$10\r\npsubscribe\r\n$5\r\nbar:*\r\n:1\r\n');
    await t.call('ACL', 'SETUSER', 'ps', 'resetchannels', '&foo:1', '&bar:*');
    await sleep(20);
    expect(await closed(doomed)).toBe(true);
    expect(await pardoned.send('PING')).toBe('*2\r\n$4\r\npong\r\n$0\r\n\r\n');
  });

  it('a blocked command is rejected when its keys were revoked meanwhile', async () => {
    await t.call('ACL', 'SETUSER', 'blk', 'on', '>pw', '+@all', '~*');
    const r = await login('blk', 'pw');
    const pending = r.send('BLPOP', 'blk:list', '0');
    await sleep(30);
    await t.call('ACL', 'SETUSER', 'blk', 'resetkeys');
    await t.call('LPUSH', 'blk:list', 'x');
    expect(await pending).toBe(err('NOPERM No permissions to access a key'));
    expect(await t.call('LLEN', 'blk:list')).toBe(1);
  });
});

describe('the default user', () => {
  it('requirepass set at runtime: new connections need AUTH, existing ones stay logged in', async () => {
    const before = await raw();
    expect(await t.call('CONFIG', 'SET', 'requirepass', 'sekret')).toBe('OK');
    const list = (await t.call('ACL', 'LIST')) as string[];
    expect(list).toContain(`user default on sanitize-payload #${sha('sekret')} ~* &* +@all`);
    const after = await raw();
    expect(await after.send('GET', 'k')).toBe(err('NOAUTH Authentication required.'));
    // unknown commands are reported before authentication is required
    expect(await after.send('NOSUCH')).toBe(err("ERR unknown command 'NOSUCH', with args beginning with: "));
    expect(await after.send('AUTH', 'sekret')).toBe('+OK\r\n');
    expect(await before.send('PING')).toBe('+PONG\r\n');
    expect(await t.call('CONFIG', 'SET', 'requirepass', '')).toBe('OK');
    const again = await raw();
    expect(await again.send('PING')).toBe('+PONG\r\n');
  });

  it('when default is off, new connections are not authenticated', async () => {
    await t.call('ACL', 'SETUSER', 'default', 'off');
    const r = await raw();
    expect(await r.send('PING')).toBe(err('NOAUTH Authentication required.'));
    await t.call('ACL', 'SETUSER', 'default', 'on');
    expect(await r.send('PING')).toBe('+PONG\r\n');
  });
});

describe('ACL replies', () => {
  it('GETUSER in RESP3', async () => {
    await t.call('ACL', 'SETUSER', 'r3', 'on', 'nopass', '~k:*', '&ch', '+get', '(+set ~w:*)');
    const r = await raw();
    await r.send('HELLO', '3');
    expect(await r.send('ACL', 'GETUSER', 'r3')).toBe(
      '%6\r\n' +
        '$5\r\nflags\r\n~3\r\n$2\r\non\r\n$6\r\nnopass\r\n$16\r\nsanitize-payload\r\n' +
        '$9\r\npasswords\r\n*0\r\n' +
        '$8\r\ncommands\r\n$10\r\n-@all +get\r\n' +
        '$4\r\nkeys\r\n$4\r\n~k:*\r\n' +
        '$8\r\nchannels\r\n$3\r\n&ch\r\n' +
        '$9\r\nselectors\r\n*1\r\n%3\r\n$8\r\ncommands\r\n$10\r\n-@all +set\r\n$4\r\nkeys\r\n$4\r\n~w:*\r\n$8\r\nchannels\r\n$0\r\n\r\n',
    );
    expect(await r.send('ACL', 'GETUSER', 'nosuch')).toBe('_\r\n');
  });

  it('LOG in RESP3 is an array of maps with a double age', async () => {
    await t.call('ACL', 'LOG', 'RESET');
    const r = await raw();
    await r.send('AUTH', 'x', 'y');
    await r.send('HELLO', '3');
    const reply = await r.send('ACL', 'LOG');
    expect(reply).toMatch(/^\*1\r\n%10\r\n\$5\r\ncount\r\n:1\r\n\$6\r\nreason\r\n\$4\r\nauth\r\n/);
    expect(reply).toMatch(/\$11\r\nage-seconds\r\n,[\d.e-]+\r\n/);
  });

  it('CAT, GENPASS, HELP and syntax errors', async () => {
    const cats = (await t.call('ACL', 'CAT')) as string[];
    expect(cats[0]).toBe('keyspace');
    expect(cats).toHaveLength(21);
    expect(await t.call('ACL', 'CAT', 'hyperloglog')).toEqual(expect.arrayContaining(['pfadd', 'pfcount', 'pfmerge']));
    expect(await errOf(t.call('ACL', 'CAT', 'nope'))).toBe("ERR Unknown category 'nope'");
    expect(await t.call('ACL', 'GENPASS', '128')).toMatch(/^[0-9a-f]{32}$/);
    expect(await errOf(t.call('ACL', 'GENPASS', '-236'))).toBe(
      'ERR ACL GENPASS argument must be the number of bits for the output password, a positive number up to 4096',
    );
    expect(await errOf(t.call('ACL', 'HELP', 'xxx'))).toBe("ERR wrong number of arguments for 'acl|help' command");
    expect(await errOf(t.call('ACL', 'CAT', 'a', 'b'))).toBe("ERR unknown subcommand or wrong number of arguments for 'CAT'. Try ACL HELP.");
    expect(await errOf(t.call('ACL', 'LOAD'))).toBe(
      'ERR This Redis instance is not configured to use an ACL file. You may want to specify users via the ACL SETUSER command and then issue a CONFIG REWRITE (assuming you have a Redis configuration file set) in order to store users in the Redis configuration.',
    );
    expect(await errOf(t.call('ACL', 'SAVE'))).toMatch(/^ERR This Redis instance is not configured to use an ACL file/);
  });

  it('SETUSER arguments are redacted in SLOWLOG', async () => {
    await t.call('CONFIG', 'SET', 'slowlog-log-slower-than', '0');
    await t.call('SLOWLOG', 'RESET');
    await t.call('ACL', 'SETUSER', 'redacted', 'on', '>secret');
    await t.call('CONFIG', 'SET', 'slowlog-log-slower-than', '10000');
    const entries = (await t.call('SLOWLOG', 'GET')) as unknown[][];
    const setuser = entries.find((e) => (e[3] as string[])[1] === 'SETUSER');
    expect(setuser?.[3]).toEqual(['ACL', 'SETUSER', '(redacted)', '(redacted)', '(redacted)']);
  });
});

describe('ACL SAVE / LOAD with an aclfile', () => {
  let dir = '';
  let server: RedisLiteServer;
  let port = 0;
  const open = async (): Promise<Conn> => raw(port);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'redis-lite-acl-'));
    writeFileSync(join(dir, 'users.acl'), 'user loaded on >lpw ~* +@all\n');
    server = new RedisLiteServer({ port: 0, host: '127.0.0.1', databases: 16, logLevel: 'silent', aclfile: join(dir, 'users.acl') });
    port = (await server.listen()).port;
  });
  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads users at startup and saves them in users.acl format', async () => {
    const r = await open();
    expect(await r.send('AUTH', 'loaded', 'lpw')).toBe('+OK\r\n');
    expect(await r.send('ACL', 'SETUSER', 'extra', 'on', 'nopass', '+ping')).toBe('+OK\r\n');
    expect(await r.send('ACL', 'SAVE')).toBe('+OK\r\n');
    expect(readFileSync(join(dir, 'users.acl'), 'latin1')).toBe(
      'user default on nopass sanitize-payload ~* &* +@all\n' +
        'user extra on nopass sanitize-payload resetchannels -@all +ping\n' +
        `user loaded on sanitize-payload #${sha('lpw')} ~* resetchannels +@all\n`,
    );
    r.close();
  });

  it('LOAD replaces the users and disconnects clients of changed or removed users only', async () => {
    const changed = await open();
    expect(await changed.send('AUTH', 'loaded', 'lpw')).toBe('+OK\r\n');
    const kept = await open();
    expect(await kept.send('AUTH', 'extra', 'x')).toBe('+OK\r\n');
    writeFileSync(
      join(dir, 'users.acl'),
      'user default on nopass sanitize-payload ~* &* +@all\nuser extra on nopass sanitize-payload resetchannels -@all +ping\n',
    );
    const admin = await open();
    expect(await admin.send('ACL', 'LOAD')).toBe('+OK\r\n');
    expect(await admin.send('ACL', 'USERS')).toBe('*2\r\n$7\r\ndefault\r\n$5\r\nextra\r\n');
    await sleep(20);
    expect(await closed(changed)).toBe(true);
    expect(await kept.send('PING')).toBe('+PONG\r\n');
    expect(await admin.send('PING')).toBe('+PONG\r\n');
  });

  it('LOAD errors leave the users untouched', async () => {
    writeFileSync(join(dir, 'users.acl'), 'user ok on nopass +@all\nuser bad on +nosuchcmd\nfoo bar\n');
    const r = await open();
    const file = join(dir, 'users.acl');
    expect(await r.send('ACL', 'LOAD')).toBe(
      err(
        `ERR ${file}:2: Error in applying operation '+nosuchcmd': Unknown command or category name in ACL. ` +
          `${file}:3 should start with user keyword. `,
      ),
    );
    expect(await r.send('ACL', 'USERS')).toBe('*2\r\n$7\r\ndefault\r\n$5\r\nextra\r\n');
    rmSync(file);
    expect(await r.send('ACL', 'LOAD')).toBe(err(`ERR Error loading ACLs, opening file '${file}': No such file or directory`));
  });
});

describe('redis.acl_check_cmd', () => {
  it('answers for the user running the script, per the Lua API docs', async () => {
    await t.call('ACL', 'SETUSER', 'luacheck', 'on', '>pw', '~cache:*', '+eval', '+get', '+set', '-del');
    const c = await Conn.open(t.server.port);
    await c.send('AUTH', 'luacheck', 'pw');
    const check = (...argv: string[]) =>
      c.send('EVAL', `return redis.acl_check_cmd(${argv.map((a) => `'${a}'`).join(', ')}) and 'yes' or 'no'`, '0');
    expect(await check('GET', 'cache:1')).toBe('$3\r\nyes\r\n');
    expect(await check('GET', 'other')).toBe('$2\r\nno\r\n');
    expect(await check('SET', 'cache:1', 'v')).toBe('$3\r\nyes\r\n');
    expect(await check('DEL', 'cache:1')).toBe('$2\r\nno\r\n');
    expect(await check('HSET', 'cache:1', 'f', 'v')).toBe('$2\r\nno\r\n');
    expect(await c.send('EVAL', "return redis.acl_check_cmd('NOSUCHCMD')", '0')).toMatch(/^-ERR Invalid command passed to redis\.acl_check_cmd\(\)/);
    expect(await c.send('EVAL', 'return redis.acl_check_cmd()', '0')).toMatch(/^-ERR Please specify at least one argument for this redis lib call/);
    // the default user has every permission
    expect(await t.call('EVAL', "return redis.acl_check_cmd('FLUSHALL') and 1 or 0", '0')).toBe(1);
    c.close();
    await t.call('ACL', 'DELUSER', 'luacheck');
  });
});
