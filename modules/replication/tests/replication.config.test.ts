/**
 * Replication directives: `replicaof` in a redis.conf file (and its `slaveof` alias), the replication configs and their
 * aliases through CONFIG GET / SET.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { foldDirectives, readConfigFile } from '@/modules/server/server.conf_file';
import { CONFIG_DEFS, ServerConfig } from '@/modules/server/server.config';
import { tempDir } from '@/tests/helpers';

import { startNode, startReplica, waitSynced } from './replication.test_helpers';

describe('replication directives', () => {
  it('reads replicaof / slaveof from a config file', () => {
    const dir = tempDir();
    const path = join(dir, 'redis.conf');
    writeFileSync(path, 'replicaof 10.0.0.5 6380\nmasterauth "s3cret"\nrepl-backlog-size 2mb\nslave-read-only no\n');
    const { values, unknown } = foldDirectives(readConfigFile(path), (name) => ServerConfig.canonical(name) in CONFIG_DEFS);
    expect(unknown).toEqual([]);
    expect(values.get('replicaof')).toBe('10.0.0.5 6380');
    const config = new ServerConfig({});
    expect(config.validate('replicaof', '10.0.0.5 6380')).toEqual({ value: '10.0.0.5 6380' });
    expect(config.validate('slaveof', 'host')).toEqual({ error: 'Invalid master port' });
    expect(config.validate('repl-backlog-size', '2mb')).toEqual({ value: '2097152' });
  });

  it('CONFIG GET / SET of the replication configs and aliases', async () => {
    const m = await startNode();
    expect(await m.call('CONFIG', 'GET', 'repl-diskless-sync')).toEqual(['repl-diskless-sync', 'yes']);
    expect(await m.call('CONFIG', 'GET', 'repl-diskless-load')).toEqual(['repl-diskless-load', 'disabled']);
    expect(await m.call('CONFIG', 'GET', 'repl-timeout')).toEqual(['repl-timeout', '60']);
    expect(await m.call('CONFIG', 'GET', 'repl-backlog-ttl')).toEqual(['repl-backlog-ttl', '3600']);
    expect(await m.call('CONFIG', 'GET', 'replica-priority')).toEqual(['replica-priority', '100']);
    expect(await m.call('CONFIG', 'SET', 'slave-priority', '7')).toBe('OK');
    expect(await m.call('CONFIG', 'GET', 'replica-priority')).toEqual(['replica-priority', '7']);
    expect(await m.call('CONFIG', 'SET', 'repl-ping-slave-period', '3')).toBe('OK');
    expect(await m.call('CONFIG', 'GET', 'repl-ping-replica-period')).toEqual(['repl-ping-replica-period', '3']);
    expect(await m.call('CONFIG', 'GET', 'replicaof')).toEqual(['replicaof', '']);
    await expect(m.call('CONFIG', 'SET', 'replicaof', '127.0.0.1 1')).rejects.toThrow(/immutable/);
    expect(await m.call('CONFIG', 'SET', 'repl-diskless-load', 'swapdb')).toBe('OK');
    await expect(m.call('CONFIG', 'SET', 'repl-diskless-load', 'sometimes')).rejects.toThrow(/argument\(s\) must be one of the following/);
  });

  it('masterauth / masteruser authenticate the replica', async () => {
    const m = await startNode({}, { password: 'top' });
    await m.call('ACL', 'SETUSER', 'repl', 'on', '>replpw', '+psync', '+replconf', '+ping');
    const r = await startReplica(m, { masteruser: 'repl', masterauth: 'replpw' });
    await waitSynced(m, r);
    await m.call('SET', 'k', 'v');
    await waitSynced(m, r);
    expect(await r.call('GET', 'k')).toBe('v');
  });

  it('the RDB received with repl-diskless-load disabled is written to the replica dbfilename', async () => {
    const m = await startNode();
    await m.call('SET', 'k', 'v');
    const r = await startReplica(m, { 'repl-diskless-load': 'disabled' });
    await waitSynced(m, r);
    const [, dir] = (await r.call('CONFIG', 'GET', 'dir')) as string[];
    expect(existsSync(join(dir, 'dump.rdb'))).toBe(true);
  });
});
