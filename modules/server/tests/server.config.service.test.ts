import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import Redis from 'ioredis';

import { eventually, useServer } from '@/tests/helpers';

import { errOf, pairs } from './server.test_helpers';

/**
 * CONFIG.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

describe('CONFIG', () => {
  it('GET returns name/value pairs', async () => {
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory')).toEqual(['maxmemory', '0']);
    expect.soft(await t.call('CONFIG', 'GET', 'nosuchoption')).toEqual([]);
    expect.soft(await t.call('CONFIG', 'GET', 'databases')).toEqual(['databases', '16']);
  });

  it('GET with globs', async () => {
    const res = pairs(await t.call('CONFIG', 'GET', 'maxmemory*'));
    expect.soft(res.maxmemory).toBe('0');
    expect.soft(res['maxmemory-policy']).toBe('noeviction');
    expect.soft(res['maxmemory-samples']).toBe('5');
    const q = pairs(await t.call('CONFIG', 'GET', 'maxmemor?'));
    expect.soft(Object.keys(q)).toEqual(['maxmemory']);
  });

  it('GET with several parameters', async () => {
    const res = pairs(await t.call('CONFIG', 'GET', 'maxmemory', 'databases'));
    expect.soft(res).toEqual({ maxmemory: '0', databases: '16' });
    // the same option asked twice is reported once
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory', 'maxmemory')).toEqual(['maxmemory', '0']);
  });

  it('GET of an alias returns the alias name', async () => {
    expect.soft(await t.call('CONFIG', 'GET', 'hash-max-ziplist-entries')).toEqual(['hash-max-ziplist-entries', '512']);
    expect.soft(await t.call('CONFIG', 'GET', 'hash-max-listpack-entries')).toEqual(['hash-max-listpack-entries', '512']);
  });

  it('SET through an alias changes the real option', async () => {
    expect.soft(await t.call('CONFIG', 'SET', 'hash-max-ziplist-entries', '64')).toBe('OK');
    expect.soft(await t.call('CONFIG', 'GET', 'hash-max-listpack-entries')).toEqual(['hash-max-listpack-entries', '64']);
    await t.call('CONFIG', 'SET', 'hash-max-listpack-entries', '128');
  });

  it('SET with memory units and several pairs', async () => {
    expect.soft(await t.call('CONFIG', 'SET', 'maxmemory', '1mb', 'maxmemory-samples', '7')).toBe('OK');
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory')).toEqual(['maxmemory', '1048576']);
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory-samples')).toEqual(['maxmemory-samples', '7']);
    await t.call('CONFIG', 'SET', 'maxmemory', '0', 'maxmemory-samples', '5');
  });

  it('SET errors', async () => {
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'nosuchoption', 'x'))).toBe(
      "ERR Unknown option or number of arguments for CONFIG SET - 'nosuchoption'",
    );
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory', 'abc'))).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'maxmemory') - argument must be a memory value",
    );
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory'))).toBe("ERR wrong number of arguments for 'config|set' command");
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory', '1', 'maxmemory-samples'))).toBe('ERR syntax error');
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory-policy', 'bogus'))).toMatch(
      /^ERR CONFIG SET failed \(possibly related to argument 'maxmemory-policy'\) - argument\(s\) must be one of the following: /,
    );
  });

  it('SET is atomic: a bad pair leaves the others unchanged', async () => {
    await errOf(t.call('CONFIG', 'SET', 'maxmemory-samples', '9', 'maxmemory', 'abc'));
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory-samples')).toEqual(['maxmemory-samples', '5']);
  });

  it('SET of the same parameter twice is rejected', async () => {
    // Redis configSetCommand(): errstr "duplicate parameter", reported as "CONFIG SET failed (possibly related to argument '%s') - %s"
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory', '1', 'maxmemory', '2'))).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'maxmemory') - duplicate parameter",
    );
  });

  it('RESETSTAT resets the stats', async () => {
    expect.soft(await t.call('CONFIG', 'RESETSTAT')).toBe('OK');
    expect.soft(String(await t.call('INFO', 'stats'))).toContain('total_error_replies:0');
    expect.soft(await errOf(t.call('CONFIG', 'RESETSTAT', 'x'))).toBe("ERR wrong number of arguments for 'config|resetstat' command");
  });

  it('SET port listens on the new port', async () => {
    const free = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const old = t.server.port;
    expect.soft(await t.call('CONFIG', 'SET', 'port', String(free))).toBe('OK');
    const moved = new Redis(free, '127.0.0.1', { maxRetriesPerRequest: null, retryStrategy: () => null });
    try {
      await eventually(async () => expect(await moved.ping()).toBe('PONG'));
      expect.soft(await moved.call('CONFIG', 'GET', 'port')).toEqual(['port', String(free)]);
      // connections made before the move stay; the move back works the same way
      expect.soft(await t.call('CONFIG', 'SET', 'port', String(old))).toBe('OK');
    } finally {
      moved.disconnect();
    }
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'port', 'abc'))).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'port') - argument couldn't be parsed into an integer",
    );
  });

  it('GET in RESP3 is a map', async () => {
    await t.call('CONFIG', 'SET', 'maxmemory', '0');
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('CONFIG', 'GET', 'maxmemory')).toBe('%1\r\n$9\r\nmaxmemory\r\n$1\r\n0\r\n');
    expect.soft(await r.send('CONFIG', 'GET', 'nosuchoption')).toBe('%0\r\n');
  });

  it('unknown subcommand and arity', async () => {
    expect.soft(await errOf(t.call('CONFIG', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try CONFIG HELP.");
    expect.soft(await errOf(t.call('CONFIG', 'GET'))).toBe("ERR wrong number of arguments for 'config|get' command");
    expect.soft(await errOf(t.call('CONFIG'))).toBe("ERR wrong number of arguments for 'config' command");
  });
});
