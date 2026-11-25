import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import Redis from 'ioredis';

import { RedisLite } from '@/index';
import { foldDirectives, readConfigFile } from '@/modules/server/server.conf_file';

import PersistenceService from '../persistence.service';
import { tempDir, asRoot, withServer, errMsg, infoField } from './persistence.helpers';

const { parseAofCommand } = PersistenceService;

describe('server wiring', () => {
  it('an embedded server without persistence options stays in memory', async () => {
    await withServer({}, async (r) => {
      expect(await r.config('GET', 'save')).toEqual(['save', '']);
      expect(await r.config('GET', 'appendonly')).toEqual(['appendonly', 'no']);
      expect(infoField(await r.info('persistence'), 'aof_enabled')).toBe('0');
    });
  });

  it('persistence options turn on Redis defaults (save points) for the rest; close() saves like SIGTERM', async () => {
    const dir = tempDir();
    await withServer({ dir }, async (r) => {
      expect(await r.config('GET', 'save')).toEqual(['save', '3600 1 300 100 60 10000']);
      expect(await r.config('GET', 'dir')).toEqual(['dir', dir]);
      await r.set('kept', 'by-close');
    });
    expect(existsSync(join(dir, 'dump.rdb'))).toBe(true);
    await withServer({ dir }, async (r) => {
      expect(await r.get('kept')).toBe('by-close');
      expect(infoField(await r.info('persistence'), 'rdb_last_load_keys_loaded')).toBe('1');
    });
  });

  it('SAVE / LASTSAVE / INFO persistence come from the engine; the RDB is loaded at startup', async () => {
    const dir = tempDir();
    await withServer({ dir, save: '' }, async (r) => {
      await r.set('a', '1');
      await r.rpush('l', 'x', 'y');
      let info = await r.info('persistence');
      expect(Number(infoField(info, 'rdb_changes_since_last_save'))).toBeGreaterThan(0);
      expect(await r.save()).toBe('OK');
      info = await r.info('persistence');
      expect(infoField(info, 'rdb_changes_since_last_save')).toBe('0');
      expect(infoField(info, 'rdb_saves')).toBe('1');
      expect(Math.abs(Number(await r.lastsave()) - Date.now() / 1000)).toBeLessThan(5);
      await r.set('after-save', 'lost');
    });
    // save '' and no SAVE before close: the last write is not on disk
    await withServer({ dir, save: '' }, async (r) => {
      expect(await r.get('a')).toBe('1');
      expect(await r.lrange('l', 0, -1)).toEqual(['x', 'y']);
      expect(await r.exists('after-save')).toBe(0);
    });
  });

  it('BGSAVE / BGSAVE SCHEDULE / BGREWRITEAOF replies', async () => {
    const dir = tempDir();
    await withServer({ dir, save: '' }, async (r, server) => {
      await r.set('k', 'v');
      expect(await r.call('BGSAVE')).toBe('Background saving started');
      expect(await errMsg(r.call('BGSAVE'))).toBe('ERR Background save already in progress');
      await server['server'].persistence.waitForBackground();
      expect(await r.call('BGSAVE', 'SCHEDULE')).toBe('Background saving started');
      await server['server'].persistence.waitForBackground();
      expect(await r.call('BGREWRITEAOF')).toBe('Background append only file rewriting started');
      expect(await r.multi().call('BGSAVE').exec()).toEqual([[null, 'Background saving scheduled']]);
      expect(await r.call('COMMAND', 'INFO', 'bgrewriteaof')).toEqual([
        ['bgrewriteaof', 1, ['admin', 'noscript', 'no_async_loading'], 0, 0, 0, ['@admin', '@slow', '@dangerous'], [], [], []],
      ]);
    });
  });

  it('appendonly: writes, served blocked pops and expirations reach the AOF and are replayed at startup', async () => {
    const dir = tempDir();
    await withServer({ dir, appendonly: true, save: '' }, async (r, server) => {
      const blocker = new Redis(server.url);
      const popped = blocker.blpop('queue', 0);
      await new Promise((res) => setTimeout(res, 30));
      await r.rpush('queue', 'job1', 'job2');
      expect(await popped).toEqual(['queue', 'job1']);
      blocker.disconnect();
      await r.set('ttl', 'v', 'PX', 30);
      await r.incrbyfloat('f', '1.5');
      await new Promise((res) => setTimeout(res, 60));
      expect(await r.get('ttl')).toBeNull();
      const aofDir = join(dir, 'appendonlydir');
      const incr = readdirSync(aofDir).find((f) => f.endsWith('.incr.aof')) as string;
      const text = readFileSync(join(aofDir, incr), 'latin1');
      // the served BLPOP is propagated as its non-blocking form, the expired key as a DEL
      expect(text).toContain('*2\r\n$4\r\nLPOP\r\n$5\r\nqueue\r\n');
      expect(text).toContain('*2\r\n$3\r\nDEL\r\n$3\r\nttl\r\n');
      expect(text).toContain('KEEPTTL');
    });
    await withServer({ dir, appendonly: true, save: '' }, async (r) => {
      expect(await r.lrange('queue', 0, -1)).toEqual(['job2']);
      expect(await r.get('f')).toBe('1.5');
      expect(await r.exists('ttl')).toBe(0);
      expect(infoField(await r.info('persistence'), 'aof_enabled')).toBe('1');
    });
  });

  it('MULTI/EXEC and scripts are written to the AOF as one MULTI … EXEC unit', async () => {
    const dir = tempDir();
    await withServer({ dir, appendonly: true, save: '' }, async (r) => {
      await r.multi().set('a', '1').incr('a').exec();
      await r.eval("redis.call('SET', KEYS[1], 'x'); redis.call('SET', KEYS[2], 'y')", 2, 'b', 'c');
      const aofDir = join(dir, 'appendonlydir');
      const incr = readdirSync(aofDir).find((f) => f.endsWith('.incr.aof')) as string;
      const cmds: string[] = [];
      const text = readFileSync(join(aofDir, incr), 'latin1');
      for (let pos = 0; pos < text.length; ) {
        const step = parseAofCommand(text, pos);
        if (!('argv' in step)) break;
        cmds.push(step.argv.join(' '));
        pos = step.next;
      }
      // commands are propagated as the client sent them (ioredis sends lowercase names); SELECT goes inside the MULTI
      expect(cmds.map((c) => c.toUpperCase())).toEqual(['MULTI', 'SELECT 0', 'SET A 1', 'INCR A', 'EXEC', 'MULTI', 'SET B X', 'SET C Y', 'EXEC']);
    });
  });

  it('SHUTDOWN options and errors', async () => {
    const dir = tempDir();
    await withServer({ dir, save: '' }, async (r) => {
      expect(await errMsg(r.call('SHUTDOWN', 'ABORT'))).toBe('ERR No shutdown in progress.');
      expect(await errMsg(r.call('SHUTDOWN', 'SAVE', 'NOSAVE'))).toBe('ERR syntax error');
      expect(await errMsg(r.call('SHUTDOWN', 'BOGUS'))).toBe('ERR syntax error');
      expect(await errMsg(r.call('SHUTDOWN', 'NOW', 'ABORT'))).toBe('ERR syntax error');
    });
    let closed = false;
    const server = await RedisLite.start({ port: 0, dir, save: '', logLevel: 'silent' });
    server.onClose(() => {
      closed = true;
    });
    const r = new Redis(server.url, { maxRetriesPerRequest: null, retryStrategy: () => null });
    await r.set('saved-by', 'shutdown-save');
    await r.call('SHUTDOWN', 'SAVE').catch(() => undefined);
    await new Promise((res) => setTimeout(res, 50));
    r.disconnect();
    expect(closed).toBe(true);
    await withServer({ dir, save: '' }, async (r2) => {
      expect(await r2.get('saved-by')).toBe('shutdown-save');
    });
  });

  it.skipIf(asRoot)('SHUTDOWN refuses when the final save fails, unless FORCE; MISCONF after a failed BGSAVE', async () => {
    const dir = tempDir();
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    await withServer({ dir, save: '3600 1' }, async (r, server) => {
      await r.set('k', 'v');
      await r.config('SET', 'dir', locked);
      chmodSync(locked, 0o500);
      try {
        expect(await errMsg(r.call('SHUTDOWN'))).toBe('ERR Errors trying to SHUTDOWN. Check logs.');
        expect(await r.ping()).toBe('PONG');
        expect(await r.call('BGSAVE')).toBe('Background saving started');
        await server['server'].persistence.waitForBackground();
        expect(infoField(await r.info('persistence'), 'rdb_last_bgsave_status')).toBe('err');
        expect(await errMsg(r.set('k', 'w'))).toMatch(/^MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist to disk\./);
        expect(await errMsg(r.ping())).toMatch(/^MISCONF /);
        expect(await r.get('k')).toBe('v');
        expect(await errMsg(r.eval("return redis.call('SET', 'k', 'x')", 0))).toMatch(/MISCONF /);
        await r.config('SET', 'stop-writes-on-bgsave-error', 'no');
        expect(await r.set('k', 'w')).toBe('OK');
        await r.config('SET', 'stop-writes-on-bgsave-error', 'yes');
      } finally {
        chmodSync(locked, 0o700);
      }
      await r.config('SET', 'dir', dir);
    });
  });

  it('CONFIG SET dir / appendonly: validation, side effects, and rollback when they fail', async () => {
    const dir = tempDir();
    await withServer({ dir, save: '' }, async (r) => {
      expect(await errMsg(r.config('SET', 'dir', join(dir, 'does-not-exist')))).toBe(
        "ERR CONFIG SET failed (possibly related to argument 'dir') - No such file or directory",
      );
      expect(await r.config('SET', 'appendonly', 'yes')).toBe('OK');
      expect(existsSync(join(dir, 'appendonlydir'))).toBe(true);
      expect(infoField(await r.info('persistence'), 'aof_enabled')).toBe('1');
      expect(await r.config('SET', 'appendonly', 'no')).toBe('OK');
      expect(infoField(await r.info('persistence'), 'aof_enabled')).toBe('0');
      expect(await r.config('GET', 'aof-load-truncated')).toEqual(['aof-load-truncated', 'yes']);
      expect(await r.config('GET', 'auto-aof-rewrite-percentage')).toEqual(['auto-aof-rewrite-percentage', '100']);
      expect(await r.config('GET', 'auto-aof-rewrite-min-size')).toEqual(['auto-aof-rewrite-min-size', '67108864']);
      if (!asRoot) {
        const locked = join(dir, 'ro');
        mkdirSync(locked);
        await r.config('SET', 'dir', locked);
        chmodSync(locked, 0o500);
        try {
          expect(await errMsg(r.config('SET', 'appendonly', 'yes'))).toBe(
            "ERR CONFIG SET failed (possibly related to argument 'appendonly') - Unable to turn on AOF. Check server logs.",
          );
          expect(await r.config('GET', 'appendonly')).toEqual(['appendonly', 'no']);
        } finally {
          chmodSync(locked, 0o700);
        }
      }
    });
  });

  it('DEBUG RELOAD / DEBUG LOADAOF go through the engine', async () => {
    const dir = tempDir();
    await withServer({ dir, save: '', appendonly: true }, async (r) => {
      await r.hset('h', 'f', 'v');
      expect(await r.call('DEBUG', 'RELOAD')).toBe('OK');
      expect(await r.hgetall('h')).toEqual({ f: 'v' });
      expect(await errMsg(r.call('DEBUG', 'RELOAD', 'BOGUS'))).toBe('ERR DEBUG RELOAD only supports the MERGE, NOFLUSH and NOSAVE options.');
      await r.set('s', '1');
      expect(await r.call('DEBUG', 'LOADAOF')).toBe('OK');
      expect(await r.get('s')).toBe('1');
    });
  });

  it('FLUSHALL saves at once when save points are configured', async () => {
    const dir = tempDir();
    await withServer({ dir, save: '3600 1' }, async (r) => {
      await r.set('x', '1');
      await r.flushall();
      expect(existsSync(join(dir, 'dump.rdb'))).toBe(true);
      expect(infoField(await r.info('persistence'), 'rdb_saves')).toBe('1');
    });
  });

  it('listen() rejects when the data files cannot be loaded', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'dump.rdb'), 'this is not an RDB file');
    await expect(RedisLite.start({ port: 0, dir, logLevel: 'silent' })).rejects.toThrow();
  });

  it('startup config values are validated like CONFIG SET', async () => {
    await withServer({ config: { 'hash-max-listpack-entries': '1', 'notify-keyspace-events': 'KEA' } }, async (r) => {
      expect(await r.config('GET', 'hash-max-listpack-entries')).toEqual(['hash-max-listpack-entries', '1']);
      expect(await r.config('GET', 'notify-keyspace-events')).toEqual(['notify-keyspace-events', 'AKE']);
    });
    await expect(RedisLite.start({ port: 0, config: { 'no-such-config': '1' } })).rejects.toThrow(/no-such-config/);
    await expect(RedisLite.start({ port: 0, config: { maxmemory: 'lots' } })).rejects.toThrow(/memory value/);
    await expect(RedisLite.start({ port: 0, dir: '/definitely/not/here' })).rejects.toThrow(/No such file or directory/);
  });

  it('SET … GET on a missing key stores the value, so it invalidates WATCH', async () => {
    await withServer({}, async (r, server) => {
      const other = new Redis(server.url);
      await r.watch('w');
      expect(await other.set('w', 'v', 'GET')).toBeNull();
      expect(await r.multi().get('w').exec()).toBeNull();
      // and SET … NX GET on an existing key stores nothing
      await r.watch('w');
      expect(await other.set('w', 'z', 'NX', 'GET')).toBe('v');
      expect(await r.multi().get('w').exec()).toEqual([[null, 'v']]);
      other.disconnect();
    });
  });
});

describe('redis.conf', () => {
  it('reads directives, quoted arguments and includes; save lines accumulate, save "" resets', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'extra.conf'), '# included\nmaxmemory-policy allkeys-lru\n');
    writeFileSync(
      join(dir, 'redis.conf'),
      [
        '# comment',
        'port 7777',
        '',
        'save 900 1',
        'save 300 10',
        'requirepass "with space"',
        `include ${join(dir, 'extra.conf')}`,
        "dbfilename 'my dump.rdb'",
        'unknown-directive yes',
      ].join('\n'),
    );
    const directives = readConfigFile(join(dir, 'redis.conf'));
    const { values, unknown } = foldDirectives(directives, (n) => n !== 'unknown-directive');
    expect(Object.fromEntries(values)).toEqual({
      port: '7777',
      save: '900 1 300 10',
      requirepass: 'with space',
      'maxmemory-policy': 'allkeys-lru',
      dbfilename: 'my dump.rdb',
    });
    expect(unknown.map((d) => [d.name, d.line])).toEqual([['unknown-directive', 9]]);
    writeFileSync(join(dir, 'reset.conf'), 'save 900 1\nsave ""\n');
    expect(foldDirectives(readConfigFile(join(dir, 'reset.conf')), () => true).values.get('save')).toBe('');
    writeFileSync(join(dir, 'bad.conf'), 'port "unterminated\n');
    expect(() => readConfigFile(join(dir, 'bad.conf'))).toThrow(/FATAL CONFIG FILE ERROR[\s\S]*at line 1/);
  });
});
