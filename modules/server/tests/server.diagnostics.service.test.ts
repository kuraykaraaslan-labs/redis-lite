import { beforeAll, describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { errOf } from './server.test_helpers';

/**
 * MONITOR, SLOWLOG, LATENCY and MEMORY.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

// the shared ioredis client runs its connect-time ready check (INFO) on first use: get it out of the way before MONITOR
beforeAll(async () => {
  await t.call('PING');
});

describe('MONITOR / SLOWLOG / LATENCY / MEMORY', () => {
  it('MONITOR streams executed commands', async () => {
    const m = await t.raw();
    expect.soft(await m.send('MONITOR')).toBe('+OK\r\n');
    const r = await t.raw();
    await r.send('SET', 'mon:k', 'v a');
    const line = await m.read();
    expect.soft(line).toMatch(/^\+\d+\.\d{6} \[0 127\.0\.0\.1:\d+\] "SET" "mon:k" "v a"\r\n$/);
  });

  it('SLOWLOG GET / LEN / RESET', async () => {
    // a 200 ms threshold (and a 250 ms sleep to log): with the default 10 ms, a loaded machine can push ordinary
    // commands of this test over the threshold too
    await t.call('CONFIG', 'SET', 'slowlog-log-slower-than', '200000');
    expect.soft(await t.call('SLOWLOG', 'RESET')).toBe('OK');
    expect.soft(await t.call('SLOWLOG', 'LEN')).toBe(0);
    expect.soft(await t.call('SLOWLOG', 'GET')).toEqual([]);
    await t.call('DEBUG', 'SLEEP', '0.25');
    const entries = (await t.call('SLOWLOG', 'GET')) as unknown[][];
    expect.soft(entries).toHaveLength(1);
    const [id, ts, dur, argv, , name] = entries[0];
    expect.soft(typeof id).toBe('number');
    expect.soft(typeof ts).toBe('number');
    expect.soft(dur as number).toBeGreaterThanOrEqual(200000);
    expect.soft(argv).toEqual(['DEBUG', 'SLEEP', '0.25']);
    expect.soft(name).toBe('');
    expect.soft(await t.call('SLOWLOG', 'LEN')).toBe(1);
    expect.soft(await t.call('SLOWLOG', 'GET', '-1')).toHaveLength(1);
    expect.soft(await t.call('SLOWLOG', 'GET', '0')).toEqual([]);
    expect.soft(await t.call('SLOWLOG', 'RESET')).toBe('OK');
    expect.soft(await t.call('SLOWLOG', 'LEN')).toBe(0);
    await t.call('CONFIG', 'SET', 'slowlog-log-slower-than', '10000');
    expect.soft(await errOf(t.call('SLOWLOG', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try SLOWLOG HELP.");
  });

  it('LATENCY', async () => {
    expect.soft(await t.call('LATENCY', 'LATEST')).toEqual([]);
    expect.soft(await t.call('LATENCY', 'HISTORY', 'command')).toEqual([]);
    expect.soft(await t.call('LATENCY', 'RESET')).toBe(0);
    expect.soft(typeof (await t.call('LATENCY', 'DOCTOR'))).toBe('string');
    expect.soft(await errOf(t.call('LATENCY', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try LATENCY HELP.");
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('LATENCY', 'DOCTOR')).toMatch(/^=\d+\r\ntxt:/);
  });

  it('LATENCY monitor events', async () => {
    await t.call('CONFIG', 'SET', 'latency-monitor-threshold', '5');
    try {
      await t.call('DEBUG', 'SLEEP', '0.02');
      const [[event, time, latest, max]] = (await t.call('LATENCY', 'LATEST')) as Array<[string, number, number, number]>;
      expect.soft(event).toBe('command');
      expect.soft(time).toBeGreaterThan(0);
      expect.soft(latest).toBeGreaterThanOrEqual(5);
      expect.soft(max).toBe(latest);
      expect.soft(await t.call('LATENCY', 'HISTORY', 'command')).toEqual([[time, latest]]);
      expect.soft(String(await t.call('LATENCY', 'GRAPH', 'command'))).toMatch(/^command - high \d+ ms, low \d+ ms \(all time high \d+ ms\)\n-{80}\n/);
      expect.soft(String(await t.call('LATENCY', 'DOCTOR'))).toMatch(/^Dave, I have observed latency spikes/);
      expect.soft(await t.call('LATENCY', 'RESET', 'nosuch', 'command')).toBe(1);
      expect.soft(await t.call('LATENCY', 'LATEST')).toEqual([]);
    } finally {
      await t.call('CONFIG', 'SET', 'latency-monitor-threshold', '0');
    }
  });

  it('LATENCY HISTOGRAM and INFO latencystats track every called command', async () => {
    await t.call('CONFIG', 'RESETSTAT');
    await t.call('SET', 'lat', 'v');
    await t.call('GET', 'lat');
    await t.call('GET', 'lat');
    const reply = (await t.call('LATENCY', 'HISTOGRAM', 'get', 'set', 'lpush', 'nosuch')) as unknown[];
    // RESP2: name, [calls, n, histogram_usec, [bucket, cumulative…]] per command; never-called / unknown left out
    expect.soft(reply.filter((_, i) => i % 2 === 0)).toEqual(['get', 'set']);
    const get = reply[1] as unknown[];
    expect.soft(get.slice(0, 3)).toEqual(['calls', 2, 'histogram_usec']);
    const buckets = get[3] as number[];
    expect.soft(buckets.at(-1)).toBe(2);
    // a container name stands for its subcommands
    expect.soft(((await t.call('LATENCY', 'HISTOGRAM', 'config')) as unknown[])[0]).toBe('config|resetstat');
    const info = String(await t.call('INFO', 'latencystats'));
    expect.soft(info).toMatch(/^latency_percentiles_usec_get:p50=\d+\.\d{3},p99=\d+\.\d{3},p99\.9=\d+\.\d{3}\r?$/m);
    await t.call('CONFIG', 'SET', 'latency-tracking', 'no');
    expect.soft(String(await t.call('INFO', 'latencystats'))).toBe('# Latencystats\r\n');
    await t.call('CONFIG', 'SET', 'latency-tracking', 'yes');
  });

  it('MEMORY USAGE', async () => {
    await t.call('SET', 'mem:k', 'hello');
    const used = (await t.call('MEMORY', 'USAGE', 'mem:k')) as number;
    expect.soft(used).toBeGreaterThan(0);
    expect.soft(await t.call('MEMORY', 'USAGE', 'mem:k', 'SAMPLES', '0')).toBeGreaterThan(0);
    expect.soft(await t.call('MEMORY', 'USAGE', 'mem:missing')).toBeNull();
    await t.call('RPUSH', 'mem:list', 'a', 'b');
    expect.soft(await t.call('MEMORY', 'USAGE', 'mem:list')).toBeGreaterThan(0);
    expect.soft(await errOf(t.call('MEMORY', 'USAGE', 'mem:k', 'FOO'))).toBe('ERR syntax error');
    expect.soft(await errOf(t.call('MEMORY', 'USAGE', 'mem:k', 'SAMPLES', 'x'))).toBe('ERR value is not an integer or out of range');
    expect.soft(await errOf(t.call('MEMORY', 'USAGE'))).toBe("ERR wrong number of arguments for 'memory|usage' command");
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('MEMORY', 'USAGE', 'mem:missing')).toBe('_\r\n');
  });

  it('MEMORY DOCTOR', async () => {
    expect.soft(typeof (await t.call('MEMORY', 'DOCTOR'))).toBe('string');
    expect.soft(await errOf(t.call('MEMORY', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try MEMORY HELP.");
  });
});
