import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisLite } from '@/index';
import { RawClient } from '@/tests/helpers';

let server: RedisLite;

beforeAll(async () => {
  server = await RedisLite.start({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

describe('RESP3', () => {
  it('HELLO 3 switches the protocol and typed replies follow', async () => {
    const c = await RawClient.open(server.port);
    const hello = await c.send('HELLO', '3');
    expect(hello.startsWith('%7\r\n$6\r\nserver\r\n$5\r\nredis\r\n')).toBe(true);
    expect(hello).toContain('$5\r\nproto\r\n:3\r\n');
    await c.send('HSET', 'h', 'a', '1');
    expect(await c.send('HGETALL', 'h')).toBe('%1\r\n$1\r\na\r\n$1\r\n1\r\n');
    await c.send('ZADD', 'z', '1.5', 'm');
    expect(await c.send('ZSCORE', 'z', 'm')).toBe(',1.5\r\n');
    expect(await c.send('ZRANGE', 'z', '0', '-1', 'WITHSCORES')).toBe('*1\r\n*2\r\n$1\r\nm\r\n,1.5\r\n');
    await c.send('SADD', 's', 'x');
    expect(await c.send('SMEMBERS', 's')).toBe('~1\r\n$1\r\nx\r\n');
    expect(await c.send('GET', 'missing')).toBe('_\r\n');
    expect((await c.send('INFO', 'server')).startsWith('=')).toBe(true);
    c.close();
  });

  it('RESP2 keeps the flat shapes', async () => {
    const c = await RawClient.open(server.port);
    expect(await c.send('HGETALL', 'h')).toBe('*2\r\n$1\r\na\r\n$1\r\n1\r\n');
    expect(await c.send('ZSCORE', 'z', 'm')).toBe('$3\r\n1.5\r\n');
    expect(await c.send('ZRANGE', 'z', '0', '-1', 'WITHSCORES')).toBe('*2\r\n$1\r\nm\r\n$3\r\n1.5\r\n');
    expect(await c.send('GET', 'missing')).toBe('$-1\r\n');
    c.close();
  });

  it('pub/sub messages are push frames, and RESP3 subscribers can run normal commands', async () => {
    const sub = await RawClient.open(server.port);
    await sub.send('HELLO', '3');
    expect(await sub.send('SUBSCRIBE', 'ch')).toBe('>3\r\n$9\r\nsubscribe\r\n$2\r\nch\r\n:1\r\n');
    expect(await sub.send('GET', 'missing')).toBe('_\r\n');
    const pub = await RawClient.open(server.port);
    expect(await pub.send('PUBLISH', 'ch', 'hi')).toBe(':1\r\n');
    // after the GET reply (already read above) comes the push frame
    expect(await sub.read()).toBe('>3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$2\r\nhi\r\n');
    sub.close();
    pub.close();
  });
});
