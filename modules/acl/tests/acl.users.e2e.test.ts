import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisLiteServer } from '@/modules/server/server.core';
import { useServer, waitForBlocked } from '@/tests/helpers';

import { bulk, err, errOf, sha, useAclHelpers } from './acl.e2e.helpers';
import type { Conn } from './acl.e2e.helpers';

/**
 * End-to-end ACL users over sockets: AUTH, the default user, effects of user changes on connections, ACL replies, ACL SAVE / LOAD.
 * Expected replies are Redis 8 (acl.c / server.c / multi.c / script.c) texts.
 */

const t = useServer();
const { raw, login, closed } = useAclHelpers(t);

describe('users and AUTH', () => {
  it('SETUSER creates a user that AUTH accepts', async () => {
    expect(await t.call('ACL', 'SETUSER', 'alice', 'on', '>p1', '~cached:*', '+get')).toBe('OK');
    expect(await t.call('ACL', 'GETUSER', 'alice')).toEqual([
      'flags', ['on'],
      'passwords', [sha('p1')],
      'commands', '-@all +get',
      'keys', '~cached:*',
      'channels', '',
      'selectors', [],
    ]);
    const list = (await t.call('ACL', 'LIST')) as string[];
    expect(list).toContain(`user alice on #${sha('p1')} ~cached:* resetchannels -@all +get`);
    expect(await t.call('ACL', 'USERS')).toEqual(['alice', 'default']);

    const r = await raw();
    expect(await r.send('AUTH', 'alice', 'nope')).toBe(err('WRONGPASS invalid username-password pair or user is disabled.'));
    expect(await r.send('ACL', 'WHOAMI')).toBe(bulk('default'));
    expect(await r.send('AUTH', 'alice', 'p1')).toBe('+OK\r\n');
    // ACL WHOAMI needs +acl|whoami: alice may only run GET
    expect(await r.send('ACL', 'WHOAMI')).toBe(err("NOPERM this user has no permissions to run the 'acl|whoami' command"));
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

describe('effects of user changes on connections', () => {
  it('DELUSER closes the connections of the user (the caller after its reply)', async () => {
    await t.call('ACL', 'SETUSER', 'gone', 'on', '>pw', '+@all', '~*');
    const other = await login('gone', 'pw');
    const self = await login('gone', 'pw');
    const bystander = await raw();
    expect(await self.send('ACL', 'DELUSER', 'gone', 'gone')).toBe(':1\r\n');
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
    expect(await closed(doomed)).toBe(true);
    expect(await pardoned.send('PING')).toBe('*2\r\n$4\r\npong\r\n$0\r\n\r\n');
  });

  it('a blocked command is rejected when its keys were revoked meanwhile', async () => {
    await t.call('ACL', 'SETUSER', 'blk', 'on', '>pw', '+@all', '~*');
    const r = await login('blk', 'pw');
    const pending = r.send('BLPOP', 'blk:list', '0');
    await waitForBlocked(t);
    await t.call('ACL', 'SETUSER', 'blk', 'resetkeys');
    await t.call('LPUSH', 'blk:list', 'x');
    expect(await pending).toBe(err('NOPERM this user has no permissions to access one of the keys used as arguments'));
    expect(await t.call('LLEN', 'blk:list')).toBe(1);
  });
});

describe('the default user', () => {
  it('requirepass set at runtime: new connections need AUTH, existing ones stay logged in', async () => {
    const before = await raw();
    expect(await t.call('CONFIG', 'SET', 'requirepass', 'sekret')).toBe('OK');
    const list = (await t.call('ACL', 'LIST')) as string[];
    expect(list).toContain(`user default on #${sha('sekret')} ~* &* +@all`);
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
        '$5\r\nflags\r\n~2\r\n$2\r\non\r\n$6\r\nnopass\r\n' +
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
    expect(reply).toMatch(/^\*1\r\n%7\r\n\$5\r\ncount\r\n:1\r\n\$6\r\nreason\r\n\$4\r\nauth\r\n/);
    expect(reply).toMatch(/\$11\r\nage-seconds\r\n,[\d.e-]+\r\n/);
  });

  it('CAT, GENPASS, HELP and syntax errors', async () => {
    const cats = (await t.call('ACL', 'CAT')) as string[];
    expect(cats[0]).toBe('keyspace');
    expect(cats).toHaveLength(21);
    expect(cats[20]).toBe('scripting');
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
      'user default on nopass ~* &* +@all\n' +
        'user extra on nopass resetchannels -@all +ping\n' +
        `user loaded on #${sha('lpw')} ~* resetchannels +@all\n`,
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
      'user default on nopass ~* &* +@all\nuser extra on nopass resetchannels -@all +ping\n',
    );
    const admin = await open();
    expect(await admin.send('ACL', 'LOAD')).toBe('+OK\r\n');
    expect(await admin.send('ACL', 'USERS')).toBe('*2\r\n$7\r\ndefault\r\n$5\r\nextra\r\n');
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
