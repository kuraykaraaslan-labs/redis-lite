/**
 * The propagated command stream (replication.primary, replication.replica): what a master feeds its replicas and how a
 * replica applies it. MULTI / EXEC and scripts arrive as their effects, inside MULTI … EXEC; SELECT follows the
 * database; expired and evicted keys arrive as DEL; a replica never expires keys itself; PUBLISH reaches the replica's
 * subscribers; a replica of a replica gets the same stream.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { connect } from 'node:net';

import { describe, expect, it } from 'vitest';

import { sleep, waitFor } from '@/tests/helpers';

import { startNode, startReplica, waitSynced } from './replication.test_helpers';

// ============================================================================
// Helpers
// ============================================================================

/** Attaches a raw fake replica and returns a function giving the stream bytes received after the RDB. */
async function tapStream(port: number): Promise<{ stream: () => string; close: () => void }> {
  const socket = connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  let buf = '';
  socket.setEncoding('latin1');
  socket.on('data', (d: string) => (buf += d));
  socket.write('*3\r\n$5\r\nPSYNC\r\n$1\r\n?\r\n$2\r\n-1\r\n');
  // disk-style payload: +FULLRESYNC …\r\n$<len>\r\n<rdb>
  await waitFor(() => {
    const m = /\$(\d+)\r\n/.exec(buf);
    return m !== null && buf.length >= buf.indexOf(m[0]) + m[0].length + Number(m[1]);
  });
  const m = /\$(\d+)\r\n/.exec(buf) as RegExpExecArray;
  const start = buf.indexOf(m[0]) + m[0].length + Number(m[1]);
  return { stream: () => buf.slice(start), close: () => socket.destroy() };
}

/** A RESP array of bulk strings, as the stream carries commands. */
function resp(...argv: string[]): string {
  return `*${argv.length}\r\n${argv.map((a) => `$${a.length}\r\n${a}\r\n`).join('')}`;
}

// ============================================================================
// Stream shape
// ============================================================================

describe('the propagated stream', () => {
  it('SELECTs the database, wraps MULTI / EXEC and script effects, propagates expiry as DEL', async () => {
    // no periodic PING in the middle of the bytes this test compares, however slow the machine is
    const m = await startNode({ 'repl-diskless-sync': 'no', 'repl-ping-replica-period': '3600' });
    const tap = await tapStream(m.port);
    await m.call('SET', 'a', '1');
    await m.call('SELECT', '2');
    await m.call('INCR', 'n');
    await m.call('SELECT', '0');
    const tx = m.r.multi();
    tx.set('x', '1');
    tx.get('x');
    tx.incr('y');
    await tx.exec();
    await m.call('EVAL', "redis.call('SET', KEYS[1], 'from-lua'); redis.call('INCRBY', KEYS[2], 5); return 1", '2', 'l1', 'l2');
    await m.call('SET', 'gone', 'v', 'PX', '1');
    await sleep(10);
    expect(await m.call('GET', 'gone')).toBeNull();
    const expected =
      resp('SELECT', '0') +
      resp('SET', 'a', '1') +
      resp('SELECT', '2') +
      resp('INCR', 'n') +
      resp('MULTI') +
      resp('SELECT', '0') +
      // commands are propagated as the client spelled them (ioredis sends MULTI bodies in lowercase)
      resp('set', 'x', '1') +
      resp('incr', 'y') +
      resp('EXEC') +
      resp('MULTI') +
      resp('SET', 'l1', 'from-lua') +
      resp('INCRBY', 'l2', '5') +
      resp('EXEC');
    await waitFor(() => tap.stream().length >= expected.length);
    expect(tap.stream().slice(0, expected.length)).toBe(expected);
    const rest = tap.stream().slice(expected.length);
    // SET … PX is propagated with an absolute time, then the expiry is a DEL
    expect(rest).toMatch(/^\*5\r\n\$3\r\nSET\r\n\$4\r\ngone\r\n\$1\r\nv\r\n\$4\r\nPXAT\r\n\$13\r\n\d{13}\r\n/);
    await waitFor(() => tap.stream().endsWith(resp('DEL', 'gone')));
    tap.close();
  });
});

// ============================================================================
// Applying the stream
// ============================================================================

describe('a replica applies the stream', () => {
  it('MULTI, Lua, functions, FLUSHALL and several databases', async () => {
    const m = await startNode();
    const r = await startReplica(m);
    await waitSynced(m, r);
    const tx = m.r.multi();
    tx.rpush('l', 'a', 'b');
    tx.lpop('l');
    tx.sadd('s', 'm');
    await tx.exec();
    await m.call('EVAL', "redis.call('HSET', KEYS[1], 'f', ARGV[1]); return redis.call('HGET', KEYS[1], 'f')", '1', 'h', 'lua');
    await m.call('FUNCTION', 'LOAD', "#!lua name=lib\nredis.register_function('setx', function(keys, args) return redis.call('SET', keys[1], args[1]) end)");
    await m.call('FCALL', 'setx', '1', 'fk', 'fv');
    const db5 = m.client();
    await db5.select(5);
    await db5.set('five', '5');
    await waitSynced(m, r);
    expect(await r.call('LRANGE', 'l', '0', '-1')).toEqual(['b']);
    expect(await r.call('SMEMBERS', 's')).toEqual(['m']);
    expect(await r.call('HGET', 'h', 'f')).toBe('lua');
    expect(await r.call('GET', 'fk')).toBe('fv');
    expect(await r.call('FCALL_RO', 'setx', '1', 'fk', 'x').catch((e: Error) => e.message)).toMatch(/^ERR /);
    const r5 = r.client();
    await r5.select(5);
    expect(await r5.get('five')).toBe('5');
    await m.call('FLUSHALL');
    await waitSynced(m, r);
    expect(await r.call('DBSIZE')).toBe(0);
    expect(await r5.dbsize()).toBe(0);
  });

  it('blocking pops are applied as their non-blocking effect', async () => {
    const m = await startNode();
    const r = await startReplica(m);
    await waitSynced(m, r);
    const blocked = m.client();
    const pop = blocked.blpop('q', 0);
    await waitFor(async () => /blocked_clients:1/.test(String(await m.call('INFO', 'clients'))));
    await m.call('RPUSH', 'q', 'job1', 'job2');
    expect(await pop).toEqual(['q', 'job1']);
    await waitSynced(m, r);
    expect(await r.call('LRANGE', 'q', '0', '-1')).toEqual(['job2']);
  });

  it('a replica never expires keys itself: it hides them, and the master DEL removes them', async () => {
    const m = await startNode();
    const r = await startReplica(m);
    await waitSynced(m, r);
    // no active expiry on the master: only an access there expires the key
    await m.call('DEBUG', 'SET-ACTIVE-EXPIRE', '0');
    await m.call('SET', 'short', 'v', 'PX', '50');
    await waitSynced(m, r);
    expect(await r.call('GET', 'short')).toBe('v');
    await sleep(80);
    // logically expired on the replica: reads miss, but it is still stored (DBSIZE counts it)
    expect(await r.call('GET', 'short')).toBeNull();
    expect(await r.call('EXISTS', 'short')).toBe(0);
    expect(await r.call('DBSIZE')).toBe(1);
    // the master expires it on access and propagates DEL
    expect(await m.call('GET', 'short')).toBeNull();
    await waitSynced(m, r);
    expect(await r.call('DBSIZE')).toBe(0);
    await m.call('DEBUG', 'SET-ACTIVE-EXPIRE', '1');
  });

  it('keys evicted by the master arrive as DEL; a replica ignores maxmemory', async () => {
    const m = await startNode();
    const r = await startReplica(m, { maxmemory: '1', 'maxmemory-policy': 'allkeys-random' });
    await waitSynced(m, r);
    for (let i = 0; i < 50; i++) await m.call('SET', `k${i}`, 'x'.repeat(1000));
    await waitSynced(m, r);
    // the replica holds everything despite maxmemory 1 (replica-ignore-maxmemory yes)
    expect(await r.call('DBSIZE')).toBe(50);
    expect((await r.info('stats')).evicted_keys).toBe('0');
    const used = Number((await m.info('memory')).used_memory);
    await m.call('CONFIG', 'SET', 'maxmemory-policy', 'allkeys-random');
    await m.call('CONFIG', 'SET', 'maxmemory', String(used - 20_000));
    const evicted = Number((await m.info('stats')).evicted_keys);
    expect(evicted).toBeGreaterThan(0);
    await waitSynced(m, r);
    expect(await r.call('DBSIZE')).toBe(await m.call('DBSIZE'));
  });

  it('PUBLISH reaches the subscribers of the replica', async () => {
    const m = await startNode();
    const r = await startReplica(m);
    await waitSynced(m, r);
    const sub = r.client();
    const got: string[] = [];
    sub.on('message', (_channel: string, message: string) => got.push(message));
    await sub.subscribe('news');
    await m.call('PUBLISH', 'news', 'hello');
    await waitFor(() => got.length === 1);
    expect(got).toEqual(['hello']);
  });

  it('a replica of a replica receives the same stream (chained replication)', async () => {
    const m = await startNode();
    const r1 = await startReplica(m);
    await waitSynced(m, r1);
    const r2 = await startReplica(r1);
    await waitSynced(r1, r2);
    await m.call('SET', 'chain', 'yes');
    await m.call('ZADD', 'z', '1', 'a');
    await waitSynced(m, r1);
    await waitSynced(r1, r2);
    expect(await r2.call('GET', 'chain')).toBe('yes');
    expect(await r2.call('ZSCORE', 'z', 'a')).toBe('1');
    // the sub-replica shares the history of the top master
    expect((await r2.info()).master_replid).toBe((await m.info()).master_replid);
    expect((await r2.info()).master_repl_offset).toBe((await m.info()).master_repl_offset);
  });
});
