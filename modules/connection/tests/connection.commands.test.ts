import { connect } from 'node:net';
import type { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';

/**
 * Connection commands.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

/** Encodes one command as a RESP array of bulk strings. */
function enc(...args: Array<string | number>): string {
  const parts = args.map(String);
  return `*${parts.length}\r\n${parts.map((a) => `$${Buffer.byteLength(a, 'latin1')}\r\n${a}\r\n`).join('')}`;
}

/** Bare socket for pipelining, inline commands and connection-close checks. */
class Sock {
  buffer = '';
  closed = false;
  private constructor(private readonly socket: Socket) {
    socket.setEncoding('latin1');
    socket.on('data', (d: string) => {
      this.buffer += d;
    });
    socket.on('close', () => {
      this.closed = true;
    });
  }

  static open(port: number): Promise<Sock> {
    return new Promise((resolve) => {
      const s = connect(port, '127.0.0.1', () => resolve(new Sock(s)));
    });
  }

  /** Writes raw bytes and returns everything received within `ms`. */
  async write(data: string, ms = 80): Promise<string> {
    this.buffer = '';
    this.socket.write(data, 'latin1');
    await sleep(ms);
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  close(): void {
    this.socket.destroy();
  }
}

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

/** Converts a flat [k, v, k, v] RESP2 array into an object. */
function pairs(arr: unknown): Record<string, unknown> {
  const a = arr as unknown[];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < a.length; i += 2) out[String(a[i])] = a[i + 1];
  return out;
}

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
    expect.soft(hello).toMatch(/\$7\r\nversion\r\n\$\d+\r\n8\.\d+\.\d+\r\n/);
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
    expect.soft(info).toMatch(/ resp=2 /);
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
    await sleep(50);
    expect.soft(s.closed).toBe(true);
  });
});

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
    expect.soft(list[0]).toBe('user default on sanitize-payload #2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b ~* &* +@all');
  });

  it('CONFIG GET requirepass', async () => {
    expect.soft(await ta.call('CONFIG', 'GET', 'requirepass')).toEqual(['requirepass', 'secret']);
  });

  it('the authenticated ioredis client works', async () => {
    expect.soft(await ta.call('PING')).toBe('PONG');
  });
});
