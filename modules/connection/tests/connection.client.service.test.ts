import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';

import { Sock, enc, errOf } from './connection.test_helpers';

/**
 * CLIENT: the caller's own settings and the admin subcommands (INFO, LIST, KILL, UNBLOCK).
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

describe('CLIENT', () => {
  it('SETNAME / GETNAME', async () => {
    const r = await t.raw();
    expect.soft(await r.send('CLIENT', 'GETNAME')).toBe('$-1\r\n');
    expect.soft(await r.send('CLIENT', 'SETNAME', 'conn-1')).toBe('+OK\r\n');
    expect.soft(await r.send('CLIENT', 'GETNAME')).toBe('$6\r\nconn-1\r\n');
    expect.soft(await r.send('CLIENT', 'SETNAME', '')).toBe('+OK\r\n');
    expect.soft(await r.send('CLIENT', 'GETNAME')).toBe('$-1\r\n');
    expect.soft(await r.send('CLIENT', 'SETNAME', 'with space')).toBe(
      '-ERR Client names cannot contain spaces, newlines or special characters.\r\n',
    );
    expect.soft(await r.send('CLIENT', 'SETNAME', 'nl\nx')).toBe(
      '-ERR Client names cannot contain spaces, newlines or special characters.\r\n',
    );
    expect.soft(await r.send('CLIENT', 'SETNAME')).toBe("-ERR wrong number of arguments for 'client|setname' command\r\n");
    expect.soft(await r.send('CLIENT', 'GETNAME', 'x')).toBe("-ERR wrong number of arguments for 'client|getname' command\r\n");
  });

  it('GETNAME in RESP3 is null', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('CLIENT', 'GETNAME')).toBe('_\r\n');
  });

  it('ID is a positive integer, unique per connection', async () => {
    const r1 = await t.raw();
    const r2 = await t.raw();
    const id1 = await r1.send('CLIENT', 'ID');
    const id2 = await r2.send('CLIENT', 'ID');
    expect.soft(id1).toMatch(/^:\d+\r\n$/);
    expect.soft(id1).not.toBe(id2);
    expect.soft(await r1.send('CLIENT', 'ID', 'x')).toBe("-ERR wrong number of arguments for 'client|id' command\r\n");
  });

  it('INFO describes the current connection', async () => {
    const r = await t.raw();
    const id = (await r.send('CLIENT', 'ID')).slice(1, -2);
    await r.send('CLIENT', 'SETNAME', 'info-conn');
    const reply = await r.send('CLIENT', 'INFO');
    expect.soft(reply.startsWith('$')).toBe(true);
    const body = reply.split('\r\n')[1];
    expect.soft(body).toMatch(new RegExp(`^id=${id} addr=127\\.0\\.0\\.1:\\d+ laddr=127\\.0\\.0\\.1:${t.server.port} fd=\\d+ name=info-conn `));
    expect.soft(body).toMatch(/ db=0 /);
    expect.soft(body).toMatch(/ flags=N /);
    expect.soft(body).toMatch(/ cmd=client\|info /);
    expect.soft(body).toMatch(/ user=default /);
    expect.soft(body).toMatch(/ resp=2 /);
    expect.soft(body).toMatch(/ multi=-1 /);
    expect.soft(reply.endsWith('\n\r\n')).toBe(true);
  });

  it('INFO is a verbatim string in RESP3', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    const reply = await r.send('CLIENT', 'INFO');
    expect.soft(reply).toMatch(/^=\d+\r\ntxt:id=\d+ /);
    expect.soft(reply).toMatch(/ resp=3 /);
  });

  it('LIST lists every connection, with TYPE and ID filters', async () => {
    const r1 = await t.raw();
    const r2 = await t.raw();
    const id1 = Number((await r1.send('CLIENT', 'ID')).slice(1, -2));
    const id2 = Number((await r2.send('CLIENT', 'ID')).slice(1, -2));
    await r2.send('CLIENT', 'SETNAME', 'list-two');
    const all = String(await t.call('CLIENT', 'LIST'));
    expect.soft(all).toMatch(new RegExp(`(^|\\n)id=${id1} `));
    expect.soft(all).toMatch(new RegExp(`(^|\\n)id=${id2} .* name=list-two `));
    expect.soft(all.endsWith('\n')).toBe(true);
    const only = String(await t.call('CLIENT', 'LIST', 'ID', id2));
    expect.soft(only.trim().split('\n')).toHaveLength(1);
    expect.soft(only).toMatch(new RegExp(`^id=${id2} `));
    const two = String(await t.call('CLIENT', 'LIST', 'ID', id1, id2));
    expect.soft(two.trim().split('\n')).toHaveLength(2);
    expect.soft(String(await t.call('CLIENT', 'LIST', 'TYPE', 'normal'))).toContain(`id=${id1} `);
    expect.soft(await t.call('CLIENT', 'LIST', 'TYPE', 'pubsub')).toBe('');
    expect.soft(await errOf(t.call('CLIENT', 'LIST', 'TYPE', 'foo'))).toBe("ERR Unknown client type 'foo'");
    expect.soft(await errOf(t.call('CLIENT', 'LIST', 'ID', 'abc'))).toBe('ERR Invalid client ID');
    expect.soft(await errOf(t.call('CLIENT', 'LIST', 'FOO'))).toBe('ERR syntax error');
  });

  it('LIST is a verbatim string in RESP3', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('CLIENT', 'LIST')).toMatch(/^=\d+\r\ntxt:id=\d+ /);
  });

  it('SETINFO lib-name / lib-ver show up in CLIENT INFO', async () => {
    const r = await t.raw();
    expect.soft(await r.send('CLIENT', 'SETINFO', 'LIB-NAME', 'mylib')).toBe('+OK\r\n');
    expect.soft(await r.send('CLIENT', 'SETINFO', 'lib-ver', '1.2.3')).toBe('+OK\r\n');
    const info = await r.send('CLIENT', 'INFO');
    expect.soft(info).toMatch(/ lib-name=mylib /);
    expect.soft(info).toMatch(/ lib-ver=1\.2\.3/);
    expect.soft(await r.send('CLIENT', 'SETINFO', 'foo', 'x')).toBe("-ERR Unrecognized option 'foo'\r\n");
    // unverified: Redis echoes the attribute as typed in this message
    expect.soft(await r.send('CLIENT', 'SETINFO', 'lib-name', 'a b')).toBe(
      '-ERR lib-name cannot contain spaces, newlines or special characters.\r\n',
    );
    expect.soft(await r.send('CLIENT', 'SETINFO', 'lib-name')).toBe("-ERR wrong number of arguments for 'client|setinfo' command\r\n");
  });

  it('KILL ID kills another client and returns the count', async () => {
    const victim = await Sock.open(t.server.port);
    const idReply = await victim.write(enc('CLIENT', 'ID'));
    const id = idReply.slice(1, -2);
    expect.soft(await t.call('CLIENT', 'KILL', 'ID', id)).toBe(1);
    await sleep(50);
    expect.soft(victim.closed).toBe(true);
    expect.soft(await t.call('CLIENT', 'KILL', 'ID', '999999')).toBe(0);
  });

  it('KILL skips the caller by default (SKIPME yes)', async () => {
    const r = await t.raw();
    const id = (await r.send('CLIENT', 'ID')).slice(1, -2);
    expect.soft(await r.send('CLIENT', 'KILL', 'ID', id)).toBe(':0\r\n');
    expect.soft(await r.send('PING')).toBe('+PONG\r\n');
  });

  it('KILL with old-style address and errors', async () => {
    expect.soft(await errOf(t.call('CLIENT', 'KILL', '1.2.3.4:5678'))).toBe('ERR No such client');
    expect.soft(await errOf(t.call('CLIENT', 'KILL', 'FOO', 'bar'))).toBe('ERR syntax error');
    expect.soft(await errOf(t.call('CLIENT', 'KILL', 'TYPE', 'foo'))).toBe("ERR Unknown client type 'foo'");
    expect.soft(await errOf(t.call('CLIENT', 'KILL', 'USER', 'nouser'))).toBe("ERR No such user 'nouser'");
    expect.soft(await errOf(t.call('CLIENT', 'KILL', 'SKIPME', 'maybe'))).toBe('ERR syntax error');
    expect.soft(await errOf(t.call('CLIENT', 'KILL'))).toBe("ERR wrong number of arguments for 'client|kill' command");
  });

  it('KILL by LADDR / ADDR filter', async () => {
    const victim = await Sock.open(t.server.port);
    const info = await victim.write(enc('CLIENT', 'INFO'));
    const addr = /addr=(\S+)/.exec(info)?.[1];
    expect.soft(addr).toBeDefined();
    expect.soft(await t.call('CLIENT', 'KILL', 'ADDR', addr!)).toBe(1);
    await sleep(50);
    expect.soft(victim.closed).toBe(true);
  });

  it('UNBLOCK with TIMEOUT (default) makes the blocked command return null', async () => {
    const blocked = await t.raw();
    const id = (await blocked.send('CLIENT', 'ID')).slice(1, -2);
    const pending = blocked.send('BLPOP', 'unblock:list1', '0');
    await sleep(50);
    expect.soft(await t.call('CLIENT', 'UNBLOCK', id)).toBe(1);
    expect.soft(await pending).toBe('*-1\r\n');
    expect.soft(await t.call('CLIENT', 'UNBLOCK', id)).toBe(0);
  });

  it('UNBLOCK ERROR makes the blocked command fail', async () => {
    const blocked = await t.raw();
    const id = (await blocked.send('CLIENT', 'ID')).slice(1, -2);
    const pending = blocked.send('BLPOP', 'unblock:list2', '0');
    await sleep(50);
    expect.soft(await t.call('CLIENT', 'UNBLOCK', id, 'ERROR')).toBe(1);
    expect.soft(await pending).toBe('-UNBLOCKED client unblocked via CLIENT UNBLOCK\r\n');
  });

  it('UNBLOCK errors', async () => {
    const id = await t.call('CLIENT', 'ID');
    expect.soft(await t.call('CLIENT', 'UNBLOCK', String(id))).toBe(0);
    expect.soft(await errOf(t.call('CLIENT', 'UNBLOCK', String(id), 'FOO'))).toBe(
      'ERR CLIENT UNBLOCK reason should be TIMEOUT or ERROR',
    );
    expect.soft(await errOf(t.call('CLIENT', 'UNBLOCK', 'abc'))).toBe('ERR value is not an integer or out of range');
  });

  it('NO-TOUCH and NO-EVICT accept ON/OFF', async () => {
    const r = await t.raw();
    expect.soft(await r.send('CLIENT', 'NO-TOUCH', 'ON')).toBe('+OK\r\n');
    expect.soft(await r.send('CLIENT', 'NO-TOUCH', 'off')).toBe('+OK\r\n');
    expect.soft(await r.send('CLIENT', 'NO-TOUCH', 'maybe')).toBe('-ERR syntax error\r\n');
    expect.soft(await r.send('CLIENT', 'NO-EVICT', 'on')).toBe('+OK\r\n');
    expect.soft(await r.send('CLIENT', 'NO-EVICT', 'OFF')).toBe('+OK\r\n');
    expect.soft(await r.send('CLIENT', 'NO-EVICT', 'maybe')).toBe('-ERR syntax error\r\n');
    expect.soft(await r.send('CLIENT', 'NO-TOUCH')).toBe("-ERR wrong number of arguments for 'client|no-touch' command\r\n");
  });

  it('NO-TOUCH shows the T flag in CLIENT INFO', async () => {
    const r = await t.raw();
    await r.send('CLIENT', 'NO-TOUCH', 'ON');
    expect.soft(await r.send('CLIENT', 'INFO')).toMatch(/ flags=T /);
  });

  it('GETREDIR is -1 without tracking', async () => {
    expect.soft(await t.call('CLIENT', 'GETREDIR')).toBe(-1);
  });

  it('TRACKINGINFO without tracking', async () => {
    expect.soft(await t.call('CLIENT', 'TRACKINGINFO')).toEqual(['flags', ['off'], 'redirect', -1, 'prefixes', []]);
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('CLIENT', 'TRACKINGINFO')).toBe(
      '%3\r\n$5\r\nflags\r\n~1\r\n$3\r\noff\r\n$8\r\nredirect\r\n:-1\r\n$8\r\nprefixes\r\n*0\r\n',
    );
  });

  it('REPLY OFF / ON / SKIP', async () => {
    const s = await Sock.open(t.server.port);
    expect.soft(await s.write(enc('CLIENT', 'REPLY', 'OFF') + enc('PING') + enc('CLIENT', 'REPLY', 'ON') + enc('PING'))).toBe(
      '+OK\r\n+PONG\r\n',
    );
    expect.soft(await s.write(enc('CLIENT', 'REPLY', 'SKIP') + enc('ECHO', 'a') + enc('ECHO', 'b'))).toBe('$1\r\nb\r\n');
    expect.soft(await s.write(enc('CLIENT', 'REPLY', 'FOO'))).toBe('-ERR syntax error\r\n');
    s.close();
  });

  it('unknown subcommand and HELP', async () => {
    expect.soft(await errOf(t.call('CLIENT', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try CLIENT HELP.");
    const help = (await t.call('CLIENT', 'HELP')) as string[];
    expect.soft(Array.isArray(help)).toBe(true);
    expect.soft(help[0]).toBe('CLIENT <subcommand> [<arg> [value] [opt] ...]. Subcommands are:');
    expect.soft(await errOf(t.call('CLIENT'))).toBe("ERR wrong number of arguments for 'client' command");
  });
});
