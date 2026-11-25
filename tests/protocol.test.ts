import { connect } from 'node:net';

import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

const t = useServer();

/** Writes raw bytes and collects the reply until `done(received)` is true, the socket closes, or the timeout hits. */
function rawExchange(payload: string | Buffer, done: (s: string) => boolean, timeoutMs = 2000): Promise<{ data: string; closed: boolean }> {
  return new Promise((resolve) => {
    let data = '';
    let closed = false;
    const s = connect(t.server.port, '127.0.0.1', () => {
      s.write(payload);
    });
    s.setEncoding('latin1');
    const finish = () => {
      clearTimeout(timer);
      s.destroy();
      resolve({ data, closed });
    };
    const timer = setTimeout(finish, timeoutMs);
    s.on('data', (d: string) => {
      data += d;
      if (done(data)) finish();
    });
    s.on('close', () => {
      closed = true;
      finish();
    });
    s.on('error', () => undefined);
  });
}

const cmd = (...args: string[]) => `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------
describe('HELLO', () => {
  it('HELLO with no args returns the RESP2 info array', async () => {
    const r = (await t.client().call('HELLO')) as unknown[];
    const m: Record<string, unknown> = {};
    for (let i = 0; i < r.length; i += 2) m[String(r[i])] = r[i + 1];
    expect(Object.keys(m)).toEqual(['server', 'version', 'proto', 'id', 'mode', 'role', 'modules']);
    expect(m.server).toBe('redis');
    expect(m.proto).toBe(2);
    expect(typeof m.id).toBe('number');
    expect(m.mode).toBe('standalone');
    expect(m.role).toBe('master');
    expect(m.modules).toEqual([]);
  });

  it('HELLO 3 returns a map, HELLO 2 switches back', async () => {
    const r = await t.raw();
    const h3 = await r.send('HELLO', '3');
    expect(h3.startsWith('%7\r\n$6\r\nserver\r\n$5\r\nredis\r\n$7\r\nversion\r\n')).toBe(true);
    expect(h3).toContain('$5\r\nproto\r\n:3\r\n');
    expect(h3).toContain('$4\r\nmode\r\n$10\r\nstandalone\r\n$4\r\nrole\r\n$6\r\nmaster\r\n$7\r\nmodules\r\n*0\r\n');
    expect(await r.send('GET', 'hello:missing')).toBe('_\r\n');
    const noArgs = await r.send('HELLO');
    expect(noArgs.startsWith('%7\r\n')).toBe(true);
    expect(noArgs).toContain('$5\r\nproto\r\n:3\r\n');
    const h2 = await r.send('HELLO', '2');
    expect(h2.startsWith('*14\r\n$6\r\nserver\r\n$5\r\nredis\r\n')).toBe(true);
    expect(h2).toContain('$5\r\nproto\r\n:2\r\n');
    expect(await r.send('GET', 'hello:missing')).toBe('$-1\r\n');
  });

  it('HELLO errors', async () => {
    const r = await t.raw();
    expect(await r.send('HELLO', '4')).toBe('-NOPROTO unsupported protocol version\r\n');
    expect(await r.send('HELLO', '1')).toBe('-NOPROTO unsupported protocol version\r\n');
    expect(await r.send('HELLO', 'abc')).toBe('-ERR Protocol version is not an integer or out of range\r\n');
  });

  it('HELLO 3 SETNAME', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3', 'SETNAME', 'proto-client');
    expect(await r.send('CLIENT', 'GETNAME')).toBe('$12\r\nproto-client\r\n');
  });
});

describe('RESP2 vs RESP3 encodings', () => {
  it('nulls', async () => {
    await t.call('DEL', 'p:nolist');
    const r2 = await t.raw();
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    expect(await r2.send('GET', 'p:none')).toBe('$-1\r\n');
    expect(await r3.send('GET', 'p:none')).toBe('_\r\n');
    expect(await r2.send('LPOP', 'p:nolist', '2')).toBe('*-1\r\n');
    expect(await r3.send('LPOP', 'p:nolist', '2')).toBe('_\r\n');
    expect(await r2.send('HGET', 'p:nohash', 'f')).toBe('$-1\r\n');
    expect(await r3.send('HGET', 'p:nohash', 'f')).toBe('_\r\n');
  });

  it('maps: HGETALL, CONFIG GET, XINFO STREAM', async () => {
    await t.call('DEL', 'p:h', 'p:s');
    await t.call('HSET', 'p:h', 'f1', 'v1');
    await t.call('XADD', 'p:s', '1-1', 'a', 'b');
    const r2 = await t.raw();
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    expect(await r2.send('HGETALL', 'p:h')).toBe('*2\r\n$2\r\nf1\r\n$2\r\nv1\r\n');
    expect(await r3.send('HGETALL', 'p:h')).toBe('%1\r\n$2\r\nf1\r\n$2\r\nv1\r\n');
    expect(await r3.send('HGETALL', 'p:nohash')).toBe('%0\r\n');
    expect(await r2.send('CONFIG', 'GET', 'maxmemory-policy')).toBe('*2\r\n$16\r\nmaxmemory-policy\r\n$10\r\nnoeviction\r\n');
    expect(await r3.send('CONFIG', 'GET', 'maxmemory-policy')).toBe('%1\r\n$16\r\nmaxmemory-policy\r\n$10\r\nnoeviction\r\n');
    const x2 = await r2.send('XINFO', 'STREAM', 'p:s');
    expect(x2.startsWith('*')).toBe(true);
    expect(x2).toContain('$6\r\nlength\r\n:1\r\n');
    const x3 = await r3.send('XINFO', 'STREAM', 'p:s');
    expect(x3.startsWith('%')).toBe(true);
    expect(x3).toContain('$6\r\nlength\r\n:1\r\n');
  });

  it('sets', async () => {
    await t.call('DEL', 'p:set');
    await t.call('SADD', 'p:set', 'only');
    const r2 = await t.raw();
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    expect(await r2.send('SMEMBERS', 'p:set')).toBe('*1\r\n$4\r\nonly\r\n');
    expect(await r3.send('SMEMBERS', 'p:set')).toBe('~1\r\n$4\r\nonly\r\n');
    expect(await r3.send('SMEMBERS', 'p:noset')).toBe('~0\r\n');
    expect(await r3.send('SINTER', 'p:set', 'p:set')).toBe('~1\r\n$4\r\nonly\r\n');
  });

  it('doubles: ZSCORE, ZINCRBY, ZADD INCR, ZMSCORE, inf', async () => {
    await t.call('DEL', 'p:z');
    await t.call('ZADD', 'p:z', '1.5', 'a', '2', 'b', 'inf', 'pinf', '-inf', 'ninf');
    const r2 = await t.raw();
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    expect(await r2.send('ZSCORE', 'p:z', 'a')).toBe('$3\r\n1.5\r\n');
    expect(await r3.send('ZSCORE', 'p:z', 'a')).toBe(',1.5\r\n');
    expect(await r2.send('ZSCORE', 'p:z', 'b')).toBe('$1\r\n2\r\n');
    expect(await r3.send('ZSCORE', 'p:z', 'b')).toBe(',2\r\n');
    expect(await r3.send('ZSCORE', 'p:z', 'nomember')).toBe('_\r\n');
    expect(await r2.send('ZSCORE', 'p:z', 'pinf')).toBe('$3\r\ninf\r\n');
    expect(await r3.send('ZSCORE', 'p:z', 'pinf')).toBe(',inf\r\n');
    expect(await r2.send('ZSCORE', 'p:z', 'ninf')).toBe('$4\r\n-inf\r\n');
    expect(await r3.send('ZSCORE', 'p:z', 'ninf')).toBe(',-inf\r\n');
    expect(await r2.send('ZINCRBY', 'p:z', '1', 'a')).toBe('$3\r\n2.5\r\n');
    expect(await r3.send('ZINCRBY', 'p:z', '1', 'a')).toBe(',3.5\r\n');
    expect(await r2.send('ZADD', 'p:z', 'INCR', '1', 'a')).toBe('$3\r\n4.5\r\n');
    expect(await r3.send('ZADD', 'p:z', 'INCR', '1', 'a')).toBe(',5.5\r\n');
    expect(await r2.send('ZADD', 'p:z', 'NX', 'INCR', '1', 'a')).toBe('$-1\r\n');
    expect(await r3.send('ZADD', 'p:z', 'NX', 'INCR', '1', 'a')).toBe('_\r\n');
    expect(await r2.send('ZMSCORE', 'p:z', 'b', 'nomember')).toBe('*2\r\n$1\r\n2\r\n$-1\r\n');
    expect(await r3.send('ZMSCORE', 'p:z', 'b', 'nomember')).toBe('*2\r\n,2\r\n_\r\n');
  });

  it('verbatim strings: INFO, CLIENT INFO, CLIENT LIST', async () => {
    const r2 = await t.raw();
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    const checkVerbatim = (s: string) => {
      const m = /^=(\d+)\r\n/.exec(s);
      expect(m).not.toBeNull();
      const header = m![0];
      const body = s.slice(header.length, s.length - 2);
      expect(s.endsWith('\r\n')).toBe(true);
      expect(body.startsWith('txt:')).toBe(true);
      expect(Buffer.byteLength(body, 'latin1')).toBe(Number(m![1]));
      return body.slice(4);
    };
    expect((await r2.send('INFO', 'server')).startsWith('$')).toBe(true);
    expect(checkVerbatim(await r3.send('INFO', 'server'))).toMatch(/^# Server\r\n/);
    expect((await r2.send('CLIENT', 'INFO')).startsWith('$')).toBe(true);
    expect(checkVerbatim(await r3.send('CLIENT', 'INFO'))).toMatch(/^id=\d+ addr=/);
    expect(checkVerbatim(await r3.send('CLIENT', 'LIST'))).toMatch(/^id=\d+ addr=/);
  });

  it('push frames for pub/sub in RESP3, arrays in RESP2', async () => {
    const s3 = await t.raw();
    await s3.send('HELLO', '3');
    expect(await s3.send('SUBSCRIBE', 'p:ch')).toBe('>3\r\n$9\r\nsubscribe\r\n$4\r\np:ch\r\n:1\r\n');
    const s2 = await t.raw();
    expect(await s2.send('SUBSCRIBE', 'p:ch')).toBe('*3\r\n$9\r\nsubscribe\r\n$4\r\np:ch\r\n:1\r\n');
    expect(await t.call('PUBLISH', 'p:ch', 'msg')).toBe(2);
    expect(await s3.read()).toBe('>3\r\n$7\r\nmessage\r\n$4\r\np:ch\r\n$3\r\nmsg\r\n');
    expect(await s2.read()).toBe('*3\r\n$7\r\nmessage\r\n$4\r\np:ch\r\n$3\r\nmsg\r\n');
    expect(await s3.send('UNSUBSCRIBE', 'p:ch')).toBe('>3\r\n$11\r\nunsubscribe\r\n$4\r\np:ch\r\n:0\r\n');
  });

  it('errors are the same in both protocols', async () => {
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    expect(await r3.send('GET')).toBe("-ERR wrong number of arguments for 'get' command\r\n");
  });
});

describe('wire level', () => {
  it('pipelining many commands in one write', async () => {
    await t.call('DEL', 'pipe:ctr');
    const n = 500;
    let payload = '';
    for (let i = 0; i < n; i++) payload += cmd('INCR', 'pipe:ctr');
    payload += cmd('GET', 'pipe:ctr');
    const expected = Array.from({ length: n }, (_, i) => `:${i + 1}\r\n`).join('') + `$3\r\n${n}\r\n`;
    const { data } = await rawExchange(payload, (s) => s.length >= expected.length);
    expect(data).toBe(expected);
  });

  it('pipelined commands split across arbitrary byte boundaries', async () => {
    const payload = Buffer.from(cmd('SET', 'pipe:split', 'v') + cmd('GET', 'pipe:split') + 'PING\r\n');
    const expected = '+OK\r\n$1\r\nv\r\n+PONG\r\n';
    const result = await new Promise<string>((resolve) => {
      let data = '';
      const s = connect(t.server.port, '127.0.0.1', async () => {
        for (let i = 0; i < payload.length; i += 3) {
          s.write(payload.subarray(i, i + 3));
          await new Promise((r) => setTimeout(r, 1));
        }
      });
      s.setEncoding('latin1');
      const timer = setTimeout(() => {
        s.destroy();
        resolve(data);
      }, 2000);
      s.on('data', (d: string) => {
        data += d;
        if (data.length >= expected.length) {
          clearTimeout(timer);
          s.destroy();
          resolve(data);
        }
      });
    });
    expect(result).toBe(expected);
  });

  it('1 MB bulk string round trip', async () => {
    const big = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    await t.redis.set('big:k', big);
    const back = (await t.redis.getBuffer('big:k')) as Buffer;
    expect(back.length).toBe(big.length);
    expect(Buffer.compare(back, big)).toBe(0);
    expect(await t.call('STRLEN', 'big:k')).toBe(1024 * 1024);
    const viaEval = (await t.redis.callBuffer('EVAL', 'return ARGV[1]', '0', big)) as Buffer;
    expect(Buffer.compare(viaEval, big)).toBe(0);
  });

  it('inline protocol', async () => {
    const { data } = await rawExchange('PING\r\nSET inline:k "hello world"\r\nGET inline:k\r\nECHO \'single quoted\'\r\n', (s) => s.endsWith('$13\r\nsingle quoted\r\n'));
    expect(data).toBe('+PONG\r\n+OK\r\n$11\r\nhello world\r\n$13\r\nsingle quoted\r\n');
  });

  it('inline protocol with LF only and hex escapes in double quotes', async () => {
    const { data } = await rawExchange('ECHO "a\\x41\\n"\n', (s) => s.length >= 9);
    expect(data).toBe('$3\r\naA\n\r\n');
  });

  it('inline protocol: unbalanced quotes', async () => {
    const { data, closed } = await rawExchange('SET k "unterminated\r\n', () => false, 1000);
    expect(data).toBe('-ERR Protocol error: unbalanced quotes in request\r\n');
    expect(closed).toBe(true);
  });

  it('empty inline line is ignored', async () => {
    const { data } = await rawExchange('\r\nPING\r\n', (s) => s.includes('PONG'));
    expect(data).toBe('+PONG\r\n');
  });

  it("malformed multibulk: expected '$'", async () => {
    const { data, closed } = await rawExchange('*1\r\nfoo\r\n', () => false, 1000);
    expect(data).toBe("-ERR Protocol error: expected '$', got 'f'\r\n");
    expect(closed).toBe(true);
  });

  it('malformed multibulk: invalid multibulk length', async () => {
    const { data, closed } = await rawExchange('*abc\r\n', () => false, 1000);
    expect(data).toBe('-ERR Protocol error: invalid multibulk length\r\n');
    expect(closed).toBe(true);
  });

  it('malformed multibulk: invalid bulk length', async () => {
    const { data, closed } = await rawExchange('*1\r\n$abc\r\n', () => false, 1000);
    expect(data).toBe('-ERR Protocol error: invalid bulk length\r\n');
    expect(closed).toBe(true);
  });

  it('valid command before a protocol error is still answered', async () => {
    const { data, closed } = await rawExchange(cmd('PING') + '*1\r\nxyz\r\n', () => false, 1000);
    expect(data).toBe("+PONG\r\n-ERR Protocol error: expected '$', got 'x'\r\n");
    expect(closed).toBe(true);
  });

  it('*0 and *-1 multibulk are ignored', async () => {
    const { data } = await rawExchange('*0\r\n*-1\r\n' + cmd('PING'), (s) => s.includes('PONG'));
    expect(data).toBe('+PONG\r\n');
  });
});
