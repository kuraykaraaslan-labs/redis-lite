import { describe, expect, it } from 'vitest';

import type { Reply } from '@/libs/resp';

import { RedisLiteServer } from '@/modules/server/server.core';

/**
 * Bounded keyspace bookkeeping: per-key state the server keeps for WATCH (and the used-memory tracker) must stay bounded
 * by what is watched / stored, not grow with every key ever touched.
 */
function bareServer(): { server: RedisLiteServer; run: (...argv: string[]) => Reply } {
  const server = new RedisLiteServer({ port: 0, host: '127.0.0.1', databases: 2, logLevel: 'silent' });
  const client = server.createInternalClient();
  const run = (...argv: string[]): Reply => server.execute(client, argv, { inScript: false, noBlock: true }) as Reply;
  return { server, run };
}

describe('keyspace bookkeeping stays bounded', () => {
  it('touching 100k distinct keys with no watchers keeps no per-key WATCH state', () => {
    const { server, run } = bareServer();
    for (let i = 0; i < 100_000; i++) run('SET', `k:${i}`, 'v');
    for (let i = 0; i < 100_000; i++) run('DEL', `k:${i}`);
    expect(server.keyspace.watches.size).toBe(0);
    // nothing reads used_memory here: the changed-key list must not hold every deleted key either
    expect(server.memoryModel.tracker.pendingKeys).toBeLessThanOrEqual(4097);
  });

  it('WATCH entries are dropped on UNWATCH, EXEC, DISCARD, RESET and disconnect', () => {
    const { server, run } = bareServer();
    const other = server.createInternalClient();
    const watch = (...keys: string[]): void => {
      run('WATCH', ...keys);
      expect(server.keyspace.watches.size).toBe(keys.length);
    };

    watch('a', 'b');
    run('UNWATCH');
    expect(server.keyspace.watches.size).toBe(0);

    watch('a');
    run('MULTI');
    run('EXEC');
    expect(server.keyspace.watches.size).toBe(0);

    watch('a', 'b', 'c');
    run('MULTI');
    run('DISCARD');
    expect(server.keyspace.watches.size).toBe(0);

    watch('a');
    run('RESET');
    expect(server.keyspace.watches.size).toBe(0);

    server.execute(other, ['WATCH', 'x', 'y'], { inScript: false, noBlock: true });
    expect(server.keyspace.watches.size).toBe(2);
    server.connections.disconnect(other);
    expect(server.keyspace.watches.size).toBe(0);
  });

  it('a key watched by two clients keeps its entry until both stop watching', () => {
    const { server, run } = bareServer();
    const other = server.createInternalClient();
    run('WATCH', 'shared');
    server.execute(other, ['WATCH', 'shared'], { inScript: false, noBlock: true });
    run('SET', 'shared', '1');
    expect(other.watched.dirty).toBe(true);
    run('UNWATCH');
    expect(server.keyspace.watches.size).toBe(1);
    server.execute(other, ['UNWATCH'], { inScript: false, noBlock: true });
    expect(server.keyspace.watches.size).toBe(0);
    expect(other.watched.dirty).toBe(false);
  });
});
