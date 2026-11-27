import { describe, expect, it } from 'vitest';

import { useServer, waitFor } from '@/tests/helpers';

import { errOf } from './server.test_helpers';

/**
 * Administration commands (TIME, LASTSAVE, SAVE, BGSAVE, ROLE, WAIT), with DEBUG and LOLWUT.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

describe('TIME / LASTSAVE / SAVE / BGSAVE / ROLE / DEBUG / LOLWUT', () => {
  it('TIME returns seconds and microseconds as bulk strings', async () => {
    const r = await t.raw();
    const reply = await r.send('TIME');
    const m = /^\*2\r\n\$\d+\r\n(\d+)\r\n\$\d+\r\n(\d+)\r\n$/.exec(reply);
    expect.soft(m).not.toBeNull();
    expect.soft(Math.abs(Number(m![1]) - Date.now() / 1000)).toBeLessThan(5);
    expect.soft(Number(m![2])).toBeLessThan(1_000_000);
    expect.soft(await r.send('TIME', 'x')).toBe("-ERR wrong number of arguments for 'time' command\r\n");
    await r.send('HELLO', '3');
    expect.soft(await r.send('TIME')).toMatch(/^\*2\r\n\$\d+\r\n\d+\r\n\$\d+\r\n\d+\r\n$/);
  });

  it('SAVE / BGSAVE / LASTSAVE', async () => {
    const r = await t.raw();
    expect.soft(await r.send('SAVE')).toBe('+OK\r\n');
    const last = await r.send('LASTSAVE');
    expect.soft(last).toMatch(/^:\d+\r\n$/);
    expect.soft(Math.abs(Number(last.slice(1, -2)) - Date.now() / 1000)).toBeLessThan(5);
    const saveIdle = () => waitFor(async () => /rdb_bgsave_in_progress:0/.test(String(await t.call('INFO', 'persistence'))));
    await saveIdle();
    expect.soft(await r.send('BGSAVE')).toBe('+Background saving started\r\n');
    await saveIdle();
    expect.soft(await r.send('BGSAVE', 'FOO')).toBe('-ERR syntax error\r\n');
    expect.soft(await r.send('SAVE', 'x')).toBe("-ERR wrong number of arguments for 'save' command\r\n");
    expect.soft(await r.send('LASTSAVE', 'x')).toBe("-ERR wrong number of arguments for 'lastsave' command\r\n");
  });

  it('ROLE on a master', async () => {
    expect.soft(await t.call('ROLE')).toEqual(['master', 0, []]);
    const r = await t.raw();
    expect.soft(await r.send('ROLE')).toBe('*3\r\n$6\r\nmaster\r\n:0\r\n*0\r\n');
  });

  it('DEBUG SLEEP', async () => {
    expect.soft(await t.call('DEBUG', 'SLEEP', '0')).toBe('OK');
    const start = performance.now(); // monotonic: the wall clock can be stepped mid-test
    expect.soft(await t.call('DEBUG', 'SLEEP', '0.1')).toBe('OK');
    expect.soft(performance.now() - start).toBeGreaterThanOrEqual(90);
  });

  it('LOLWUT ends with the Redis version', async () => {
    const out = String(await t.call('LOLWUT'));
    expect.soft(out).toBe('Redis ver. 7.0.15\n');
    expect.soft(String(await t.call('LOLWUT', 'VERSION', '5'))).toContain('Redis ver.');
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('LOLWUT')).toMatch(/^=\d+\r\ntxt:/);
  });
});

describe('WAIT', () => {
  it('WAIT with no replicas returns 0', async () => {
    expect.soft(await t.call('WAIT', '0', '0')).toBe(0);
    expect.soft(await t.call('WAIT', '1', '10')).toBe(0);
    expect.soft(await errOf(t.call('WAIT', '0', '-1'))).toBe('ERR timeout is negative');
    expect.soft(await errOf(t.call('WAIT', 'abc', '0'))).toBe('ERR value is not an integer or out of range');
    expect.soft(await errOf(t.call('WAIT', '0'))).toBe("ERR wrong number of arguments for 'wait' command");
  });
});
