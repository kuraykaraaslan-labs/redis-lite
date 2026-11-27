/**
 * WAIT with real acknowledgements, and min-replicas-to-write / min-replicas-max-lag (NOREPLICAS).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import { waitFor } from '@/tests/helpers';

import { startNode, startReplica, waitReplicas, waitSynced } from './replication.test_helpers';

describe('WAIT', () => {
  it('returns once the replicas acknowledged the write, with their number', async () => {
    const m = await startNode();
    const r1 = await startReplica(m);
    const r2 = await startReplica(m);
    await waitReplicas(m, 2);
    await waitSynced(m, r1);
    await waitSynced(m, r2);
    await m.call('SET', 'k', 'v');
    const started = Date.now();
    expect(await m.call('WAIT', '2', '5000')).toBe(2);
    // answered by the acknowledgements (GETACK), not the timeout
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await m.call('WAIT', '1', '0')).toBe(2);
  });

  it('times out with the number that did acknowledge', async () => {
    const m = await startNode();
    const r = await startReplica(m);
    await waitReplicas(m, 1);
    await waitSynced(m, r);
    await m.call('SET', 'k', 'v');
    expect(await m.call('WAIT', '3', '300')).toBe(1);
  });

  it('inside MULTI it answers at once; on a replica it is an error', async () => {
    const m = await startNode();
    const r = await startReplica(m);
    await waitReplicas(m, 1);
    const tx = m.r.multi();
    tx.set('k', 'v');
    tx.call('WAIT', '5', '0');
    const res = (await tx.exec()) as Array<[Error | null, unknown]>;
    expect(typeof res[1][1]).toBe('number');
    await expect(r.call('WAIT', '1', '10')).rejects.toThrow(
      'ERR WAIT cannot be used with replica instances. Please also note that since Redis 4.0 if a replica is configured to be writable (which is not the default) writes to replicas are just local and are not propagated.',
    );
  });
});

describe('min-replicas-to-write', () => {
  it('refuses writes with NOREPLICAS until enough replicas acknowledge within the lag', async () => {
    const m = await startNode();
    await m.call('CONFIG', 'SET', 'min-replicas-to-write', '1');
    await m.call('CONFIG', 'SET', 'min-replicas-max-lag', '10');
    await expect(m.call('SET', 'k', 'v')).rejects.toThrow('NOREPLICAS Not enough good replicas to write.');
    await expect(m.call('EVAL', "return redis.call('SET', 'k', 'v')", '0')).rejects.toThrow(/NOREPLICAS Not enough good replicas to write\./);
    expect(await m.call('GET', 'k')).toBeNull();
    expect((await m.info()).min_slaves_good_slaves).toBe('0');
    await startReplica(m);
    await waitReplicas(m, 1);
    await waitFor(async () => (await m.info()).min_slaves_good_slaves === '1');
    expect(await m.call('SET', 'k', 'v')).toBe('OK');
    await m.call('CONFIG', 'SET', 'min-slaves-to-write', '0');
    expect(await m.call('CONFIG', 'GET', 'min-replicas-to-write')).toEqual(['min-replicas-to-write', '0']);
  });
});
