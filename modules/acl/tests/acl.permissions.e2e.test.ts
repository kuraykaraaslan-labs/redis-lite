import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { Conn, bulk, err, errOf, sha, useAclHelpers } from './acl.e2e.helpers';

/**
 * End-to-end ACL permissions over sockets: command / key / channel checks, MULTI / EXEC, scripts, ACL LOG, ACL DRYRUN, redis.acl_check_cmd.
 * Expected replies are Redis 8 (acl.c / server.c / multi.c / script.c) texts.
 */

const t = useServer();
const { raw, login, aclLog } = useAclHelpers(t);

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
