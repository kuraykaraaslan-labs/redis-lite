import { expect, it } from 'vitest';

import { RedisLite } from '@/index';
import { tempDir } from '@/tests/helpers';

import { DiffConnection } from './differential.connection';
import { differential, s } from './differential.harness';

/**
 * MIGRATE and RESTORE-ASKING (Redis 7.0.15). The scenarios need no target: argument errors, NOKEY (no key exists, so
 * nothing connects) and IOERR towards port 1 (connection refused). The hand-written test moves keys across: the oracle
 * migrates into a redis-lite and redis-lite into the oracle, and both must answer alike and leave the same data.
 */

/** A RESTORE payload of the string "v" (as DUMP v makes it on 7.0). */
const STRING_V = '"\\x00\\x01v\\n\\x00\\x91\\x08\\xce\\xb2\\x198\\x8a\\xce"';

differential('keys.migrate', [
  s('MIGRATE arity', ['MIGRATE', 'MIGRATE 127.0.0.1 1 k 0']),
  s('MIGRATE options are parsed first', [
    'SET k v',
    'MIGRATE 127.0.0.1 1 k x 100 FOO',
    'MIGRATE 127.0.0.1 1 nokey 0 100 FOO',
    'MIGRATE 127.0.0.1 1 nokey 0 100 AUTH',
    'MIGRATE 127.0.0.1 1 nokey 0 100 AUTH2 user',
    'MIGRATE 127.0.0.1 1 k 0 100 FOO KEYS a',
  ]),
  s('MIGRATE KEYS needs an empty key argument', [
    'SET k v',
    'MIGRATE 127.0.0.1 1 k 0 100 KEYS k',
    'MIGRATE 127.0.0.1 1 nokey 0 100 KEYS',
  ]),
  s('MIGRATE db and timeout are integers', [
    'SET k v',
    'MIGRATE 127.0.0.1 1 k x 100',
    'MIGRATE 127.0.0.1 1 k 0 x',
    'MIGRATE 127.0.0.1 1 k 0 1.5',
    'MIGRATE 127.0.0.1 1 k 9999999999999999999 100',
  ]),
  s('MIGRATE without an existing key answers NOKEY', [
    'MIGRATE 127.0.0.1 1 nokey 0 100',
    'MIGRATE 127.0.0.1 1 "" 0 100',
    'MIGRATE 127.0.0.1 1 "" 0 100 KEYS',
    'MIGRATE 127.0.0.1 1 "" 0 100 COPY REPLACE KEYS a b c',
    'SET k v',
    'PEXPIRE k 1',
    { sleep: 20 },
    'MIGRATE 127.0.0.1 1 k 0 100',
  ]),
  s('MIGRATE to a refused port is an IOERR and keeps the key', [
    'SET k v',
    'MIGRATE 127.0.0.1 1 k 0 100',
    'MIGRATE 127.0.0.1 1 "" 0 100 COPY KEYS nokey k',
    'MIGRATE 127.0.0.1 x k 0 100',
    'EXISTS k',
  ]),
  s('RESTORE-ASKING behaves like RESTORE', [
    `RESTORE-ASKING r 0 ${STRING_V}`,
    'GET r',
    `RESTORE-ASKING r 0 ${STRING_V}`,
    `RESTORE-ASKING r 0 ${STRING_V} REPLACE ABSTTL`,
    `RESTORE-ASKING r 99999999999999 ${STRING_V} REPLACE ABSTTL`,
    'EXPIRETIME r',
    'RESTORE-ASKING r2 0 garbage',
    'RESTORE-ASKING r',
  ]),
], ({ env }) => {
  it('MIGRATE across servers: oracle into redis-lite and redis-lite into the oracle', async () => {
    const lite = await RedisLite.start({ port: 0, save: '', dir: tempDir('redis-lite-migrate-') });
    const oracle = await DiffConnection.open(env().oracle.port);
    const local = await DiffConnection.open(lite.port);
    try {
      await oracle.call(['FLUSHALL']);
      const seed = [
        ['SET', 's', 'hello'],
        ['PEXPIRE', 's', '500000'],
        ['RPUSH', 'l', 'a', 'b', 'c'],
        ['HSET', 'h', 'f', 'v'],
        ['ZADD', 'z', '1', 'a', '2.5', 'b'],
        ['SADD', 'set', 'x', 'y'],
      ];
      for (const cmd of seed) {
        await oracle.call(cmd);
        await local.call(cmd);
      }
      const both = async (args: (port: number) => string[]): Promise<[string, string]> => [
        await oracle.call(args(lite.port), 10_000),
        await local.call(args(env().oracle.port), 10_000),
      ];
      const host = '127.0.0.1';
      // the targets hold the same keys: BUSYKEY from both sides
      let [a, b] = await both((p) => ['MIGRATE', host, String(p), '', '0', '5000', 'COPY', 'KEYS', 's', 'l']);
      expect(b).toBe(a);
      expect(a).toBe('-ERR Target instance replied with error: BUSYKEY Target key name already exists.\r\n');
      [a, b] = await both((p) => ['MIGRATE', host, String(p), '', '0', '5000', 'COPY', 'REPLACE', 'KEYS', 's', 'l', 'h', 'z', 'set', 'nokey']);
      expect(b).toBe(a);
      expect(a).toBe('+OK\r\n');
      // into another database, without COPY: the keys leave the source
      [a, b] = await both((p) => ['MIGRATE', host, String(p), '', '3', '5000', 'KEYS', 'h', 'z']);
      expect(b).toBe(a);
      expect(await local.call(['EXISTS', 'h', 'z'])).toBe(await oracle.call(['EXISTS', 'h', 'z']));
      for (const conn of [oracle, local]) {
        expect(await conn.call(['SELECT', '3'])).toBe('+OK\r\n');
        expect(await conn.call(['HGETALL', 'h'])).toBe('*2\r\n$1\r\nf\r\n$1\r\nv\r\n');
        expect(await conn.call(['ZRANGE', 'z', '0', '-1', 'WITHSCORES'])).toBe('*4\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n$3\r\n2.5\r\n');
        expect(await conn.call(['SELECT', '0'])).toBe('+OK\r\n');
        const ttl = Number((await conn.call(['PTTL', 's'])).slice(1, -2));
        expect(ttl).toBeGreaterThan(400_000);
      }
    } finally {
      oracle.close();
      local.close();
      await lite.close();
    }
  }, 60_000);
});
