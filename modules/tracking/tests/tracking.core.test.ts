import { beforeEach, describe, expect, it } from 'vitest';

import type { RawClient } from '@/tests/helpers';
import { sleep, useServer } from '@/tests/helpers';

/**
 * Server-assisted client-side caching, as documented on redis.io ("Client-side caching reference") and on the CLIENT
 * TRACKING / CACHING / GETREDIR / TRACKINGINFO command pages.
 */
const t = useServer();

/** RESP3 `invalidate` push for these keys (null = flush). */
const inv3 = (...keys: string[]): string =>
  `>2\r\n$10\r\ninvalidate\r\n*${keys.length}\r\n${keys.map((k) => `$${k.length}\r\n${k}\r\n`).join('')}`;
const INV3_NULL = '>2\r\n$10\r\ninvalidate\r\n_\r\n';
/** RESP2 Pub/Sub message on __redis__:invalidate. */
const inv2 = (...keys: string[]): string =>
  `*3\r\n$7\r\nmessage\r\n$20\r\n__redis__:invalidate\r\n*${keys.length}\r\n${keys.map((k) => `$${k.length}\r\n${k}\r\n`).join('')}`;

async function resp3(): Promise<RawClient> {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

async function idOf(r: RawClient): Promise<number> {
  return Number(/:(\d+)/.exec(await r.send('CLIENT', 'ID'))?.[1]);
}

/** Pushes received without sending anything. */
async function received(r: RawClient, wait = 60): Promise<string> {
  await sleep(wait);
  return r.read(1, 1);
}

beforeEach(async () => {
  await t.call('FLUSHALL');
  await t.call('CONFIG', 'SET', 'tracking-table-max-keys', '1000000');
  await sleep(20);
});

describe('default mode', () => {
  it('invalidates a key the client read once it is modified, then forgets it', async () => {
    const r = await resp3();
    await t.call('SET', 'k', 'v');
    expect(await r.send('CLIENT', 'TRACKING', 'ON')).toBe('+OK\r\n');
    expect(await r.send('GET', 'k')).toBe('$1\r\nv\r\n');
    await t.call('SET', 'k', 'w');
    expect(await received(r)).toBe(inv3('k'));
    // the key left the table: no message until it is read again
    await t.call('SET', 'k', 'x');
    expect(await received(r)).toBe('');
    await r.send('GET', 'k');
    await t.call('DEL', 'k');
    expect(await received(r)).toBe(inv3('k'));
  });

  it('keys the client did not read are not invalidated; writes alone do not track', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON');
    await r.send('SET', 'mine', '1');
    await t.call('SET', 'other', '1');
    await t.call('SET', 'mine', '2');
    expect(await received(r)).toBe('');
  });

  it('reads of every key of a multi-key read command are tracked', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON');
    await r.send('MGET', 'a', 'b');
    await t.call('MSET', 'a', '1', 'b', '2');
    expect(await received(r)).toBe(inv3('a') + inv3('b'));
  });

  it("an invalidation caused by the client's own write arrives after the write's reply", async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON');
    await r.send('GET', 'self');
    expect(await r.send('SET', 'self', 'v')).toBe(`+OK\r\n${inv3('self')}`);
  });

  it('NOLOOP: no invalidation for keys the client modified itself', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON', 'NOLOOP');
    await r.send('GET', 'n');
    expect(await r.send('SET', 'n', 'v')).toBe('+OK\r\n');
    await r.send('GET', 'n');
    await t.call('SET', 'n', 'w');
    expect(await received(r)).toBe(inv3('n'));
  });

  it('expired and deleted keys are invalidated; the key space is not per database', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON');
    await t.call('SET', 'ttl', 'v', 'PX', '150');
    expect(await r.send('GET', 'ttl')).toBe('$1\r\nv\r\n');
    await sleep(250);
    await t.call('GET', 'ttl');
    expect(await received(r)).toBe(inv3('ttl'));
    await r.send('GET', 'samename');
    const other = t.client();
    await other.select(5);
    await other.set('samename', 'v');
    expect(await received(r)).toBe(inv3('samename'));
    other.disconnect();
  });

  it('FLUSHALL / FLUSHDB send a null invalidation to every tracking client', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON');
    await r.send('GET', 'x');
    await t.call('FLUSHALL');
    expect(await received(r)).toBe(INV3_NULL);
    await t.call('FLUSHDB');
    expect(await received(r)).toBe(INV3_NULL);
    // the table was emptied
    await t.call('SET', 'x', 'v');
    expect(await received(r)).toBe('');
  });

  it('a whole MULTI/EXEC: invalidations of its own writes come after the EXEC reply', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON');
    await r.send('GET', 'tx');
    await r.send('MULTI');
    await r.send('SET', 'tx', '1');
    expect(await r.send('EXEC')).toBe(`*1\r\n+OK\r\n${inv3('tx')}`);
  });

  it('tracking-table-max-keys: keys beyond the limit are evicted from the table and invalidated', async () => {
    const r = await resp3();
    await t.call('CONFIG', 'SET', 'tracking-table-max-keys', '2');
    await r.send('CLIENT', 'TRACKING', 'ON');
    await r.send('GET', 'a');
    await r.send('GET', 'b');
    expect(await r.send('GET', 'c')).toMatch(/^_\r\n>2\r\n\$10\r\ninvalidate\r\n\*1\r\n\$1\r\n[abc]\r\n$/);
    expect(String(await t.call('INFO', 'stats'))).toMatch(/tracking_total_keys:2\r\n/);
  });

  it('TRACKING OFF stops invalidations', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON');
    await r.send('GET', 'off');
    await r.send('CLIENT', 'TRACKING', 'OFF');
    await t.call('SET', 'off', 'v');
    expect(await received(r)).toBe('');
  });
});

describe('OPTIN / OPTOUT and CLIENT CACHING', () => {
  it('OPTIN: only reads right after CLIENT CACHING YES are tracked', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON', 'OPTIN');
    await r.send('GET', 'untracked');
    expect(await r.send('CLIENT', 'CACHING', 'YES')).toBe('+OK\r\n');
    await r.send('GET', 'tracked');
    await r.send('GET', 'untracked2');
    await t.call('MSET', 'untracked', '1', 'tracked', '1', 'untracked2', '1');
    expect(await received(r)).toBe(inv3('tracked'));
  });

  it('OPTOUT: everything is tracked except reads right after CLIENT CACHING NO', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON', 'OPTOUT');
    await r.send('CLIENT', 'CACHING', 'NO');
    await r.send('GET', 'skipped');
    await r.send('GET', 'kept');
    await t.call('MSET', 'skipped', '1', 'kept', '1');
    expect(await received(r)).toBe(inv3('kept'));
  });

  it('CLIENT CACHING errors', async () => {
    const r = await resp3();
    expect(await r.send('CLIENT', 'CACHING', 'YES')).toBe(
      '-ERR CLIENT CACHING can be called only when the client is in tracking mode with OPTIN or OPTOUT mode enabled\r\n',
    );
    await r.send('CLIENT', 'TRACKING', 'ON');
    expect(await r.send('CLIENT', 'CACHING', 'YES')).toBe(
      '-ERR CLIENT CACHING can be called only when the client is in tracking mode with OPTIN or OPTOUT mode enabled\r\n',
    );
    await r.send('CLIENT', 'TRACKING', 'OFF');
    await r.send('CLIENT', 'TRACKING', 'ON', 'OPTOUT');
    expect(await r.send('CLIENT', 'CACHING', 'YES')).toBe('-ERR CLIENT CACHING YES is only valid when tracking is enabled in OPTIN mode.\r\n');
    expect(await r.send('CLIENT', 'CACHING', 'maybe')).toBe('-ERR syntax error\r\n');
    await r.send('CLIENT', 'TRACKING', 'OFF');
    await r.send('CLIENT', 'TRACKING', 'ON', 'OPTIN');
    expect(await r.send('CLIENT', 'CACHING', 'NO')).toBe('-ERR CLIENT CACHING NO is only valid when tracking is enabled in OPTOUT mode.\r\n');
  });
});

describe('BCAST', () => {
  it('announces every modified key matching a prefix, batched per prefix', async () => {
    const r = await resp3();
    expect(await r.send('CLIENT', 'TRACKING', 'ON', 'BCAST', 'PREFIX', 'user:', 'PREFIX', 'obj:')).toBe('+OK\r\n');
    await t.call('MSET', 'user:1', 'a', 'user:2', 'b', 'other', 'c');
    expect(await received(r)).toBe(inv3('user:1', 'user:2'));
    await t.call('SET', 'obj:9', 'x');
    expect(await received(r)).toBe(inv3('obj:9'));
  });

  it('without PREFIX every key is announced, read or not', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON', 'BCAST');
    await t.call('SET', 'anything', '1');
    expect(await received(r)).toBe(inv3('anything'));
  });

  it('BCAST with NOLOOP skips keys the client modified itself', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON', 'BCAST', 'NOLOOP');
    await r.send('SET', 'mine', '1');
    expect(await received(r)).toBe('');
    await t.call('SET', 'theirs', '1');
    expect(await received(r)).toBe(inv3('theirs'));
  });

  it('prefix errors', async () => {
    const r = await resp3();
    expect(await r.send('CLIENT', 'TRACKING', 'ON', 'PREFIX', 'a')).toBe('-ERR PREFIX option requires BCAST mode to be enabled\r\n');
    expect(await r.send('CLIENT', 'TRACKING', 'ON', 'BCAST', 'PREFIX', 'ab', 'PREFIX', 'abc')).toBe(
      "-ERR Prefix 'abc' overlaps with an existing prefix 'ab'. Prefixes for a single client must not overlap.\r\n",
    );
    await r.send('CLIENT', 'TRACKING', 'ON', 'BCAST', 'PREFIX', 'foo');
    expect(await r.send('CLIENT', 'TRACKING', 'ON', 'BCAST', 'PREFIX', 'fo')).toBe(
      "-ERR Prefix 'fo' overlaps with an existing prefix 'foo'. Prefixes for a single client must not overlap.\r\n",
    );
    expect(await r.send('CLIENT', 'TRACKING', 'ON')).toBe(
      "-ERR You can't switch BCAST mode on/off before disabling tracking for this client, and then re-enabling it with a different mode.\r\n",
    );
    expect(await r.send('CLIENT', 'TRACKING', 'ON', 'BCAST', 'OPTIN')).toBe('-ERR OPTIN and OPTOUT are not compatible with BCAST\r\n');
  });
});

describe('REDIRECT', () => {
  it('RESP2: invalidations go to the redirect client subscribed to __redis__:invalidate', async () => {
    const sink = await t.raw();
    const sinkId = await idOf(sink);
    expect(await sink.send('SUBSCRIBE', '__redis__:invalidate')).toBe('*3\r\n$9\r\nsubscribe\r\n$20\r\n__redis__:invalidate\r\n:1\r\n');
    const r = await t.raw();
    expect(await r.send('CLIENT', 'TRACKING', 'ON', 'REDIRECT', sinkId)).toBe('+OK\r\n');
    expect(await r.send('CLIENT', 'GETREDIR')).toBe(`:${sinkId}\r\n`);
    await r.send('GET', 'rk');
    await t.call('SET', 'rk', 'v');
    expect(await received(sink)).toBe(inv2('rk'));
    await r.send('GET', 'rk');
    await t.call('FLUSHALL');
    expect(await received(sink)).toBe('*3\r\n$7\r\nmessage\r\n$20\r\n__redis__:invalidate\r\n*-1\r\n');
  });

  it('a RESP3 tracking client is told when its redirect client is gone', async () => {
    const sink = await t.raw();
    const sinkId = await idOf(sink);
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON', 'REDIRECT', sinkId);
    await r.send('GET', 'gone');
    sink.close();
    await sleep(30);
    await t.call('SET', 'gone', 'v');
    expect(await received(r)).toBe(`>2\r\n$21\r\ntracking-redir-broken\r\n:${sinkId}\r\n`);
    expect(await r.send('CLIENT', 'TRACKINGINFO')).toContain('broken_redirect');
  });

  it('REDIRECT to a client that does not exist', async () => {
    const r = await resp3();
    expect(await r.send('CLIENT', 'TRACKING', 'ON', 'REDIRECT', '987654')).toBe('-ERR The client ID you want redirect to does not exist\r\n');
  });
});

describe('introspection', () => {
  it('CLIENT GETREDIR: -1 without tracking, 0 when not redirecting', async () => {
    const r = await resp3();
    expect(await r.send('CLIENT', 'GETREDIR')).toBe(':-1\r\n');
    await r.send('CLIENT', 'TRACKING', 'ON');
    expect(await r.send('CLIENT', 'GETREDIR')).toBe(':0\r\n');
  });

  it('CLIENT TRACKINGINFO reports flags, redirect and prefixes', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON', 'BCAST', 'PREFIX', 'p:', 'NOLOOP');
    expect(await r.send('CLIENT', 'TRACKINGINFO')).toBe(
      '%3\r\n$5\r\nflags\r\n~3\r\n$2\r\non\r\n$5\r\nbcast\r\n$6\r\nnoloop\r\n$8\r\nredirect\r\n:0\r\n$8\r\nprefixes\r\n*1\r\n$2\r\np:\r\n',
    );
    await r.send('CLIENT', 'TRACKING', 'OFF');
    await r.send('CLIENT', 'TRACKING', 'ON', 'OPTIN');
    await r.send('CLIENT', 'CACHING', 'YES');
    expect(await r.send('CLIENT', 'TRACKINGINFO')).toBe(
      '%3\r\n$5\r\nflags\r\n~3\r\n$2\r\non\r\n$5\r\noptin\r\n$11\r\ncaching-yes\r\n$8\r\nredirect\r\n:0\r\n$8\r\nprefixes\r\n*0\r\n',
    );
  });

  it('INFO: tracking_clients, tracking_total_keys / items / prefixes; CLIENT LIST flag t', async () => {
    const field = (info: string, name: string): number => Number(new RegExp(`${name}:(\\d+)`).exec(info)?.[1]);
    const before = String(await t.call('INFO'));
    const a = await resp3();
    const b = await resp3();
    await a.send('CLIENT', 'TRACKING', 'ON');
    await b.send('CLIENT', 'TRACKING', 'ON');
    await a.send('GET', 'shared');
    await b.send('GET', 'shared');
    await b.send('GET', 'own');
    const c = await resp3();
    await c.send('CLIENT', 'TRACKING', 'ON', 'BCAST', 'PREFIX', 'x-unique', 'PREFIX', 'y-unique');
    const info = String(await t.call('INFO'));
    expect(field(info, 'tracking_clients') - field(before, 'tracking_clients')).toBe(3);
    expect(field(info, 'tracking_total_keys')).toBe(2);
    expect(field(info, 'tracking_total_items')).toBe(3);
    expect(field(info, 'tracking_total_prefixes') - field(before, 'tracking_total_prefixes')).toBe(2);
    expect(await c.send('CLIENT', 'INFO')).toMatch(/flags=tB /);
  });

  it('RESET turns tracking off', async () => {
    const r = await resp3();
    await r.send('CLIENT', 'TRACKING', 'ON');
    await r.send('RESET');
    expect(await r.send('CLIENT', 'GETREDIR')).toBe(':-1\r\n');
  });

  it('option errors', async () => {
    const r = await resp3();
    expect(await r.send('CLIENT', 'TRACKING', 'ON', 'OPTIN', 'OPTOUT')).toBe("-ERR You can't use both OPTIN and OPTOUT\r\n");
    expect(await r.send('CLIENT', 'TRACKING', 'maybe')).toBe('-ERR syntax error\r\n');
    expect(await r.send('CLIENT', 'TRACKING', 'ON', 'BOGUS')).toBe('-ERR syntax error\r\n');
  });
});
