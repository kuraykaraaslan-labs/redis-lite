/**
 * PSYNC / SYNC / REPLCONF and the full / partial resynchronization they drive: a replica receives every data type
 * through a full sync, continues after a short disconnect from the backlog, needs a full sync again once the backlog
 * overflowed, and the wire format follows the documented protocol (`+FULLRESYNC <replid> <offset>`, the RDB as
 * `$<len>` or diskless `$EOF:<mark>`, `+CONTINUE`).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { connect } from 'node:net';
import type { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { waitFor } from '@/tests/helpers';

import { startNode, startReplica, waitReplicas, waitSynced } from './replication.test_helpers';
import type { Node } from './replication.test_helpers';

// ============================================================================
// Helpers
// ============================================================================

const LIB = "#!lua name=replib\nredis.register_function('answer', function() return 42 end)";

/** A raw connection that collects everything the server sends (latin1). */
async function rawConnect(port: number): Promise<{ socket: Socket; data: () => string; send: (...argv: string[]) => void }> {
  const socket = connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let buf = '';
  socket.setEncoding('latin1');
  socket.on('data', (d: string) => (buf += d));
  const send = (...argv: string[]): void => {
    socket.write(`*${argv.length}\r\n${argv.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`);
  };
  return { socket, data: () => buf, send };
}

/** Kills the replica's link from the master side (the replica reconnects within about a second). */
async function dropReplicaLinks(master: Node): Promise<void> {
  await master.call('CLIENT', 'KILL', 'TYPE', 'replica');
}

async function fillAllTypes(m: Node): Promise<void> {
  await m.call('SET', 'str', 'hello');
  await m.call('SET', 'bin', Buffer.from([0, 255, 13, 10, 128]));
  await m.call('SET', 'ttl', 'v', 'PX', '3600000');
  await m.call('RPUSH', 'list', 'a', 'b', 'c');
  await m.call('SADD', 'set', 'x', 'y', 'z');
  await m.call('SADD', 'intset', '1', '2', '3');
  await m.call('ZADD', 'zset', '1', 'one', '2.5', 'two');
  await m.call('HSET', 'hash', 'f1', 'v1', 'f2', 'v2');
  await m.call('XADD', 'stream', '1-1', 'k', 'v');
  await m.call('XADD', 'stream', '2-1', 'k2', 'v2');
  await m.call('XGROUP', 'CREATE', 'stream', 'g', '0');
  await m.call('XREADGROUP', 'GROUP', 'g', 'alice', 'COUNT', '1', 'STREAMS', 'stream', '>');
  await m.call('PFADD', 'hll', 'a', 'b', 'c', 'd');
  await m.call('GEOADD', 'geo', '13.361389', '38.115556', 'Palermo');
  await m.call('FUNCTION', 'LOAD', LIB);
  await m.call('SELECT', '3');
  await m.call('SET', 'db3key', 'in db 3');
  await m.call('SELECT', '0');
}

/** The documented contents of what fillAllTypes() wrote. */
async function expectAllTypes(r: Node): Promise<void> {
  expect(await r.call('GET', 'str')).toBe('hello');
  expect(await r.r.getBuffer('bin')).toEqual(Buffer.from([0, 255, 13, 10, 128]));
  const ttl = Number(await r.call('PTTL', 'ttl'));
  expect(ttl).toBeGreaterThan(3_000_000);
  expect(ttl).toBeLessThanOrEqual(3_600_000);
  expect(await r.call('LRANGE', 'list', '0', '-1')).toEqual(['a', 'b', 'c']);
  expect(((await r.call('SMEMBERS', 'set')) as string[]).sort()).toEqual(['x', 'y', 'z']);
  expect(((await r.call('SMEMBERS', 'intset')) as string[]).sort()).toEqual(['1', '2', '3']);
  expect(await r.call('ZRANGE', 'zset', '0', '-1', 'WITHSCORES')).toEqual(['one', '1', 'two', '2.5']);
  expect(await r.call('HGET', 'hash', 'f1')).toBe('v1');
  expect(await r.call('HGET', 'hash', 'f2')).toBe('v2');
  expect(await r.call('XRANGE', 'stream', '-', '+')).toEqual([
    ['1-1', ['k', 'v']],
    ['2-1', ['k2', 'v2']],
  ]);
  const groups = (await r.call('XINFO', 'GROUPS', 'stream')) as unknown[][];
  expect(groups).toHaveLength(1);
  expect(groups[0].slice(0, 6)).toEqual(['name', 'g', 'consumers', 1, 'pending', 1]);
  expect(await r.call('PFCOUNT', 'hll')).toBe(4);
  const pos = (await r.call('GEOPOS', 'geo', 'Palermo')) as string[][];
  expect(Number(pos[0][0])).toBeCloseTo(13.361389, 5);
  expect(await r.call('FCALL', 'answer', '0')).toBe(42);
  const db3 = r.client();
  await db3.select(3);
  expect(await db3.get('db3key')).toBe('in db 3');
}

// ============================================================================
// Full synchronization
// ============================================================================

describe('full synchronization', () => {
  it('copies every data type, TTLs and functions to a new replica (diskless EOF payload)', async () => {
    const m = await startNode();
    await fillAllTypes(m);
    const r = await startReplica(m);
    await waitSynced(m, r);
    await expectAllTypes(r);
    expect((await m.info('stats')).sync_full).toBe('1');
  });

  it('copies the dataset with a disk-style $<len> payload when diskless sync is off', async () => {
    const m = await startNode({ 'repl-diskless-sync': 'no' });
    await fillAllTypes(m);
    const r = await startReplica(m);
    await waitSynced(m, r);
    await expectAllTypes(r);
  });

  it('replaces whatever the replica held before', async () => {
    const m = await startNode();
    await m.call('SET', 'from-master', '1');
    const r = await startNode();
    await r.call('SET', 'local-only', '1');
    await r.call('FUNCTION', 'LOAD', LIB);
    expect(await r.call('REPLICAOF', '127.0.0.1', String(m.port))).toBe('OK');
    await waitSynced(m, r);
    expect(await r.call('GET', 'local-only')).toBeNull();
    expect(await r.call('GET', 'from-master')).toBe('1');
    expect(await r.call('FUNCTION', 'LIST')).toEqual([]);
  });
});

// ============================================================================
// Partial resynchronization and the backlog
// ============================================================================

describe('partial resynchronization', () => {
  it('continues from the backlog after a short disconnect (sync_partial_ok, no new full sync)', async () => {
    const m = await startNode();
    const r = await startReplica(m);
    await waitSynced(m, r);
    await m.call('SET', 'k1', 'a');
    await waitSynced(m, r);
    await dropReplicaLinks(m);
    // written while the replica is away: must come from the backlog
    await m.call('SET', 'k2', 'b');
    await m.call('INCR', 'counter');
    await waitSynced(m, r);
    expect(await r.call('GET', 'k2')).toBe('b');
    expect(await r.call('GET', 'counter')).toBe('1');
    const stats = await m.info('stats');
    expect(stats.sync_full).toBe('1');
    expect(stats.sync_partial_ok).toBe('1');
  });

  it('falls back to a full sync once the backlog no longer holds the missing bytes', async () => {
    const m = await startNode({ 'repl-backlog-size': '16384' });
    const r = await startReplica(m);
    await waitSynced(m, r);
    // stop the replica from reconnecting while the master writes more than the backlog holds
    await r.call('REPLICAOF', '127.0.0.1', '1');
    await waitFor(async () => (await m.info()).connected_slaves === '0');
    for (let i = 0; i < 100; i++) await m.call('SET', `big:${i}`, 'x'.repeat(500));
    const info = await m.info();
    expect(Number(info.repl_backlog_histlen)).toBe(16384);
    expect(Number(info.repl_backlog_first_byte_offset)).toBe(Number(info.master_repl_offset) - 16384 + 1);
    await r.call('REPLICAOF', '127.0.0.1', String(m.port));
    await waitSynced(m, r);
    expect(await r.call('DBSIZE')).toBe(100);
    const stats = await m.info('stats');
    expect(stats.sync_full).toBe('2');
    expect(stats.sync_partial_err).toBe('1');
  });
});

// ============================================================================
// Wire protocol
// ============================================================================

describe('wire protocol (master side)', () => {
  it('PSYNC ? -1 answers +FULLRESYNC <replid> <offset> then an RDB, then the stream', async () => {
    const m = await startNode({ 'repl-diskless-sync': 'no', 'repl-ping-replica-period': '3600' });
    await m.call('SET', 'k', 'v');
    const c = await rawConnect(m.port);
    c.send('REPLCONF', 'listening-port', '7777');
    c.send('PSYNC', '?', '-1');
    await waitFor(() => /REDIS\d{4}/.test(c.data()));
    const replid = (await m.info()).master_replid;
    expect(c.data().startsWith(`+OK\r\n+FULLRESYNC ${replid} 0\r\n$`)).toBe(true);
    const header = /\$(\d+)\r\n/.exec(c.data().slice(c.data().indexOf('$')));
    const len = Number(header?.[1]);
    await waitFor(() => c.data().length >= c.data().indexOf('REDIS') + len);
    const rdbStart = c.data().indexOf('REDIS');
    // the RDB is not followed by CRLF: the next bytes belong to the stream
    await m.call('SET', 'after', '1');
    await waitFor(() => c.data().length > rdbStart + len);
    expect(c.data().slice(rdbStart + len)).toBe('*2\r\n$6\r\nSELECT\r\n$1\r\n0\r\n*3\r\n$3\r\nSET\r\n$5\r\nafter\r\n$1\r\n1\r\n');
    // the connection is now listed as a replica (flag S) and gets no replies
    const list = String(await m.call('CLIENT', 'LIST', 'TYPE', 'replica'));
    expect(list).toMatch(/flags=S /);
    expect((await m.info()).slave0).toMatch(/^ip=127\.0\.0\.1,port=7777,state=online,offset=0,lag=\d+$/);
    c.socket.destroy();
  });

  it('a replica with capa eof gets the diskless $EOF:<40 byte mark> form', async () => {
    const m = await startNode({ 'repl-diskless-sync': 'yes' });
    const c = await rawConnect(m.port);
    c.send('REPLCONF', 'capa', 'eof', 'capa', 'psync2');
    c.send('PSYNC', '?', '-1');
    await waitFor(() => /\$EOF:[0-9a-f]{40}\r\n/.test(c.data()));
    const mark = /\$EOF:([0-9a-f]{40})\r\n/.exec(c.data())?.[1] ?? '';
    await waitFor(() => c.data().endsWith(mark));
    const body = c.data().slice(c.data().indexOf(`${mark}\r\n`) + 42, -40);
    expect(body.startsWith('REDIS')).toBe(true);
    c.socket.destroy();
  });

  it('PSYNC with the current replid and a covered offset answers +CONTINUE and the missing bytes', async () => {
    const m = await startNode({ 'repl-ping-replica-period': '3600' });
    const r = await startReplica(m);
    await waitSynced(m, r);
    await m.call('SET', 'k', 'v');
    const { master_replid: replid, master_repl_offset: offset } = await m.info();
    await m.call('SET', 'k2', 'v2');
    const c = await rawConnect(m.port);
    c.send('REPLCONF', 'capa', 'psync2');
    c.send('PSYNC', replid, String(Number(offset) + 1));
    const tail = '*3\r\n$3\r\nSET\r\n$2\r\nk2\r\n$2\r\nv2\r\n';
    await waitFor(() => c.data().endsWith(tail));
    expect(c.data()).toBe(`+OK\r\n+CONTINUE ${replid}\r\n${tail}`);
    c.socket.destroy();
  });

  it('REPLCONF grammar and SYNC', async () => {
    const m = await startNode({ 'repl-diskless-sync': 'no' });
    expect(await m.call('REPLCONF', 'listening-port', '1234', 'capa', 'eof')).toBe('OK');
    await expect(m.call('REPLCONF', 'listening-port')).rejects.toThrow('ERR syntax error');
    await expect(m.call('REPLCONF', 'nosuchoption', 'x')).rejects.toThrow('ERR Unrecognized REPLCONF option: nosuchoption');
    await expect(m.call('PSYNC', '?', 'abc')).rejects.toThrow('ERR value is not an integer or out of range');
    const c = await rawConnect(m.port);
    c.send('SYNC');
    await waitFor(() => /^\$\d+\r\nREDIS/.test(c.data()));
    c.socket.destroy();
  });

  it('a replica that never sends ACKs is dropped after repl-timeout', async () => {
    const m = await startNode({ 'repl-timeout': '1' });
    const c = await rawConnect(m.port);
    c.send('PSYNC', '?', '-1');
    await waitReplicas(m, 1);
    await waitFor(async () => (await m.info()).connected_slaves === '0', { timeout: 10_000 });
    c.socket.destroy();
  });
});

describe('repl-backlog-ttl', () => {
  it('frees the backlog once no replica was attached for that long; writes meanwhile reach a returning replica', async () => {
    const m = await startNode({ 'repl-backlog-ttl': '1' });
    const r = await startReplica(m);
    await waitSynced(m, r);
    const replid = (await m.info()).master_replid;
    await r.call('REPLICAOF', '127.0.0.1', '1');
    await waitFor(async () => (await m.info()).repl_backlog_active === '0', { timeout: 10_000 });
    await m.call('SET', 'while-away', '1');
    await r.call('REPLICAOF', '127.0.0.1', String(m.port));
    await waitSynced(m, r);
    expect(await r.call('GET', 'while-away')).toBe('1');
    // a new history: the old ID cannot be continued
    expect((await m.info()).master_replid).not.toBe(replid);
    expect((await m.info('stats')).sync_full).toBe('2');
  });
});
