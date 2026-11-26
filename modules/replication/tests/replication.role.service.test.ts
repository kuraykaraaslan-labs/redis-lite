/**
 * REPLICAOF / SLAVEOF, ROLE, INFO replication, CLIENT LIST flags, read-only replicas, replica-serve-stale-data and
 * promotion with REPLICAOF NO ONE (the PSYNC2 ID shift that lets the other replicas continue partially).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import { waitFor } from '@/tests/helpers';

import { startNode, startReplica, waitReplicas, waitSynced } from './replication.test_helpers';

const READONLY = "READONLY You can't write against a read only replica.";
const MASTERDOWN = "MASTERDOWN Link with MASTER is down and replica-serve-stale-data is set to 'no'.";

// ============================================================================
// ROLE / INFO / CLIENT LIST
// ============================================================================

describe('ROLE and INFO replication', () => {
  it('report both sides of a link', async () => {
    const m = await startNode();
    const r = await startReplica(m, { 'replica-priority': '42' });
    await waitSynced(m, r);
    await m.call('SET', 'k', 'v');
    await waitSynced(m, r);
    await waitFor(async () => (await m.info()).slave0?.includes(`offset=${(await m.info()).master_repl_offset}`));
    const mi = await m.info();
    const ri = await r.info();
    expect(mi.role).toBe('master');
    expect(mi.connected_slaves).toBe('1');
    expect(mi.slave0).toMatch(new RegExp(`^ip=127\\.0\\.0\\.1,port=${r.port},state=online,offset=${mi.master_repl_offset},lag=\\d+$`));
    expect(mi.master_failover_state).toBe('no-failover');
    expect(mi.master_replid).toMatch(/^[0-9a-f]{40}$/);
    expect(mi.master_replid2).toBe('0'.repeat(40));
    expect(mi.second_repl_offset).toBe('-1');
    expect(mi.repl_backlog_active).toBe('1');
    expect(mi.repl_backlog_size).toBe('1048576');
    expect(ri.role).toBe('slave');
    expect(ri.master_host).toBe('127.0.0.1');
    expect(ri.master_port).toBe(String(m.port));
    expect(ri.master_link_status).toBe('up');
    expect(ri.master_sync_in_progress).toBe('0');
    expect(ri.slave_repl_offset).toBe(mi.master_repl_offset);
    expect(ri.slave_read_repl_offset).toBe(mi.master_repl_offset);
    expect(ri.slave_priority).toBe('42');
    expect(ri.slave_read_only).toBe('1');
    expect(ri.replica_announced).toBe('1');
    expect(ri.master_replid).toBe(mi.master_replid);
    // the field order of the replica's section
    const keys = Object.keys(ri);
    expect(keys.slice(0, 8)).toEqual([
      'role', 'master_host', 'master_port', 'master_link_status', 'master_last_io_seconds_ago', 'master_sync_in_progress',
      'slave_read_repl_offset', 'slave_repl_offset',
    ]);
    const offset = Number(mi.master_repl_offset);
    expect(await m.call('ROLE')).toEqual(['master', offset, [['127.0.0.1', String(r.port), String(offset)]]]);
    expect(await r.call('ROLE')).toEqual(['slave', '127.0.0.1', m.port, 'connected', offset]);
  });

  it('CLIENT LIST flags the master link M and the replica connection S; HELLO reports the role', async () => {
    const m = await startNode();
    const r = await startReplica(m);
    await waitSynced(m, r);
    expect(String(await m.call('CLIENT', 'LIST', 'TYPE', 'replica'))).toMatch(/ flags=S /);
    expect(String(await r.call('CLIENT', 'LIST', 'TYPE', 'master'))).toMatch(/ flags=M /);
    const hello = (await r.call('HELLO', '2')) as unknown[];
    expect(hello[hello.indexOf('role') + 1]).toBe('replica');
  });

  it('a replica whose master is unreachable', async () => {
    const r = await startNode({ replicaof: '127.0.0.1 1' });
    const ri = await r.info();
    expect(ri.role).toBe('slave');
    expect(ri.master_link_status).toBe('down');
    expect(Number(ri.master_link_down_since_seconds)).toBeGreaterThanOrEqual(0);
    expect(ri.master_last_io_seconds_ago).toBe('-1');
    const role = (await r.call('ROLE')) as unknown[];
    expect(role.slice(0, 3)).toEqual(['slave', '127.0.0.1', 1]);
    expect(['connect', 'connecting']).toContain(role[3]);
    expect(role[4]).toBe(-1);
    expect(await r.call('CONFIG', 'GET', 'replicaof')).toEqual(['replicaof', '127.0.0.1 1']);
  });
});

// ============================================================================
// REPLICAOF
// ============================================================================

describe('REPLICAOF / SLAVEOF', () => {
  it('replies OK, "OK Already connected to specified master", and validates the port', async () => {
    const m = await startNode();
    const r = await startNode();
    expect(await r.call('REPLICAOF', '127.0.0.1', String(m.port))).toBe('OK');
    expect(await r.call('SLAVEOF', '127.0.0.1', String(m.port))).toBe('OK Already connected to specified master');
    await expect(r.call('REPLICAOF', '127.0.0.1', 'notaport')).rejects.toThrow('ERR value is not an integer or out of range');
    await expect(r.call('REPLICAOF', 'onlyone')).rejects.toThrow("ERR wrong number of arguments for 'replicaof' command");
    await waitSynced(m, r);
    expect(await r.call('REPLICAOF', 'NO', 'ONE')).toBe('OK');
    expect(await r.call('REPLICAOF', 'no', 'one')).toBe('OK');
    expect((await r.info()).role).toBe('master');
  });

  it('a read-only replica refuses writes (also inside MULTI and scripts) but serves reads', async () => {
    const m = await startNode();
    const r = await startReplica(m);
    await waitSynced(m, r);
    await m.call('SET', 'k', 'v');
    await waitSynced(m, r);
    expect(await r.call('GET', 'k')).toBe('v');
    await expect(r.call('SET', 'k', 'x')).rejects.toThrow(READONLY);
    await expect(r.call('DEL', 'k')).rejects.toThrow(READONLY);
    const tx = r.r.multi();
    tx.set('k', 'x');
    await expect(tx.exec()).rejects.toThrow(/EXECABORT/);
    await expect(r.call('EVAL', "return redis.call('SET', 'k', 'x')", '0')).rejects.toThrow(/READONLY You can't write against a read only replica\./);
    expect(await r.call('EVAL', "return redis.call('GET', 'k')", '0')).toBe('v');
    expect(await r.call('GET', 'k')).toBe('v');
  });

  it('replica-read-only no: local writes are allowed and not propagated', async () => {
    const m = await startNode();
    const r = await startReplica(m, { 'replica-read-only': 'no' });
    await waitSynced(m, r);
    expect(await r.call('SET', 'local', '1')).toBe('OK');
    expect(await m.call('GET', 'local')).toBeNull();
    expect((await r.info()).slave_read_only).toBe('0');
  });

  it('replica-serve-stale-data no: MASTERDOWN while the link is down, stale commands still run', async () => {
    const r = await startNode({ replicaof: '127.0.0.1 1', 'replica-serve-stale-data': 'no' });
    await expect(r.call('GET', 'k')).rejects.toThrow(MASTERDOWN);
    expect(String(await r.call('INFO', 'replication'))).toContain('role:slave');
    expect(await r.call('CONFIG', 'SET', 'replica-serve-stale-data', 'yes')).toBe('OK');
    expect(await r.call('GET', 'k')).toBeNull();
  });
});

// ============================================================================
// Promotion
// ============================================================================

describe('promotion (REPLICAOF NO ONE)', () => {
  it('shifts the replication ID and lets the other replicas continue with a partial resync', async () => {
    const m = await startNode();
    const a = await startReplica(m);
    const b = await startReplica(m);
    await waitSynced(m, a);
    await waitSynced(m, b);
    await m.call('SET', 'before', '1');
    await waitSynced(m, a);
    await waitSynced(m, b);
    const old = await m.info();
    // the master goes away; A takes over
    await m.close();
    expect(await a.call('REPLICAOF', 'NO', 'ONE')).toBe('OK');
    const ai = await a.info();
    expect(ai.role).toBe('master');
    expect(ai.master_replid).not.toBe(old.master_replid);
    expect(ai.master_replid2).toBe(old.master_replid);
    expect(ai.second_repl_offset).toBe(String(Number(old.master_repl_offset) + 1));
    expect(ai.master_repl_offset).toBe(old.master_repl_offset);
    expect(await a.call('SET', 'after', '2')).toBe('OK');
    // B follows A: same history, so PSYNC continues (no full sync on A)
    expect(await b.call('REPLICAOF', '127.0.0.1', String(a.port))).toBe('OK');
    await waitReplicas(a, 1);
    await waitSynced(a, b);
    expect(await b.call('GET', 'before')).toBe('1');
    expect(await b.call('GET', 'after')).toBe('2');
    const stats = await a.info('stats');
    expect(stats.sync_full).toBe('0');
    expect(stats.sync_partial_ok).toBe('1');
    const bi = await b.info();
    expect(bi.master_replid).toBe(ai.master_replid);
    expect(bi.master_replid2).toBe(old.master_replid);
  });
});
