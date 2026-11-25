import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * Pub/Sub, checked against the behaviour of Redis Open Source 8.8
 * (redis.io command docs, t_stream.c / pubsub.c reply and error strings).
 */
const t = useServer();

/** Resolves to the error message of a rejected call, or 'NO ERROR'. */
async function err(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'NO ERROR';
}

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

// RESP builders (latin1 lengths, matching RawClient).
const bulk = (s: string) => `$${Buffer.byteLength(s, 'latin1')}\r\n${s}\r\n`;

const int = (n: number) => `:${n}\r\n`;

const arr = (...items: string[]) => `*${items.length}\r\n${items.join('')}`;

const push = (...items: string[]) => `>${items.length}\r\n${items.join('')}`;

async function resp3(): Promise<RawClient> {
  const c = await t.raw();
  await c.send('HELLO', '3');
  return c;
}

// ---------------------------------------------------------------------------
// Pub/Sub
// ---------------------------------------------------------------------------
describe('SUBSCRIBE / UNSUBSCRIBE (RESP2)', () => {
  it('subscribe frames carry running counts', async () => {
    const c = await t.raw();
    expect(await c.send('SUBSCRIBE', 'ps:a', 'ps:b')).toBe(
      arr(bulk('subscribe'), bulk('ps:a'), int(1)) + arr(bulk('subscribe'), bulk('ps:b'), int(2)),
    );
    // re-subscribing does not increase the count
    expect(await c.send('SUBSCRIBE', 'ps:a')).toBe(arr(bulk('subscribe'), bulk('ps:a'), int(2)));
    expect(await c.send('PSUBSCRIBE', 'ps:p*')).toBe(arr(bulk('psubscribe'), bulk('ps:p*'), int(3)));
    expect(await c.send('UNSUBSCRIBE', 'ps:a')).toBe(arr(bulk('unsubscribe'), bulk('ps:a'), int(2)));
    // unsubscribing a channel we are not subscribed to still replies
    expect(await c.send('UNSUBSCRIBE', 'ps:zzz')).toBe(arr(bulk('unsubscribe'), bulk('ps:zzz'), int(2)));
    expect(await c.send('PUNSUBSCRIBE', 'ps:p*')).toBe(arr(bulk('punsubscribe'), bulk('ps:p*'), int(1)));
    expect(await c.send('UNSUBSCRIBE', 'ps:b')).toBe(arr(bulk('unsubscribe'), bulk('ps:b'), int(0)));
    // back to normal mode
    expect(await c.send('PING')).toBe('+PONG\r\n');
  });

  it('UNSUBSCRIBE with no arguments unsubscribes from all', async () => {
    const c = await t.raw();
    await c.send('SUBSCRIBE', 'ps:u1', 'ps:u2', 'ps:u3');
    const out = await c.send('UNSUBSCRIBE');
    const frames = out.split('*3\r\n').filter(Boolean);
    expect(frames).toHaveLength(3);
    const chans = frames.map((f) => f.split('\r\n')[3]).sort();
    expect(chans).toEqual(['ps:u1', 'ps:u2', 'ps:u3']);
    const counts = frames.map((f) => f.split('\r\n')[4]);
    expect(counts).toEqual([':2', ':1', ':0']);
  });

  it('UNSUBSCRIBE / PUNSUBSCRIBE with no subscriptions reply with a nil channel', async () => {
    const c = await t.raw();
    expect(await c.send('UNSUBSCRIBE')).toBe(`*3\r\n${bulk('unsubscribe')}$-1\r\n:0\r\n`);
    expect(await c.send('PUNSUBSCRIBE')).toBe(`*3\r\n${bulk('punsubscribe')}$-1\r\n:0\r\n`);
    expect(await c.send('SUNSUBSCRIBE')).toBe(`*3\r\n${bulk('sunsubscribe')}$-1\r\n:0\r\n`);
    const c3 = await resp3();
    expect(await c3.send('UNSUBSCRIBE')).toBe(`>3\r\n${bulk('unsubscribe')}_\r\n:0\r\n`);
  });

  it('PUNSUBSCRIBE with no arguments removes all patterns', async () => {
    const c = await t.raw();
    await c.send('PSUBSCRIBE', 'ps:q1*', 'ps:q2*');
    const out = await c.send('PUNSUBSCRIBE');
    expect(out.split('*3\r\n').filter(Boolean)).toHaveLength(2);
    expect(out.endsWith(':0\r\n')).toBe(true);
    expect(await t.call('PUBLISH', 'ps:q1x', 'm')).toBe(0);
  });

  it('subscriber-mode restrictions and PING in RESP2', async () => {
    const c = await t.raw();
    await c.send('SUBSCRIBE', 'ps:r');
    expect(await c.send('GET', 'x')).toBe(
      "-ERR Can't execute 'get': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context\r\n",
    );
    expect(await c.send('SET', 'x', '1')).toBe(
      "-ERR Can't execute 'set': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context\r\n",
    );
    expect(await c.send('PING')).toBe(arr(bulk('pong'), bulk('')));
    expect(await c.send('PING', 'hello')).toBe(arr(bulk('pong'), bulk('hello')));
    expect(await t.call('EXISTS', 'x')).toBe(0);
    expect(await c.send('RESET')).toBe('+RESET\r\n');
    expect(await c.send('PING')).toBe('+PONG\r\n');
    expect(await t.call('PUBLISH', 'ps:r', 'm')).toBe(0);
  });

  it('arity errors', async () => {
    expect.soft(await err(t.call('SUBSCRIBE'))).toBe(arity('subscribe'));
    expect.soft(await err(t.call('PSUBSCRIBE'))).toBe(arity('psubscribe'));
    expect.soft(await err(t.call('SSUBSCRIBE'))).toBe(arity('ssubscribe'));
    expect.soft(await err(t.call('PUBLISH', 'ch'))).toBe(arity('publish'));
    expect.soft(await err(t.call('PUBLISH', 'ch', 'a', 'b'))).toBe(arity('publish'));
    expect.soft(await err(t.call('SPUBLISH', 'ch'))).toBe(arity('spublish'));
  });
});

describe('PUBLISH and message delivery', () => {
  it('message frames and receiver counts including patterns', async () => {
    const s1 = await t.raw();
    const s2 = await t.raw();
    await s1.send('SUBSCRIBE', 'pm:news');
    await s2.send('PSUBSCRIBE', 'pm:n*');
    expect(await t.call('PUBLISH', 'pm:news', 'hello')).toBe(2);
    expect(await s1.read()).toBe(arr(bulk('message'), bulk('pm:news'), bulk('hello')));
    expect(await s2.read()).toBe(arr(bulk('pmessage'), bulk('pm:n*'), bulk('pm:news'), bulk('hello')));
    expect(await t.call('PUBLISH', 'pm:nothing', 'x')).toBe(1);
    expect(await s2.read()).toBe(arr(bulk('pmessage'), bulk('pm:n*'), bulk('pm:nothing'), bulk('x')));
    expect(await t.call('PUBLISH', 'pm:other', 'x')).toBe(0);
  });

  it('a client matching a channel and a pattern receives twice and counts twice', async () => {
    const s = await t.raw();
    await s.send('SUBSCRIBE', 'pm:dup');
    await s.send('PSUBSCRIBE', 'pm:d*', 'pm:du?');
    expect(await t.call('PUBLISH', 'pm:dup', 'm')).toBe(3);
    const out = await s.read();
    expect(out).toContain(arr(bulk('message'), bulk('pm:dup'), bulk('m')));
    expect(out).toContain(arr(bulk('pmessage'), bulk('pm:d*'), bulk('pm:dup'), bulk('m')));
    expect(out).toContain(arr(bulk('pmessage'), bulk('pm:du?'), bulk('pm:dup'), bulk('m')));
    // the plain channel message is delivered before the pattern messages
    expect(out.startsWith(arr(bulk('message'), bulk('pm:dup'), bulk('m')))).toBe(true);
  });

  it('pattern globs', async () => {
    const s = await t.raw();
    await s.send('PSUBSCRIBE', 'g:h?llo', 'g:h*llo', 'g:h[ae]llo', 'g:h[^e]llo', 'g:x\\*');
    expect(await t.call('PUBLISH', 'g:hello', 'm')).toBe(3); // ?, *, [ae]
    expect(await t.call('PUBLISH', 'g:hallo', 'm')).toBe(4); // ?, *, [ae], [^e]
    expect(await t.call('PUBLISH', 'g:hllo', 'm')).toBe(1); // *
    expect(await t.call('PUBLISH', 'g:heeeello', 'm')).toBe(1); // *
    expect(await t.call('PUBLISH', 'g:hxllo', 'm')).toBe(3); // ?, *, [^e]
    expect(await t.call('PUBLISH', 'g:x*', 'm')).toBe(1);
    expect(await t.call('PUBLISH', 'g:xy', 'm')).toBe(0);
  });

  it('messages arrive in publish order', async () => {
    const sub = t.client();
    const got: string[] = [];
    await sub.subscribe('pm:order');
    sub.on('message', (_ch: string, m: string) => got.push(m));
    const p = t.redis.pipeline();
    for (let i = 0; i < 200; i++) p.publish('pm:order', String(i));
    await p.exec();
    for (let i = 0; i < 50 && got.length < 200; i++) await sleep(10);
    expect(got).toEqual(Array.from({ length: 200 }, (_, i) => String(i)));
  });

  it('binary channels and messages', async () => {
    const s = await t.raw();
    const ch = 'bin\x00\xff\r\nch';
    const msg = 'a\r\n\x00\x80\xffb';
    await s.send('SUBSCRIBE', ch);
    expect(await t.call('PUBLISH', Buffer.from(ch, 'latin1'), Buffer.from(msg, 'latin1'))).toBe(1);
    expect(await s.read()).toBe(arr(bulk('message'), bulk(ch), bulk(msg)));
  });

  it('empty message', async () => {
    const s = await t.raw();
    await s.send('SUBSCRIBE', 'pm:empty');
    expect(await t.call('PUBLISH', 'pm:empty', '')).toBe(1);
    expect(await s.read()).toBe(arr(bulk('message'), bulk('pm:empty'), bulk('')));
  });

  it('a closed subscriber is no longer counted', async () => {
    const s = await t.raw();
    await s.send('SUBSCRIBE', 'pm:gone');
    expect(await t.call('PUBLISH', 'pm:gone', 'x')).toBe(1);
    s.close();
    await sleep(50);
    expect(await t.call('PUBLISH', 'pm:gone', 'x')).toBe(0);
  });
});

describe('RESP3 pub/sub', () => {
  it('push frames for subscribe, message, pmessage, unsubscribe', async () => {
    const c = await resp3();
    expect(await c.send('SUBSCRIBE', 'r3:a')).toBe(push(bulk('subscribe'), bulk('r3:a'), int(1)));
    expect(await c.send('PSUBSCRIBE', 'r3:*')).toBe(push(bulk('psubscribe'), bulk('r3:*'), int(2)));
    expect(await t.call('PUBLISH', 'r3:a', 'hi')).toBe(2);
    expect(await c.read()).toBe(
      push(bulk('message'), bulk('r3:a'), bulk('hi')) + push(bulk('pmessage'), bulk('r3:*'), bulk('r3:a'), bulk('hi')),
    );
    expect(await c.send('UNSUBSCRIBE', 'r3:a')).toBe(push(bulk('unsubscribe'), bulk('r3:a'), int(1)));
    expect(await c.send('PUNSUBSCRIBE', 'r3:*')).toBe(push(bulk('punsubscribe'), bulk('r3:*'), int(0)));
  });

  it('normal commands work while subscribed, PING is a plain PONG', async () => {
    const c = await resp3();
    await c.send('SUBSCRIBE', 'r3:n');
    expect(await c.send('SET', 'r3:key', 'v')).toBe('+OK\r\n');
    expect(await c.send('GET', 'r3:key')).toBe(bulk('v'));
    expect(await c.send('PING')).toBe('+PONG\r\n');
    expect(await c.send('PING', 'x')).toBe(bulk('x'));
  });

  it('SSUBSCRIBE / smessage push frames', async () => {
    const c = await resp3();
    expect(await c.send('SSUBSCRIBE', 'r3:s')).toBe(push(bulk('ssubscribe'), bulk('r3:s'), int(1)));
    expect(await t.call('SPUBLISH', 'r3:s', 'm')).toBe(1);
    expect(await c.read()).toBe(push(bulk('smessage'), bulk('r3:s'), bulk('m')));
    expect(await c.send('SUNSUBSCRIBE', 'r3:s')).toBe(push(bulk('sunsubscribe'), bulk('r3:s'), int(0)));
  });
});

describe('sharded pub/sub', () => {
  it('SSUBSCRIBE / SPUBLISH / SUNSUBSCRIBE (RESP2)', async () => {
    const s = await t.raw();
    expect(await s.send('SSUBSCRIBE', 'sh:a', 'sh:b')).toBe(
      arr(bulk('ssubscribe'), bulk('sh:a'), int(1)) + arr(bulk('ssubscribe'), bulk('sh:b'), int(2)),
    );
    expect(await t.call('SPUBLISH', 'sh:a', 'm1')).toBe(1);
    expect(await s.read()).toBe(arr(bulk('smessage'), bulk('sh:a'), bulk('m1')));
    // PUBLISH and SPUBLISH are separate namespaces
    expect(await t.call('PUBLISH', 'sh:a', 'x')).toBe(0);
    expect(await t.call('SPUBLISH', 'sh:none', 'x')).toBe(0);
    // shard subscriptions are counted separately from channels/patterns
    expect(await s.send('SUBSCRIBE', 'sh:plain')).toBe(arr(bulk('subscribe'), bulk('sh:plain'), int(1)));
    expect(await s.send('GET', 'k')).toBe(
      "-ERR Can't execute 'get': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context\r\n",
    );
    expect(await s.send('SUNSUBSCRIBE', 'sh:a')).toBe(arr(bulk('sunsubscribe'), bulk('sh:a'), int(1)));
    const out = await s.send('SUNSUBSCRIBE');
    expect(out).toBe(arr(bulk('sunsubscribe'), bulk('sh:b'), int(0)));
    expect(await s.send('UNSUBSCRIBE')).toBe(arr(bulk('unsubscribe'), bulk('sh:plain'), int(0)));
    expect(await s.send('PING')).toBe('+PONG\r\n');
  });

  it('SPUBLISH does not reach pattern subscribers', async () => {
    const s = await t.raw();
    await s.send('PSUBSCRIBE', 'shp:*');
    expect(await t.call('SPUBLISH', 'shp:x', 'm')).toBe(0);
  });
});

describe('PUBSUB introspection', () => {
  it('CHANNELS, NUMSUB, NUMPAT', async () => {
    const a = await t.raw();
    const b = await t.raw();
    await a.send('SUBSCRIBE', 'in:one', 'in:two');
    await b.send('SUBSCRIBE', 'in:one');
    await a.send('PSUBSCRIBE', 'in:p1*', 'in:p2*');
    await b.send('PSUBSCRIBE', 'in:p1*');
    const chans = ((await t.call('PUBSUB', 'CHANNELS', 'in:*')) as string[]).sort();
    expect(chans).toEqual(['in:one', 'in:two']);
    expect(await t.call('PUBSUB', 'CHANNELS', 'in:o*')).toEqual(['in:one']);
    expect((await t.call('PUBSUB', 'CHANNELS')) as string[]).toEqual(expect.arrayContaining(['in:one', 'in:two']));
    expect(await t.call('PUBSUB', 'NUMSUB', 'in:one', 'in:two', 'in:zero')).toEqual(['in:one', 2, 'in:two', 1, 'in:zero', 0]);
    expect(await t.call('PUBSUB', 'NUMSUB')).toEqual([]);
    const numpat = (await t.call('PUBSUB', 'NUMPAT')) as number;
    expect(numpat).toBeGreaterThanOrEqual(2);
    await a.send('PUNSUBSCRIBE', 'in:p2*');
    expect(await t.call('PUBSUB', 'NUMPAT')).toBe(numpat - 1);
    // patterns are not channels
    expect(await t.call('PUBSUB', 'CHANNELS', 'in:p*')).toEqual([]);
    a.close();
    b.close();
    await sleep(50);
    expect(await t.call('PUBSUB', 'CHANNELS', 'in:*')).toEqual([]);
    expect(await t.call('PUBSUB', 'NUMSUB', 'in:one')).toEqual(['in:one', 0]);
  });

  it('SHARDCHANNELS and SHARDNUMSUB', async () => {
    const a = await t.raw();
    const b = await t.raw();
    await a.send('SSUBSCRIBE', 'sin:x', 'sin:y');
    await b.send('SSUBSCRIBE', 'sin:x');
    expect(((await t.call('PUBSUB', 'SHARDCHANNELS', 'sin:*')) as string[]).sort()).toEqual(['sin:x', 'sin:y']);
    expect(await t.call('PUBSUB', 'SHARDCHANNELS', 'sin:y')).toEqual(['sin:y']);
    expect(await t.call('PUBSUB', 'SHARDNUMSUB', 'sin:x', 'sin:y', 'sin:z')).toEqual(['sin:x', 2, 'sin:y', 1, 'sin:z', 0]);
    // shard channels are not regular channels
    expect(await t.call('PUBSUB', 'CHANNELS', 'sin:*')).toEqual([]);
    expect(await t.call('PUBSUB', 'NUMSUB', 'sin:x')).toEqual(['sin:x', 0]);
  });

  it('errors', async () => {
    expect.soft(await err(t.call('PUBSUB', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try PUBSUB HELP.");
    expect.soft(await err(t.call('PUBSUB', 'NUMPAT', 'x'))).toBe(arity('pubsub|numpat'));
    expect.soft(await err(t.call('PUBSUB'))).toBe(arity('pubsub'));
  });
});
