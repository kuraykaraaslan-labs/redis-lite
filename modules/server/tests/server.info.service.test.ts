import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { errOf } from './server.test_helpers';

/**
 * INFO.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

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
    expect.soft(info).toContain('\r\nredis_version:7.0.15\r\n');
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
    expect.soft(info).toMatch(/\r\ndb5:keys=2,expires=1,avg_ttl=\d+\r\n/);
    await r.send('FLUSHDB');
    expect.soft(String(await t.call('INFO', 'keyspace'))).not.toContain('db5:');
  });

  it('INFO is a verbatim string in RESP3', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('INFO', 'server')).toMatch(/^=\d+\r\ntxt:# Server\r\n/);
  });
});
