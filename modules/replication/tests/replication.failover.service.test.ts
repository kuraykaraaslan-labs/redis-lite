/**
 * FAILOVER: the coordinated switch of the master role to a replica, its argument checks and refusals, ABORT and
 * TIMEOUT.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { connect } from 'node:net';
import type { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { waitFor } from '@/tests/helpers';

import { startNode, startReplica, waitReplicas, waitSynced } from './replication.test_helpers';

// ============================================================================
// Helpers
// ============================================================================

/** A RESP array of bulk strings. */
function resp(...argv: string[]): string {
  return `*${argv.length}\r\n${argv.map((a) => `$${a.length}\r\n${a}\r\n`).join('')}`;
}

/** A fake replica on a raw socket: announces `port`, attaches with PSYNC, then stays silent (no ACKs). */
async function rawReplica(masterPort: number, port: number): Promise<Socket> {
  const socket = connect({ host: '127.0.0.1', port: masterPort });
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.on('data', () => undefined);
  socket.write(resp('REPLCONF', 'listening-port', String(port)) + resp('PSYNC', '?', '-1'));
  return socket;
}

// ============================================================================
// FAILOVER
// ============================================================================

describe('FAILOVER', () => {
  it('hands the master role to the replica, which keeps the data and the history', async () => {
    const m = await startNode();
    const r = await startReplica(m);
    await waitReplicas(m, 1);
    await waitSynced(m, r);
    await m.call('SET', 'k', 'v');
    const replid = (await m.info()).master_replid;
    expect(await m.call('FAILOVER')).toBe('OK');
    await waitFor(async () => (await r.info()).role === 'master' && (await m.info()).master_link_status === 'up');
    expect((await m.info()).role).toBe('slave');
    expect((await m.info()).master_failover_state).toBe('no-failover');
    expect((await m.info()).master_port).toBe(String(r.port));
    // the new master's previous history is the old master's
    expect((await r.info()).master_replid2).toBe(replid);
    expect((await r.info('stats')).sync_full).toBe('0');
    expect(await r.call('GET', 'k')).toBe('v');
    expect(await r.call('SET', 'k2', 'v2')).toBe('OK');
    await waitSynced(r, m);
    expect(await m.call('GET', 'k2')).toBe('v2');
    await expect(m.call('SET', 'x', '1')).rejects.toThrow("READONLY You can't write against a read only replica.");
  });

  it('TO host port picks the target; writes sent during the failover wait, then meet a replica', async () => {
    const m = await startNode();
    const a = await startReplica(m);
    const b = await startReplica(m);
    await waitReplicas(m, 2);
    await waitSynced(m, a);
    await waitSynced(m, b);
    expect(await m.call('FAILOVER', 'TO', '127.0.0.1', String(b.port), 'TIMEOUT', '5000')).toBe('OK');
    const writer = m.client();
    const pending = writer.set('during', '1').catch((e: Error) => e.message);
    await waitFor(async () => (await b.info()).role === 'master');
    expect(await pending).toBe("READONLY You can't write against a read only replica.");
    expect((await a.info()).role).toBe('slave');
    await waitFor(async () => (await m.info()).master_port === String(b.port));
  });

  it('refuses what it cannot do', async () => {
    const lonely = await startNode();
    await expect(lonely.call('FAILOVER')).rejects.toThrow('ERR FAILOVER requires connected replicas.');
    await expect(lonely.call('FAILOVER', 'ABORT')).rejects.toThrow('ERR FAILOVER is not in progress.');
    await expect(lonely.call('FAILOVER', 'TIMEOUT', '0')).rejects.toThrow('ERR FAILOVER timeout must be greater than 0');
    await expect(lonely.call('FAILOVER', 'BOGUS')).rejects.toThrow('ERR syntax error');
    const m = await startNode();
    const r = await startReplica(m);
    await waitReplicas(m, 1);
    await expect(m.call('FAILOVER', 'TO', '127.0.0.1', '1')).rejects.toThrow('ERR FAILOVER target HOST and PORT is not a replica.');
    await expect(m.call('FAILOVER', 'FORCE')).rejects.toThrow('ERR FAILOVER with force option requires both a timeout and target HOST and IP.');
    await expect(r.call('FAILOVER')).rejects.toThrow('ERR FAILOVER is not valid when server is a replica.');
  });


  it('ABORT and TIMEOUT go back to normal: writes paused meanwhile then run on the master', async () => {
    const m = await startNode();
    // a replica that attaches and never acknowledges anything: it never catches up
    const lagging = await rawReplica(m.port, 7001);
    await waitReplicas(m, 1);
    await m.call('SET', 'k', 'v');
    expect(await m.call('FAILOVER')).toBe('OK');
    expect((await m.info()).master_failover_state).toBe('waiting-for-sync');
    await expect(m.call('FAILOVER')).rejects.toThrow('ERR FAILOVER already in progress.');
    const writer = m.client();
    const paused = writer.set('during', '1');
    expect(await m.call('FAILOVER', 'ABORT')).toBe('OK');
    expect(await paused).toBe('OK');
    expect((await m.info()).master_failover_state).toBe('no-failover');
    expect((await m.info()).role).toBe('master');
    // TIMEOUT without FORCE aborts by itself
    expect(await m.call('FAILOVER', 'TIMEOUT', '300')).toBe('OK');
    await waitFor(async () => (await m.info()).master_failover_state === 'no-failover');
    expect((await m.info()).role).toBe('master');
    expect(await m.call('SET', 'after', '1')).toBe('OK');
    // FORCE goes ahead with the target that did not catch up; when it never answers, the timeout aborts
    expect(await m.call('FAILOVER', 'TO', '127.0.0.1', '7001', 'FORCE', 'TIMEOUT', '200')).toBe('OK');
    await waitFor(async () => (await m.info()).master_failover_state === 'failover-in-progress');
    lagging.destroy();
    await waitFor(async () => (await m.info()).master_failover_state === 'no-failover', { timeout: 10_000 });
    expect((await m.info()).role).toBe('master');
  });
});
