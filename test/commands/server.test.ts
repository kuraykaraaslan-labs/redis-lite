import { connect } from 'node:net';
import type { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '../helpers';

/**
 * Connection, server and transaction commands.
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

/** Resolves to the reply, or to the error message if the command fails. */
function errOrValue(p: Promise<unknown>): Promise<unknown> {
  return p.catch((e: Error) => e.message);
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

describe('INFO', () => {
  it('default INFO contains the standard sections', async () => {
    const info = String(await t.call('INFO'));
    for (const s of ['# Server', '# Clients', '# Memory', '# Persistence', '# Stats', '# Replication', '# CPU', '# Keyspace']) {
      expect.soft(info).toContain(s);
    }
    expect.soft(info).not.toContain('# Commandstats');
    expect.soft(info).toContain('\r\n');
  });

  it('INFO server', async () => {
    const info = String(await t.call('INFO', 'server'));
    expect.soft(info.startsWith('# Server\r\n')).toBe(true);
    expect.soft(info).toMatch(/\r\nredis_version:8\.\d+\.\d+\r\n/);
    expect.soft(info).toContain('redis_mode:standalone\r\n');
    expect.soft(info).toContain(`tcp_port:${t.server.port}\r\n`);
    expect.soft(info).toMatch(/uptime_in_seconds:\d+\r\n/);
    expect.soft(info).not.toContain('# Clients');
  });

  it('INFO with several sections and case-insensitive names', async () => {
    const info = String(await t.call('INFO', 'SERVER', 'clients'));
    expect.soft(info).toContain('# Server');
    expect.soft(info).toContain('# Clients');
    expect.soft(info).toMatch(/connected_clients:\d+/);
    expect.soft(info).not.toContain('# Memory');
  });

  it('INFO replication / persistence / stats fields', async () => {
    expect.soft(String(await t.call('INFO', 'replication'))).toContain('role:master\r\n');
    expect.soft(String(await t.call('INFO', 'replication'))).toContain('connected_slaves:0\r\n');
    expect.soft(String(await t.call('INFO', 'persistence'))).toMatch(/rdb_last_save_time:\d+/);
    expect.soft(String(await t.call('INFO', 'stats'))).toMatch(/total_commands_processed:\d+/);
    expect.soft(String(await t.call('INFO', 'memory'))).toMatch(/used_memory:\d+/);
  });

  it('INFO all / everything include commandstats', async () => {
    expect.soft(String(await t.call('INFO', 'all'))).toContain('# Commandstats');
    expect.soft(String(await t.call('INFO', 'everything'))).toContain('# Commandstats');
    const cs = String(await t.call('INFO', 'commandstats'));
    expect.soft(cs).toMatch(/cmdstat_info:calls=\d+,usec=\d+,usec_per_call=[\d.]+,rejected_calls=\d+,failed_calls=\d+/);
  });

  it('INFO errorstats counts errors by prefix', async () => {
    await t.call('CONFIG', 'RESETSTAT');
    await errOf(t.call('SELECT', 'notanumber'));
    expect.soft(String(await t.call('INFO', 'errorstats'))).toContain('errorstat_ERR:count=1');
  });

  it('INFO for an unknown section is empty', async () => {
    const r = await t.raw();
    expect.soft(await r.send('INFO', 'nosuchsection')).toBe('$0\r\n\r\n');
  });

  it('INFO keyspace reports keys, expires and avg_ttl per db', async () => {
    const r = await t.raw();
    await r.send('SELECT', '5');
    await r.send('FLUSHDB');
    await r.send('SET', 'ks:a', '1');
    await r.send('SET', 'ks:b', '1', 'EX', '1000');
    const info = String(await t.call('INFO', 'keyspace'));
    expect.soft(info.startsWith('# Keyspace\r\n')).toBe(true);
    expect.soft(info).toMatch(/\r\ndb5:keys=2,expires=1,avg_ttl=\d+,subexpiry=0\r\n/);
    await r.send('FLUSHDB');
    expect.soft(String(await t.call('INFO', 'keyspace'))).not.toContain('db5:');
  });

  it('INFO is a verbatim string in RESP3', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('INFO', 'server')).toMatch(/^=\d+\r\ntxt:# Server\r\n/);
  });
});

describe('CONFIG', () => {
  it('GET returns name/value pairs', async () => {
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory')).toEqual(['maxmemory', '0']);
    expect.soft(await t.call('CONFIG', 'GET', 'nosuchoption')).toEqual([]);
    expect.soft(await t.call('CONFIG', 'GET', 'databases')).toEqual(['databases', '16']);
  });

  it('GET with globs', async () => {
    const res = pairs(await t.call('CONFIG', 'GET', 'maxmemory*'));
    expect.soft(res.maxmemory).toBe('0');
    expect.soft(res['maxmemory-policy']).toBe('noeviction');
    expect.soft(res['maxmemory-samples']).toBe('5');
    const q = pairs(await t.call('CONFIG', 'GET', 'maxmemor?'));
    expect.soft(Object.keys(q)).toEqual(['maxmemory']);
  });

  it('GET with several parameters', async () => {
    const res = pairs(await t.call('CONFIG', 'GET', 'maxmemory', 'databases'));
    expect.soft(res).toEqual({ maxmemory: '0', databases: '16' });
    // the same option asked twice is reported once
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory', 'maxmemory')).toEqual(['maxmemory', '0']);
  });

  it('GET of an alias returns the alias name', async () => {
    expect.soft(await t.call('CONFIG', 'GET', 'hash-max-ziplist-entries')).toEqual(['hash-max-ziplist-entries', '128']);
    expect.soft(await t.call('CONFIG', 'GET', 'hash-max-listpack-entries')).toEqual(['hash-max-listpack-entries', '128']);
  });

  it('SET through an alias changes the real option', async () => {
    expect.soft(await t.call('CONFIG', 'SET', 'hash-max-ziplist-entries', '64')).toBe('OK');
    expect.soft(await t.call('CONFIG', 'GET', 'hash-max-listpack-entries')).toEqual(['hash-max-listpack-entries', '64']);
    await t.call('CONFIG', 'SET', 'hash-max-listpack-entries', '128');
  });

  it('SET with memory units and several pairs', async () => {
    expect.soft(await t.call('CONFIG', 'SET', 'maxmemory', '1mb', 'maxmemory-samples', '7')).toBe('OK');
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory')).toEqual(['maxmemory', '1048576']);
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory-samples')).toEqual(['maxmemory-samples', '7']);
    await t.call('CONFIG', 'SET', 'maxmemory', '0', 'maxmemory-samples', '5');
  });

  it('SET errors', async () => {
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'nosuchoption', 'x'))).toBe(
      "ERR Unknown option or number of arguments for CONFIG SET - 'nosuchoption'",
    );
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory', 'abc'))).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'maxmemory') - argument must be a memory value",
    );
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory'))).toBe("ERR wrong number of arguments for 'config|set' command");
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory', '1', 'maxmemory-samples'))).toBe(
      "ERR wrong number of arguments for 'config|set' command",
    );
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory-policy', 'bogus'))).toMatch(
      /^ERR CONFIG SET failed \(possibly related to argument 'maxmemory-policy'\) - argument\(s\) must be one of the following: /,
    );
  });

  it('SET is atomic: a bad pair leaves the others unchanged', async () => {
    await errOf(t.call('CONFIG', 'SET', 'maxmemory-samples', '9', 'maxmemory', 'abc'));
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory-samples')).toEqual(['maxmemory-samples', '5']);
  });

  it('SET of the same parameter twice is rejected', async () => {
    // Redis configSetCommand(): errstr "duplicate parameter", reported as "CONFIG SET failed (possibly related to argument '%s') - %s"
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory', '1', 'maxmemory', '2'))).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'maxmemory') - duplicate parameter",
    );
  });

  it('RESETSTAT resets the stats', async () => {
    expect.soft(await t.call('CONFIG', 'RESETSTAT')).toBe('OK');
    expect.soft(String(await t.call('INFO', 'stats'))).toContain('total_error_replies:0');
    expect.soft(await errOf(t.call('CONFIG', 'RESETSTAT', 'x'))).toBe("ERR wrong number of arguments for 'config|resetstat' command");
  });

  it('GET in RESP3 is a map', async () => {
    await t.call('CONFIG', 'SET', 'maxmemory', '0');
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('CONFIG', 'GET', 'maxmemory')).toBe('%1\r\n$9\r\nmaxmemory\r\n$1\r\n0\r\n');
    expect.soft(await r.send('CONFIG', 'GET', 'nosuchoption')).toBe('%0\r\n');
  });

  it('unknown subcommand and arity', async () => {
    expect.soft(await errOf(t.call('CONFIG', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try CONFIG HELP.");
    expect.soft(await errOf(t.call('CONFIG', 'GET'))).toBe("ERR wrong number of arguments for 'config|get' command");
    expect.soft(await errOf(t.call('CONFIG'))).toBe("ERR wrong number of arguments for 'config' command");
  });
});

describe('TIME / LASTSAVE / SAVE / BGSAVE / ROLE / DEBUG / LOLWUT', () => {
  it('TIME returns seconds and microseconds as bulk strings', async () => {
    const r = await t.raw();
    const reply = await r.send('TIME');
    const m = /^\*2\r\n\$\d+\r\n(\d+)\r\n\$\d+\r\n(\d+)\r\n$/.exec(reply);
    expect.soft(m).not.toBeNull();
    expect.soft(Math.abs(Number(m![1]) - Date.now() / 1000)).toBeLessThan(5);
    expect.soft(Number(m![2])).toBeLessThan(1_000_000);
    expect.soft(await r.send('TIME', 'x')).toBe("-ERR wrong number of arguments for 'time' command\r\n");
    await r.send('HELLO', '3');
    expect.soft(await r.send('TIME')).toMatch(/^\*2\r\n\$\d+\r\n\d+\r\n\$\d+\r\n\d+\r\n$/);
  });

  it('SAVE / BGSAVE / LASTSAVE', async () => {
    const r = await t.raw();
    expect.soft(await r.send('SAVE')).toBe('+OK\r\n');
    const last = await r.send('LASTSAVE');
    expect.soft(last).toMatch(/^:\d+\r\n$/);
    expect.soft(Math.abs(Number(last.slice(1, -2)) - Date.now() / 1000)).toBeLessThan(5);
    await sleep(200);
    expect.soft(await r.send('BGSAVE')).toBe('+Background saving started\r\n');
    await sleep(200);
    expect.soft(await r.send('BGSAVE', 'FOO')).toBe('-ERR syntax error\r\n');
    expect.soft(await r.send('SAVE', 'x')).toBe("-ERR wrong number of arguments for 'save' command\r\n");
    expect.soft(await r.send('LASTSAVE', 'x')).toBe("-ERR wrong number of arguments for 'lastsave' command\r\n");
  });

  it('ROLE on a master', async () => {
    expect.soft(await t.call('ROLE')).toEqual(['master', 0, []]);
    const r = await t.raw();
    expect.soft(await r.send('ROLE')).toBe('*3\r\n$6\r\nmaster\r\n:0\r\n*0\r\n');
  });

  it('DEBUG SLEEP', async () => {
    expect.soft(await t.call('DEBUG', 'SLEEP', '0')).toBe('OK');
    const start = Date.now();
    expect.soft(await t.call('DEBUG', 'SLEEP', '0.1')).toBe('OK');
    expect.soft(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  it('LOLWUT ends with the Redis version', async () => {
    const out = String(await t.call('LOLWUT'));
    expect.soft(out).toMatch(/Redis ver\. 8\.\d+\.\d+/);
    expect.soft(String(await t.call('LOLWUT', 'VERSION', '5'))).toContain('Redis ver.');
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('LOLWUT')).toMatch(/^=\d+\r\ntxt:/);
  });
});

describe('COMMAND', () => {
  it('COUNT matches the length of COMMAND', async () => {
    const count = (await t.call('COMMAND', 'COUNT')) as number;
    expect.soft(count).toBeGreaterThan(200);
    const all = (await t.call('COMMAND')) as unknown[];
    expect.soft(all).toHaveLength(count);
  });

  it('LIST and FILTERBY', async () => {
    const list = (await t.call('COMMAND', 'LIST')) as string[];
    expect.soft(list).toContain('get');
    expect.soft(list).toContain('client');
    const xa = (await t.call('COMMAND', 'LIST', 'FILTERBY', 'PATTERN', 'xa*')) as string[];
    expect.soft(xa).toEqual(expect.arrayContaining(['xack', 'xadd', 'xautoclaim']));
    expect.soft(xa.every((n) => n.startsWith('xa'))).toBe(true);
    const hll = (await t.call('COMMAND', 'LIST', 'FILTERBY', 'ACLCAT', 'hyperloglog')) as string[];
    expect.soft(hll).toEqual(expect.arrayContaining(['pfadd', 'pfcount', 'pfmerge']));
    expect.soft(await t.call('COMMAND', 'LIST', 'FILTERBY', 'MODULE', 'nosuchmodule')).toEqual([]);
    expect.soft(await errOf(t.call('COMMAND', 'LIST', 'FILTERBY', 'FOO', 'x'))).toBe('ERR syntax error');
  });

  it('INFO for GET', async () => {
    const [info] = (await t.call('COMMAND', 'INFO', 'get')) as unknown[][];
    expect.soft(info.slice(0, 7)).toEqual(['get', 2, ['readonly', 'fast'], 1, 1, 1, ['@read', '@string', '@fast']]);
    expect.soft(info[7]).toEqual([]);
    expect.soft(info[8]).toEqual([
      ['flags', ['RO', 'access'], 'begin_search', ['type', 'index', 'spec', ['index', 1]], 'find_keys', ['type', 'range', 'spec', ['lastkey', 0, 'keystep', 1, 'limit', 0]]],
    ]);
    expect.soft(info[9]).toEqual([]);
  });

  it('INFO uses status replies for flags and categories', async () => {
    const r = await t.raw();
    const reply = await r.send('COMMAND', 'INFO', 'get');
    expect.soft(reply.startsWith('*1\r\n*10\r\n$3\r\nget\r\n:2\r\n*2\r\n+readonly\r\n+fast\r\n:1\r\n:1\r\n:1\r\n*3\r\n+@read\r\n+@string\r\n+@fast\r\n')).toBe(true);
  });

  it('INFO for several commands, unknown ones are null, case-insensitive', async () => {
    const res = (await t.call('COMMAND', 'INFO', 'GET', 'nosuchcmd', 'set')) as unknown[];
    expect.soft(res).toHaveLength(3);
    expect.soft((res[0] as unknown[])[0]).toBe('get');
    expect.soft(res[1]).toBeNull();
    expect.soft((res[2] as unknown[]).slice(0, 2)).toEqual(['set', -3]);
  });

  it('INFO for a container command lists subcommands', async () => {
    const [info] = (await t.call('COMMAND', 'INFO', 'config')) as unknown[][];
    expect.soft(info[0]).toBe('config');
    expect.soft(info[1]).toBe(-2);
    const subs = (info[9] as unknown[][]).map((s) => s[0]);
    expect.soft(subs).toEqual(expect.arrayContaining(['config|get', 'config|set', 'config|resetstat']));
    const [sub] = (await t.call('COMMAND', 'INFO', 'config|get')) as unknown[][];
    expect.soft(sub.slice(0, 2)).toEqual(['config|get', -3]);
  });

  it('GETKEYS and GETKEYSANDFLAGS', async () => {
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'SET', 'a', 'b'))).toEqual(['a']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'MSET', 'a', '1', 'b', '2'))).toEqual(['a', 'b']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'EVAL', 'return 1', '2', 'k1', 'k2', 'arg'))).toEqual(['k1', 'k2']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'ZUNIONSTORE', 'dst', '2', 's1', 's2'))).toEqual(['dst', 's1', 's2']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYSANDFLAGS', 'GET', 'k'))).toEqual([['k', ['RO', 'access']]]);
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS', 'PING'))).toBe('ERR The command has no key arguments');
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS', 'NOSUCH', 'a'))).toBe('ERR Invalid command specified');
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS', 'GET'))).toBe('ERR Invalid number of arguments specified for command');
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS'))).toBe("ERR wrong number of arguments for 'command|getkeys' command");
  });

  it('DOCS for GET', async () => {
    const res = (await t.call('COMMAND', 'DOCS', 'get')) as unknown[];
    expect.soft(res[0]).toBe('get');
    const doc = pairs(res[1]);
    expect.soft(doc.summary).toBe('Returns the string value of a key.');
    expect.soft(doc.since).toBe('1.0.0');
    expect.soft(doc.group).toBe('string');
    expect.soft(doc.complexity).toBe('O(1)');
    const args = (doc.arguments as unknown[][]).map(pairs);
    expect.soft(args[0]).toMatchObject({ name: 'key', type: 'key', display_text: 'key', key_spec_index: 0 });
    expect.soft(await t.call('COMMAND', 'DOCS', 'nosuchcmd')).toEqual([]);
  });

  it('DOCS in RESP3 is a map', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft((await r.send('COMMAND', 'DOCS', 'get')).startsWith('%1\r\n$3\r\nget\r\n%')).toBe(true);
  });

  it('unknown subcommand', async () => {
    expect.soft(await errOf(t.call('COMMAND', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try COMMAND HELP.");
  });
});

describe('ACL', () => {
  it('WHOAMI / USERS / LIST', async () => {
    expect.soft(await t.call('ACL', 'WHOAMI')).toBe('default');
    expect.soft(await t.call('ACL', 'USERS')).toEqual(['default']);
    expect.soft(await t.call('ACL', 'LIST')).toEqual(['user default on nopass sanitize-payload ~* &* +@all']);
  });

  it('CAT lists categories and the commands in a category', async () => {
    const cats = (await t.call('ACL', 'CAT')) as string[];
    expect.soft(cats).toEqual(
      expect.arrayContaining([
        'keyspace', 'read', 'write', 'set', 'sortedset', 'list', 'hash', 'string', 'bitmap', 'hyperloglog', 'geo',
        'stream', 'pubsub', 'admin', 'fast', 'slow', 'blocking', 'dangerous', 'connection', 'transaction', 'scripting',
      ]),
    );
    const str = (await t.call('ACL', 'CAT', 'string')) as string[];
    expect.soft(str).toEqual(expect.arrayContaining(['get', 'set', 'incr', 'append']));
    expect.soft(str).not.toContain('lpush');
    expect.soft(await errOf(t.call('ACL', 'CAT', 'nosuchcat'))).toBe("ERR Unknown category 'nosuchcat'");
  });

  it('GETUSER default', async () => {
    const u = pairs(await t.call('ACL', 'GETUSER', 'default'));
    expect.soft(u.flags).toEqual(['on', 'nopass', 'sanitize-payload']);
    expect.soft(u.passwords).toEqual([]);
    expect.soft(u.commands).toBe('+@all');
    expect.soft(u.keys).toBe('~*');
    expect.soft(u.channels).toBe('&*');
    expect.soft(u.selectors).toEqual([]);
    expect.soft(await t.call('ACL', 'GETUSER', 'nosuchuser')).toBeNull();
  });

  it('GETUSER in RESP3 is a map', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft((await r.send('ACL', 'GETUSER', 'default')).startsWith('%6\r\n$5\r\nflags\r\n')).toBe(true);
    expect.soft(await r.send('ACL', 'GETUSER', 'nosuchuser')).toBe('_\r\n');
  });

  it('GENPASS', async () => {
    expect.soft(await t.call('ACL', 'GENPASS')).toMatch(/^[0-9a-f]{64}$/);
    expect.soft(await t.call('ACL', 'GENPASS', '32')).toMatch(/^[0-9a-f]{8}$/);
    expect.soft(await t.call('ACL', 'GENPASS', '5')).toMatch(/^[0-9a-f]{2}$/);
    expect.soft(await t.call('ACL', 'GENPASS')).not.toBe(await t.call('ACL', 'GENPASS'));
    const msg = 'ERR ACL GENPASS argument must be the number of bits for the output password, a positive number up to 4096';
    expect.soft(await errOf(t.call('ACL', 'GENPASS', '0'))).toBe(msg);
    expect.soft(await errOf(t.call('ACL', 'GENPASS', '5000'))).toBe(msg);
  });

  it('DRYRUN', async () => {
    expect.soft(await t.call('ACL', 'DRYRUN', 'default', 'GET', 'k')).toBe('OK');
    expect.soft(await errOf(t.call('ACL', 'DRYRUN', 'nosuchuser', 'GET', 'k'))).toBe("ERR User 'nosuchuser' not found");
    // unverified: exact wording for an unknown command
    expect.soft(await errOf(t.call('ACL', 'DRYRUN', 'default', 'NOSUCHCMD'))).toBe("ERR Command 'NOSUCHCMD' not found");
  });

  it('LOG is empty and can be reset', async () => {
    expect.soft(await t.call('ACL', 'LOG')).toEqual([]);
    expect.soft(await t.call('ACL', 'LOG', '5')).toEqual([]);
    expect.soft(await t.call('ACL', 'LOG', 'RESET')).toBe('OK');
  });

  it('unknown subcommand and arity', async () => {
    expect.soft(await errOf(t.call('ACL', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try ACL HELP.");
    expect.soft(await errOf(t.call('ACL', 'WHOAMI', 'x'))).toBe("ERR wrong number of arguments for 'acl|whoami' command");
    expect.soft(await errOf(t.call('ACL'))).toBe("ERR wrong number of arguments for 'acl' command");
  });
});

describe('MONITOR / SLOWLOG / LATENCY / MEMORY', () => {
  it('MONITOR streams executed commands', async () => {
    const m = await t.raw();
    expect.soft(await m.send('MONITOR')).toBe('+OK\r\n');
    const r = await t.raw();
    await r.send('SET', 'mon:k', 'v a');
    const line = await m.read();
    expect.soft(line).toMatch(/^\+\d+\.\d{6} \[0 127\.0\.0\.1:\d+\] "SET" "mon:k" "v a"\r\n$/);
  });

  it('SLOWLOG GET / LEN / RESET', async () => {
    expect.soft(await t.call('SLOWLOG', 'RESET')).toBe('OK');
    expect.soft(await t.call('SLOWLOG', 'LEN')).toBe(0);
    expect.soft(await t.call('SLOWLOG', 'GET')).toEqual([]);
    await t.call('DEBUG', 'SLEEP', '0.05');
    const entries = (await t.call('SLOWLOG', 'GET')) as unknown[][];
    expect.soft(entries).toHaveLength(1);
    const [id, ts, dur, argv, , name] = entries[0];
    expect.soft(typeof id).toBe('number');
    expect.soft(typeof ts).toBe('number');
    expect.soft(dur as number).toBeGreaterThanOrEqual(10000);
    expect.soft(argv).toEqual(['DEBUG', 'SLEEP', '0.05']);
    expect.soft(name).toBe('');
    expect.soft(await t.call('SLOWLOG', 'LEN')).toBe(1);
    expect.soft(await t.call('SLOWLOG', 'GET', '-1')).toHaveLength(1);
    expect.soft(await t.call('SLOWLOG', 'GET', '0')).toEqual([]);
    expect.soft(await t.call('SLOWLOG', 'RESET')).toBe('OK');
    expect.soft(await t.call('SLOWLOG', 'LEN')).toBe(0);
    expect.soft(await errOf(t.call('SLOWLOG', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try SLOWLOG HELP.");
  });

  it('LATENCY', async () => {
    expect.soft(await t.call('LATENCY', 'LATEST')).toEqual([]);
    expect.soft(await t.call('LATENCY', 'HISTORY', 'command')).toEqual([]);
    expect.soft(await t.call('LATENCY', 'RESET')).toBe(0);
    expect.soft(typeof (await t.call('LATENCY', 'DOCTOR'))).toBe('string');
    expect.soft(await errOf(t.call('LATENCY', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try LATENCY HELP.");
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('LATENCY', 'DOCTOR')).toMatch(/^=\d+\r\ntxt:/);
  });

  it('MEMORY USAGE', async () => {
    await t.call('SET', 'mem:k', 'hello');
    const used = (await t.call('MEMORY', 'USAGE', 'mem:k')) as number;
    expect.soft(used).toBeGreaterThan(0);
    expect.soft(await t.call('MEMORY', 'USAGE', 'mem:k', 'SAMPLES', '0')).toBeGreaterThan(0);
    expect.soft(await t.call('MEMORY', 'USAGE', 'mem:missing')).toBeNull();
    await t.call('RPUSH', 'mem:list', 'a', 'b');
    expect.soft(await t.call('MEMORY', 'USAGE', 'mem:list')).toBeGreaterThan(0);
    expect.soft(await errOf(t.call('MEMORY', 'USAGE', 'mem:k', 'FOO'))).toBe('ERR syntax error');
    expect.soft(await errOf(t.call('MEMORY', 'USAGE', 'mem:k', 'SAMPLES', 'x'))).toBe('ERR value is not an integer or out of range');
    expect.soft(await errOf(t.call('MEMORY', 'USAGE'))).toBe("ERR wrong number of arguments for 'memory|usage' command");
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('MEMORY', 'USAGE', 'mem:missing')).toBe('_\r\n');
  });

  it('MEMORY DOCTOR', async () => {
    expect.soft(typeof (await t.call('MEMORY', 'DOCTOR'))).toBe('string');
    expect.soft(await errOf(t.call('MEMORY', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try MEMORY HELP.");
  });
});

describe('WAIT / WAITAOF', () => {
  it('WAIT with no replicas returns 0', async () => {
    expect.soft(await t.call('WAIT', '0', '0')).toBe(0);
    expect.soft(await t.call('WAIT', '1', '10')).toBe(0);
    expect.soft(await errOf(t.call('WAIT', '0', '-1'))).toBe('ERR timeout is negative');
    expect.soft(await errOf(t.call('WAIT', 'abc', '0'))).toBe('ERR value is not an integer or out of range');
    expect.soft(await errOf(t.call('WAIT', '0'))).toBe("ERR wrong number of arguments for 'wait' command");
  });

  it('WAITAOF', async () => {
    expect.soft(await t.call('WAITAOF', '0', '0', '0')).toEqual([0, 0]);
    expect.soft(await errOf(t.call('WAITAOF', '1', '0', '0'))).toBe(
      'ERR WAITAOF cannot be used when numlocal is set but appendonly is disabled.',
    );
    expect.soft(await errOf(t.call('WAITAOF', '0', '0'))).toBe("ERR wrong number of arguments for 'waitaof' command");
  });
});

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

describe('protocol level', () => {
  it('pipelined commands are answered in order', async () => {
    const s = await Sock.open(t.server.port);
    const out = await s.write(enc('SET', 'pipe:k', '1') + enc('INCR', 'pipe:k') + enc('GET', 'pipe:k') + enc('PING') + enc('NOSUCH'));
    expect.soft(out).toBe("+OK\r\n:2\r\n$1\r\n2\r\n+PONG\r\n-ERR unknown command 'NOSUCH', with args beginning with: \r\n");
    s.close();
  });

  it('ioredis pipeline works', async () => {
    const res = await t.redis.pipeline().set('pipe:i', 'a').append('pipe:i', 'b').get('pipe:i').exec();
    expect.soft(res).toEqual([[null, 'OK'], [null, 2], [null, 'ab']]);
  });

  it('unknown command error text', async () => {
    expect.soft(await errOf(t.call('FOOBAR'))).toBe("ERR unknown command 'FOOBAR', with args beginning with: ");
    expect.soft(await errOf(t.call('foobar', 'a', 'b c'))).toBe("ERR unknown command 'foobar', with args beginning with: 'a' 'b c' ");
  });

  it('wrong arity error text uses the lowercase command name', async () => {
    expect.soft(await errOf(t.call('GET'))).toBe("ERR wrong number of arguments for 'get' command");
    expect.soft(await errOf(t.call('Set', 'k'))).toBe("ERR wrong number of arguments for 'set' command");
  });

  it('RESP2 subscriber mode restricts commands', async () => {
    const r = await t.raw();
    expect.soft(await r.send('SUBSCRIBE', 'sub:ch')).toBe('*3\r\n$9\r\nsubscribe\r\n$6\r\nsub:ch\r\n:1\r\n');
    expect.soft(await r.send('GET', 'k')).toBe(
      "-ERR Can't execute 'get': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context\r\n",
    );
    expect.soft(await r.send('PING')).toBe('*2\r\n$4\r\npong\r\n$0\r\n\r\n');
    expect.soft(await r.send('PING', 'hi')).toBe('*2\r\n$4\r\npong\r\n$2\r\nhi\r\n');
    expect.soft(await r.send('UNSUBSCRIBE')).toBe('*3\r\n$11\r\nunsubscribe\r\n$6\r\nsub:ch\r\n:0\r\n');
    expect.soft(await r.send('GET', 'sub:missing')).toBe('$-1\r\n');
  });

  it('inline commands', async () => {
    const s = await Sock.open(t.server.port);
    expect.soft(await s.write('PING\r\n')).toBe('+PONG\r\n');
    expect.soft(await s.write('SET inl:k "hello world"\r\n')).toBe('+OK\r\n');
    expect.soft(await s.write('GET inl:k\r\n')).toBe('$11\r\nhello world\r\n');
    expect.soft(await s.write("ECHO 'a b'\r\n")).toBe('$3\r\na b\r\n');
    expect.soft(await s.write('ECHO "a\\x41\\n"\r\n')).toBe('$3\r\naA\n\r\n');
    expect.soft(await s.write('PING\n')).toBe('+PONG\r\n');
    expect.soft(await s.write('   PING   \r\n')).toBe('+PONG\r\n');
    expect.soft(await s.write('\r\n', 50)).toBe('');
    expect.soft(await s.write('PING\r\nPING\r\n')).toBe('+PONG\r\n+PONG\r\n');
    s.close();
  });

  it('inline command with unbalanced quotes is a protocol error that closes the connection', async () => {
    const s = await Sock.open(t.server.port);
    expect.soft(await s.write('ECHO "abc\r\n')).toBe('-ERR Protocol error: unbalanced quotes in request\r\n');
    await sleep(50);
    expect.soft(s.closed).toBe(true);
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
