import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OK, Status } from '@/libs/resp';

import { tempDir, harness, populate, logical, fcall } from './persistence.helpers';

describe('RDB', () => {
  it('SAVE then load at startup round-trips every type, TTLs, field TTLs and functions', async () => {
    const dir = tempDir();
    const a = await harness(dir);
    populate(a.run);
    expect(a.p.dirty).toBeGreaterThan(0);
    expect(a.p.saveCommand()).toBe(OK);
    expect(a.p.dirty).toBe(0);
    expect(existsSync(join(dir, 'dump.rdb'))).toBe(true);
    expect(readFileSync(join(dir, 'dump.rdb')).toString('latin1', 0, 9)).toBe('REDIS0012');
    expect(readdirSync(dir).filter((f) => f.startsWith('temp-'))).toEqual([]);

    const b = await harness(dir);
    const res = b.p.loadAtStartup();
    expect(res.source).toBe('rdb');
    expect(logical(b.server)).toEqual(logical(a.server));
    expect(fcall(b)).toBe('hi');
    // DUMP payloads (encodings included) match for non-stream keys.
    for (const key of ['str', 'bin', 'num', 'list', 'biglist', 'set', 'iset', 'zset', 'hash']) expect(b.run('DUMP', key)).toBe(a.run('DUMP', key));
    const total = a.server.databases.reduce((n, db) => n + db.keys().length, 0);
    expect(b.p.info()).toContain(`rdb_last_load_keys_loaded:${total}`);
  });

  it('skips keys that expired before loading and counts them', async () => {
    const dir = tempDir();
    const a = await harness(dir);
    a.run('SET', 'gone', 'x', 'PX', '30');
    a.run('SET', 'kept', 'y');
    a.p.save();
    await new Promise((r) => setTimeout(r, 60));
    const b = await harness(dir);
    expect(b.p.loadAtStartup()).toEqual({ source: 'rdb', keysLoaded: 1, keysExpired: 1 });
    expect(b.p.info()).toContain('rdb_last_load_keys_expired:1');
  });

  it('BGSAVE reports like Redis and finishes asynchronously', async () => {
    const dir = tempDir();
    const h = await harness(dir);
    h.run('SET', 'k', 'v');
    const reply = h.p.bgsaveCommand();
    expect(reply).toBeInstanceOf(Status);
    expect((reply as Status).value).toBe('Background saving started');
    expect(h.p.info()).toContain('rdb_bgsave_in_progress:1');
    expect(() => h.p.bgsaveCommand()).toThrow('ERR Background save already in progress');
    expect(() => h.p.saveCommand()).toThrow('ERR Background save already in progress');
    // BGREWRITEAOF while a BGSAVE runs is scheduled, then runs when it ends.
    expect((h.p.bgrewriteaofCommand() as Status).value).toBe('Background append only file rewriting scheduled');
    await h.p.waitForBackground();
    const info = h.p.info();
    expect(info).toContain('rdb_bgsave_in_progress:0');
    expect(info).toContain('rdb_last_bgsave_status:ok');
    expect(info).toContain('rdb_last_bgsave_time_sec:0');
    expect(info).toContain('rdb_saves:1');
    expect(info).toContain('aof_rewrites:1');
    expect(info).toContain('rdb_changes_since_last_save:0');
    expect(existsSync(join(dir, 'dump.rdb'))).toBe(true);
    expect((h.p.bgsaveCommand({ inExec: true }) as Status).value).toBe('Background saving scheduled');
  });

  it('save points trigger a BGSAVE from the cron', async () => {
    const dir = tempDir();
    const h = await harness(dir, { save: '1 2' });
    h.run('SET', 'a', '1');
    h.p.lastSave = Date.now() - 5000;
    h.p.cron();
    expect(h.p.bgsaveInProgress).toBe(false); // 1 change < 2
    h.run('SET', 'b', '2');
    h.p.cron();
    expect(h.p.bgsaveInProgress).toBe(true);
    await h.p.waitForBackground();
    expect(h.p.dirty).toBe(0);
    expect(h.p.lastsaveCommand()).toBe(Math.floor(Date.now() / 1000));
  });

  it('a failing BGSAVE sets the error status and MISCONF write denial', async () => {
    const dir = tempDir();
    const h = await harness(join(dir, 'missing', 'dir'), { save: '3600 1' });
    h.p.bgsaveCommand();
    await h.p.waitForBackground();
    expect(h.p.info()).toContain('rdb_last_bgsave_status:err');
    expect(h.p.writeDeniedError()).toMatch(/^MISCONF Redis is configured to save RDB snapshots/);
    h.server.config.set('stop-writes-on-bgsave-error', 'no');
    expect(h.p.writeDeniedError()).toBeNull();
  });

  it('DEBUG RELOAD saves, flushes and loads back', async () => {
    const dir = tempDir();
    const h = await harness(dir);
    populate(h.run);
    const before = logical(h.server);
    h.run('SET', 'str', 'changed-after');
    const expected = logical(h.server);
    expect(h.p.debugReload()).toBeInstanceOf(Status);
    expect(logical(h.server)).toEqual(expected);
    expect(logical(h.server)).not.toEqual(before);
    expect(fcall(h)).toBe('hi');
  });
});
