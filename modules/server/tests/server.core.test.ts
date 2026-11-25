import { connect } from 'node:net';
import type { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';

/**
 * Dispatcher behaviour at the protocol level.
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
