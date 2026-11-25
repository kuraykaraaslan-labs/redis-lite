import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import { RedisLite } from '../src/index';
import type { RedisLiteOptions } from '../src/index';
import { foldDirectives, readConfigFile } from '../src/server/conf-file';
import { hashFieldExpires } from '../src/commands/hashes';
import { LuaEngine } from '../src/lua/engine';
import type { Reply } from '../src/resp';
import { OK, RespError, RespSet, Status } from '../src/resp';
import { encodeAofCommand, formatAofManifest, formatG17, parseAofCommand, parseAofManifest, Persistence, snapshotToAof } from '../src/server/persistence';
import type { PropagatedOp } from '../src/server/propagate';
import { Propagator, propagate } from '../src/server/propagate';
import { RedisLiteServer } from '../src/server/server';
import { idToString } from '../src/store/stream';

const roots: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'redis-lite-persist-'));
  roots.push(d);
  return d;
}
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const FUNCTION_CODE = "#!lua name=mylib\nredis.register_function('myfunc', function(keys, args) return 'hi' end)";

interface Harness {
  server: RedisLiteServer;
  p: Persistence;
  /** Runs a command the way the wired server will: inside a propagation unit, recording the dirty delta. */
  run: (...argv: string[]) => Reply;
  /** Every unit the propagator emitted. */
  units: PropagatedOp[][];
}

async function harness(dir: string, cfg: Record<string, string> = {}): Promise<Harness> {
  const server = new RedisLiteServer({ port: 0, host: '127.0.0.1', databases: 16, logLevel: 'silent' });
  server.lua = await LuaEngine.create(server);
  server.config.set('dir', dir);
  for (const [k, v] of Object.entries(cfg)) server.config.set(k, v);
  const p = new Persistence(server);
  const units: PropagatedOp[][] = [];
  p.propagator.addSink((ops) => units.push([...ops]));
  const client = server.createInternalClient();
  const run = (...argv: string[]): Reply => {
    p.propagator.enter(argv[0]);
    const before = server.dirty;
    const r = server.execute(client, argv, { inScript: false, noBlock: true }) as Reply;
    p.markDirty(server.dirty - before);
    p.propagator.record(client.dbIndex, argv, r, server.dirty - before);
    p.propagator.exit();
    return r;
  };
  return { server, p, run, units };
}

function populate(run: Harness['run']): void {
  run('SET', 'str', 'hello');
  run('SET', 'bin', '\x00\xff\r\n\x80binary');
  run('SET', 'num', '12345');
  run('SET', 'ttl', 'v', 'PX', '1000000');
  run('RPUSH', 'list', 'a', 'b', 'c');
  run('RPUSH', 'biglist', ...Array.from({ length: 300 }, (_, i) => `item-${i}`));
  run('SADD', 'set', 'x', 'y', 'z');
  run('SADD', 'iset', '1', '2', '3');
  run('ZADD', 'zset', '1.5', 'a', '-2', 'b', 'inf', 'c', '0.1', 'd');
  run('HSET', 'hash', 'f1', 'v1', 'f2', 'v2', 'f3', 'v3');
  run('HPEXPIRE', 'hash', '1000000', 'FIELDS', '1', 'f1');
  run('PEXPIRE', 'list', '2000000');
  run('XADD', 'stream', '1-1', 'a', '1');
  run('XADD', 'stream', '2-1', 'b', '2');
  run('XADD', 'stream', '3-1', 'c', '3');
  run('XDEL', 'stream', '3-1');
  run('XGROUP', 'CREATE', 'stream', 'g', '0');
  run('XREADGROUP', 'GROUP', 'g', 'alice', 'COUNT', '1', 'STREAMS', 'stream', '>');
  run('XGROUP', 'CREATECONSUMER', 'stream', 'g', 'bob');
  run('SELECT', '3');
  run('SET', 'db3key', 'in-db-3');
  run('SELECT', '0');
  run('FUNCTION', 'LOAD', FUNCTION_CODE);
}

/** Dataset as plain data: values, TTLs, hash field TTLs, stream groups / PEL (not consumer seen/active times). */
function logical(server: RedisLiteServer): unknown {
  return server.databases.map((db) => {
    const out: Record<string, unknown> = {};
    for (const key of db.keys().sort()) {
      const v = db.peek(key);
      if (!v) continue;
      let value: unknown;
      switch (v.type) {
        case 'string':
          value = v.value;
          break;
        case 'list':
          value = [...v.value];
          break;
        case 'set':
          value = [...v.value].sort();
          break;
        case 'zset':
          value = v.value.entries.map((e) => [e.member, e.score]);
          break;
        case 'hash':
          value = { fields: [...v.value].sort(), ttl: [...(hashFieldExpires(v.value) ?? [])].sort() };
          break;
        case 'stream': {
          const s = v.value;
          value = {
            entries: s.entries.map((e) => [idToString(e.id), e.fields]),
            lastId: idToString(s.lastId),
            entriesAdded: s.entriesAdded,
            maxDeletedId: idToString(s.maxDeletedId),
            groups: [...s.groups.values()].map((g) => ({
              name: g.name,
              lastId: idToString(g.lastId),
              entriesRead: g.entriesRead,
              pending: [...g.pending.values()].map((p) => [idToString(p.id), p.consumer, p.deliveryTime, p.deliveryCount]),
              consumers: [...g.consumers.keys()].sort(),
            })),
          };
          break;
        }
      }
      out[key] = { type: v.type, value, expire: db.getExpire(key) ?? null };
    }
    return out;
  });
}

function fcall(h: Harness): Reply {
  return h.run('FCALL', 'myfunc', '0');
}

// ---------------------------------------------------------------------------------------------------------------

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

describe('AOF', () => {
  it('creates base + incr + manifest on start, appends RESP with SELECT, and replays', async () => {
    const dir = tempDir();
    const a = await harness(dir, { appendonly: 'yes' });
    expect(a.p.loadAtStartup().source).toBe('none');
    const aofDir = join(dir, 'appendonlydir');
    expect(readFileSync(join(aofDir, 'appendonly.aof.manifest'), 'latin1')).toBe(
      'file appendonly.aof.1.base.rdb seq 1 type b\nfile appendonly.aof.1.incr.aof seq 1 type i\n',
    );
    a.run('SET', 'str', 'hello');
    const incr = (): string => readFileSync(join(aofDir, 'appendonly.aof.1.incr.aof'), 'latin1');
    expect(incr()).toBe(encodeAofCommand(['SELECT', '0']) + encodeAofCommand(['SET', 'str', 'hello']));
    a.run('SET', 'nope', 'x', 'NX');
    a.run('SET', 'str', 'again', 'NX'); // no-op: not propagated
    a.run('GET', 'str');
    expect(incr().endsWith(encodeAofCommand(['SET', 'nope', 'x', 'NX']))).toBe(true);
    populate(a.run);
    a.run('SELECT', '3');
    a.run('INCRBYFLOAT', 'f', '1.5');
    a.run('SELECT', '0');
    expect(incr()).toContain(encodeAofCommand(['SELECT', '3']) + encodeAofCommand(['SET', 'db3key', 'in-db-3']));
    expect(a.p.info()).toContain('aof_enabled:1');
    a.p.stop();

    const b = await harness(dir, { appendonly: 'yes' });
    expect(b.p.loadAtStartup().source).toBe('aof');
    expect(logical(b.server)).toEqual(logical(a.server));
    expect(fcall(b)).toBe('hi');
    expect(b.p.dirty).toBe(0);
    b.p.stop();
  });

  it('loads a truncated last command / incomplete MULTI with aof-load-truncated and truncates the file', async () => {
    const dir = tempDir();
    const a = await harness(dir, { appendonly: 'yes' });
    a.p.loadAtStartup();
    a.run('SET', 'a', '1');
    a.p.stop();
    const incr = join(dir, 'appendonlydir', 'appendonly.aof.1.incr.aof');
    const good = statSync(incr).size;
    appendFileSync(incr, Buffer.from(encodeAofCommand(['MULTI']) + encodeAofCommand(['SET', 'b', '2']), 'latin1'));
    appendFileSync(incr, Buffer.from('*3\r\n$3\r\nSET\r\n$1\r\nc', 'latin1'));
    const b = await harness(dir, { appendonly: 'yes' });
    b.p.loadAtStartup();
    expect(b.run('GET', 'a')).toBe('1');
    expect(b.run('GET', 'b')).toBeNull();
    expect(statSync(incr).size).toBe(good);
    b.p.stop();
  });

  it('wraps multi-op units in MULTI/EXEC and replays them atomically', async () => {
    const dir = tempDir();
    const a = await harness(dir, { appendonly: 'yes' });
    a.p.loadAtStartup();
    a.run('SADD', 's', 'a', 'b', 'c', 'd', 'e');
    a.run('XADD', 'st', '1-1', 'f', 'v');
    a.run('XGROUP', 'CREATE', 'st', 'g', '0');
    a.run('XREADGROUP', 'GROUP', 'g', 'c1', 'STREAMS', 'st', '>');
    const last = a.units[a.units.length - 1].map((o) => o.argv[0]);
    expect(last).toEqual(['MULTI', 'XCLAIM', 'XGROUP', 'EXEC']);
    a.p.stop();
    const b = await harness(dir, { appendonly: 'yes' });
    b.p.loadAtStartup();
    expect(logical(b.server)).toEqual(logical(a.server));
    b.p.stop();
  });

  it('BGREWRITEAOF writes a new RDB-preamble base, a fresh incr file and removes the old files', async () => {
    const dir = tempDir();
    const a = await harness(dir, { appendonly: 'yes' });
    a.p.loadAtStartup();
    populate(a.run);
    expect((a.p.bgrewriteaofCommand() as Status).value).toBe('Background append only file rewriting started');
    const aofDir = join(dir, 'appendonlydir');
    expect(readFileSync(join(aofDir, 'appendonly.aof.manifest'), 'latin1')).toBe(
      'file appendonly.aof.2.base.rdb seq 2 type b\nfile appendonly.aof.2.incr.aof seq 2 type i\n',
    );
    expect(readdirSync(aofDir).sort()).toEqual(['appendonly.aof.2.base.rdb', 'appendonly.aof.2.incr.aof', 'appendonly.aof.manifest']);
    expect(readFileSync(join(aofDir, 'appendonly.aof.2.base.rdb')).toString('latin1', 0, 5)).toBe('REDIS');
    expect(readFileSync(join(aofDir, 'appendonly.aof.2.incr.aof')).length).toBe(0);
    a.run('SET', 'after', 'rewrite');
    a.run('PEXPIRE', 'str', '5000000');
    expect(a.p.info()).toContain('aof_rewrites:1');
    a.p.stop();

    const b = await harness(dir, { appendonly: 'yes' });
    expect(b.p.loadAtStartup().source).toBe('aof');
    expect(logical(b.server)).toEqual(logical(a.server));
    expect(fcall(b)).toBe('hi');
    b.p.stop();
  });

  it('BGREWRITEAOF with aof-use-rdb-preamble no writes a command base that replays to the same dataset', async () => {
    const dir = tempDir();
    const a = await harness(dir, { appendonly: 'yes', 'aof-use-rdb-preamble': 'no' });
    a.p.loadAtStartup();
    populate(a.run);
    a.run('SET', 'emptystream-src', 'x');
    a.run('XADD', 'es', '5-5', 'a', 'b');
    a.run('XDEL', 'es', '5-5');
    expect(a.p.rewriteAof()).toBe(true);
    const aofDir = join(dir, 'appendonlydir');
    const base = readFileSync(join(aofDir, 'appendonly.aof.2.base.aof'), 'latin1');
    expect(base.startsWith(encodeAofCommand(['FUNCTION', 'LOAD', FUNCTION_CODE]))).toBe(true);
    expect(base).toContain(encodeAofCommand(['XADD', 'es', 'MAXLEN', '0', '5-5', 'x', 'y']));
    a.p.stop();
    const b = await harness(dir, { appendonly: 'yes' });
    b.p.loadAtStartup();
    expect(logical(b.server)).toEqual(logical(a.server));
    b.p.stop();
  });

  it('CONFIG SET appendonly yes creates the AOF from the current dataset; no stops appending', async () => {
    const dir = tempDir();
    const a = await harness(dir);
    a.p.loadAtStartup();
    a.run('SET', 'before', '1');
    a.server.config.set('appendonly', 'yes');
    expect(a.p.onConfigChange('appendonly')).toBeNull();
    a.run('SET', 'during', '2');
    a.server.config.set('appendonly', 'no');
    a.p.onConfigChange('appendonly');
    a.run('SET', 'after', '3');
    expect(a.p.info()).toContain('aof_enabled:0');
    const b = await harness(dir, { appendonly: 'yes' });
    b.p.loadAtStartup();
    expect(b.run('GET', 'before')).toBe('1');
    expect(b.run('GET', 'during')).toBe('2');
    expect(b.run('GET', 'after')).toBeNull();
    b.p.stop();
  });

  it('upgrades a pre-7.0 single appendonly.aof into the AOF directory', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'appendonly.aof'), Buffer.from(encodeAofCommand(['SELECT', '0']) + encodeAofCommand(['SET', 'legacy', 'yes']), 'latin1'));
    const h = await harness(dir, { appendonly: 'yes' });
    expect(h.p.loadAtStartup().source).toBe('aof');
    expect(h.run('GET', 'legacy')).toBe('yes');
    expect(readFileSync(join(dir, 'appendonlydir', 'appendonly.aof.manifest'), 'latin1')).toBe(
      'file appendonly.aof seq 1 type b\nfile appendonly.aof.1.incr.aof seq 1 type i\n',
    );
    h.p.stop();
  });
});

describe('AOF helpers', () => {
  it('manifest parse / format round trip, quoted names', () => {
    const text = 'file "my file.aof" seq 1 type b\nfile appendonly.aof.1.incr.aof seq 1 type i\nfile appendonly.aof.2.incr.aof seq 2 type i\n';
    const m = parseAofManifest(text);
    expect(m.base?.name).toBe('my file.aof');
    expect(m.incr.map((i) => i.seq)).toEqual([1, 2]);
    expect(formatAofManifest(m)).toBe(text);
    expect(() => parseAofManifest('file x seq 1\n')).toThrow('Invalid AOF manifest file format');
  });

  it('RESP records and %.17g scores', () => {
    const rec = encodeAofCommand(['SET', 'k', 'a\r\nb']);
    expect(rec).toBe('*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$4\r\na\r\nb\r\n');
    expect(parseAofCommand(rec, 0)).toEqual({ argv: ['SET', 'k', 'a\r\nb'], next: rec.length });
    expect(parseAofCommand(rec.slice(0, -3), 0)).toEqual({ incomplete: true });
    expect(formatG17(1.5)).toBe('1.5');
    expect(formatG17(0.1)).toBe('0.10000000000000001');
    expect(formatG17(1e21)).toBe('1e+21');
    expect(formatG17(123)).toBe('123');
    expect(formatG17(-Infinity)).toBe('-inf');
    expect(formatG17(1e-5)).toBe('1.0000000000000001e-05');
    expect(snapshotToAof({ dbs: [], functions: [] })).toBe('');
  });
});

describe('propagate()', () => {
  async function setup(): Promise<Harness & { last: () => string[][] }> {
    const h = await harness(tempDir());
    return { ...h, last: () => (h.units.length ? h.units[h.units.length - 1].map((o) => o.argv) : []) };
  }

  it('relative expires become absolute', async () => {
    const h = await setup();
    const db = h.server.databases[0];
    h.run('SET', 'k', 'old');
    h.run('SET', 'k', 'v', 'EX', '100', 'GET');
    expect(h.last()).toEqual([['SET', 'k', 'v', 'PXAT', String(db.getExpire('k'))]]);
    h.run('SET', 'k2', 'v', 'PXAT', '99999999999999', 'NX');
    expect(h.last()).toEqual([['SET', 'k2', 'v', 'PXAT', '99999999999999', 'NX']]);
    h.run('SET', 'k3', 'old');
    h.run('SET', 'k3', 'v', 'GET');
    expect(h.last()).toEqual([['SET', 'k3', 'v']]);
    h.run('SETEX', 'k4', '10', 'val');
    expect(h.last()).toEqual([['SET', 'k4', 'val', 'PXAT', String(db.getExpire('k4'))]]);
    h.run('PSETEX', 'k4', '10000', 'val');
    expect(h.last()).toEqual([['SET', 'k4', 'val', 'PXAT', String(db.getExpire('k4'))]]);
    h.run('EXPIRE', 'k3', '100');
    expect(h.last()).toEqual([['PEXPIREAT', 'k3', String(db.getExpire('k3'))]]);
    h.run('expire', 'k3', '200', 'GT');
    expect(h.last()).toEqual([['PEXPIREAT', 'k3', String(db.getExpire('k3')), 'GT']]);
    h.run('EXPIREAT', 'k3', '99999999999');
    expect(h.last()).toEqual([['PEXPIREAT', 'k3', '99999999999000']]);
    h.run('GETEX', 'k3', 'PX', '5000');
    expect(h.last()).toEqual([['PEXPIREAT', 'k3', String(db.getExpire('k3'))]]);
    h.run('GETEX', 'k3', 'PERSIST');
    expect(h.last()).toEqual([['PERSIST', 'k3']]);
    h.run('EXPIRE', 'k3', '-1');
    expect(h.last()).toEqual([['DEL', 'k3']]);
    h.server.config.set('lazyfree-lazy-expire', 'yes');
    h.run('EXPIRE', 'k2', '0');
    expect(h.last()).toEqual([['UNLINK', 'k2']]);
  });

  it('non-deterministic and blocking commands are rewritten', async () => {
    const h = await setup();
    h.run('INCRBYFLOAT', 'f', '1.5');
    expect(h.last()).toEqual([['SET', 'f', '1.5', 'KEEPTTL']]);
    h.run('HINCRBYFLOAT', 'h', 'x', '2.5');
    expect(h.last()).toEqual([['HSET', 'h', 'x', '2.5']]);
    h.run('GETSET', 'f', '3');
    expect(h.last()).toEqual([['SET', 'f', '3']]);
    h.run('GETDEL', 'f');
    expect(h.last()).toEqual([['DEL', 'f']]);

    h.run('SADD', 's', 'a', 'b', 'c', 'd', 'e');
    const one = h.run('SPOP', 's');
    expect(h.last()).toEqual([['SREM', 's', one as string]]);
    const r2 = h.run('SPOP', 's', '2');
    const two = (r2 instanceof RespSet ? r2.items : (r2 as Reply[])) as string[];
    expect(h.last()).toEqual([['SREM', 's', ...two]]);
    h.run('SPOP', 's', '100');
    expect(h.last()).toEqual([['DEL', 's']]);

    h.run('RPUSH', 'l', '1', '2', '3', '4', '5');
    h.run('BLPOP', 'nothing', 'l', '0');
    expect(h.last()).toEqual([['LPOP', 'l']]);
    h.run('BRPOP', 'l', '0');
    expect(h.last()).toEqual([['RPOP', 'l']]);
    h.run('BLMOVE', 'l', 'l2', 'LEFT', 'RIGHT', '0');
    expect(h.last()).toEqual([['LMOVE', 'l', 'l2', 'LEFT', 'RIGHT']]);
    h.run('BRPOPLPUSH', 'l2', 'l', '0');
    expect(h.last()).toEqual([['RPOPLPUSH', 'l2', 'l']]);
    h.run('LMPOP', '1', 'l', 'RIGHT', 'COUNT', '2');
    expect(h.last()).toEqual([['RPOP', 'l', '2']]);
    h.run('BLMPOP', '0', '2', 'x', 'l', 'LEFT');
    expect(h.last()).toEqual([['LPOP', 'l', '1']]);

    h.run('ZADD', 'z', '1', 'a', '2', 'b', '3', 'c');
    h.run('BZPOPMIN', 'z', '0');
    expect(h.last()).toEqual([['ZPOPMIN', 'z']]);
    h.run('ZMPOP', '1', 'z', 'MAX', 'COUNT', '5');
    expect(h.last()).toEqual([['ZPOPMAX', 'z', '2']]);
  });

  it('no-op writes and reads propagate nothing', async () => {
    const h = await setup();
    h.run('SET', 'k', 'v');
    const n = h.units.length;
    h.run('SET', 'k', 'w', 'NX');
    h.run('DEL', 'missing');
    h.run('GET', 'k');
    h.run('EXPIRE', 'missing', '10');
    h.run('SREM', 'missing', 'a');
    h.run('LPOP', 'missing');
    expect(h.units.length).toBe(n);
  });

  it('streams: XADD ids, exact trimming, XREADGROUP → XCLAIM + SETID, XCLAIM', async () => {
    const h = await setup();
    const id = h.run('XADD', 's', '*', 'a', '1') as string;
    expect(h.last()).toEqual([['XADD', 's', id, 'a', '1']]);
    for (let i = 0; i < 5; i++) h.run('XADD', 's', '*', 'n', String(i));
    const id2 = h.run('XADD', 's', 'MAXLEN', '~', '2', 'LIMIT', '10', '*', 'b', '2') as string;
    const len = (h.server.databases[0].peek('s') as { type: 'stream'; value: { length: number } }).value.length;
    expect(h.last()).toEqual([['XADD', 's', 'MAXLEN', '=', String(len), id2, 'b', '2']]);
    h.run('XGROUP', 'CREATE', 's', 'g', '0');
    h.run('XREADGROUP', 'GROUP', 'g', 'c', 'COUNT', '2', 'STREAMS', 's', '>');
    const ops = h.last();
    expect(ops[0]).toEqual(['MULTI']);
    expect(ops[1].slice(0, 5)).toEqual(['XCLAIM', 's', 'g', 'c', '0']);
    expect(ops[1].slice(6)).toEqual(['TIME', ops[1][7], 'RETRYCOUNT', '1', 'FORCE', 'JUSTID', 'LASTID', ops[1][5]]);
    expect(ops[3][0]).toBe('XGROUP');
    expect(ops[3].slice(0, 3)).toEqual(['XGROUP', 'SETID', 's']);
    expect(ops[4]).toEqual(['EXEC']);
    // NOACK: only the SETID.
    h.run('XADD', 's', '*', 'z', '9');
    h.run('XREADGROUP', 'GROUP', 'g', 'c', 'NOACK', 'STREAMS', 's', '>');
    expect(h.last().map((a) => a[0])).toEqual(['XGROUP']);
    // History reads propagate nothing.
    const n = h.units.length;
    h.run('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 's', '0');
    expect(h.units.length).toBe(n);
  });

  it('RESTORE with a relative TTL becomes ABSTTL; hash field expires become HPEXPIREAT', async () => {
    const h = await setup();
    h.run('SET', 'src', 'v');
    const payload = h.run('DUMP', 'src') as string;
    h.run('RESTORE', 'dst', '50000', payload);
    expect(h.last()).toEqual([['RESTORE', 'dst', String(h.server.databases[0].getExpire('dst')), payload, 'ABSTTL']]);
    h.run('HSET', 'h', 'a', '1', 'b', '2');
    h.run('HEXPIRE', 'h', '100', 'NX', 'FIELDS', '2', 'a', 'nope');
    const at = hashFieldExpires((h.server.databases[0].peek('h') as { type: 'hash'; value: Map<string, string> }).value)?.get('a');
    expect(h.last()).toEqual([['HPEXPIREAT', 'h', String(at), 'NX', 'FIELDS', '2', 'a', 'nope']]);
  });

  it('FUNCTION LOAD and FLUSHALL are forced; PUBLISH goes to replicas only; EVAL itself is not propagated', async () => {
    const h = await setup();
    h.run('FUNCTION', 'LOAD', FUNCTION_CODE);
    expect(h.last()).toEqual([['FUNCTION', 'LOAD', FUNCTION_CODE]]);
    h.run('FLUSHALL');
    expect(h.last()).toEqual([['FLUSHALL']]);
    h.run('PUBLISH', 'ch', 'msg');
    expect(h.units[h.units.length - 1]).toEqual([{ db: 0, argv: ['PUBLISH', 'ch', 'msg'], target: 'repl' }]);
    expect(propagate(['EVAL', 'return 1', '0'], 1, { db: 0, database: h.server.databases[0] })).toEqual([]);
  });
});

describe('Propagator units', () => {
  function make(): { prop: Propagator; units: PropagatedOp[][]; server: RedisLiteServer } {
    const server = new RedisLiteServer({ port: 0, host: '127.0.0.1', databases: 16, logLevel: 'silent' });
    const prop = new Propagator({ databases: server.databases, config: server.config });
    const units: PropagatedOp[][] = [];
    prop.addSink((ops) => units.push([...ops]));
    return { prop, units, server };
  }

  it('EXEC / script bodies: one op bare, several wrapped in MULTI/EXEC, SELECT inside', () => {
    const { prop, units } = make();
    prop.enter('eval');
    prop.enter('set');
    prop.record(0, ['SET', 'a', '1'], 'OK', 1);
    prop.exit();
    prop.record(0, ['EVAL', '…', '0'], null, 1);
    prop.exit();
    expect(units).toEqual([[{ db: 0, argv: ['SET', 'a', '1'], target: 'all' }]]);

    prop.enter('exec');
    prop.enter('set');
    prop.record(0, ['SET', 'a', '1'], 'OK', 1);
    prop.exit();
    prop.enter('incr');
    prop.record(2, ['INCR', 'b'], 1, 1);
    prop.exit();
    prop.record(2, ['EXEC'], ['OK', 1], 2);
    prop.exit();
    expect(units[1].map((o) => [o.db, ...o.argv])).toEqual([[-1, 'MULTI'], [0, 'SET', 'a', '1'], [2, 'INCR', 'b'], [-1, 'EXEC']]);
  });

  it('expired keys: DEL/UNLINK immediately outside a unit, inside the unit otherwise; KEYS never wraps', () => {
    const { prop, units, server } = make();
    prop.expired(0, 'k');
    expect(units[0]).toEqual([{ db: 0, argv: ['DEL', 'k'], target: 'all' }]);
    server.config.set('lazyfree-lazy-expire', 'yes');
    prop.enter('set');
    prop.expired(0, 'x');
    prop.record(0, ['SET', 'x', '1'], 'OK', 1);
    prop.exit();
    expect(units[1].map((o) => o.argv[0])).toEqual(['MULTI', 'UNLINK', 'SET', 'EXEC']);
    prop.enter('keys');
    prop.expired(0, 'y');
    prop.expired(0, 'z');
    prop.exit();
    expect(units[2].map((o) => o.argv[0])).toEqual(['UNLINK', 'UNLINK']);
    prop.pause();
    prop.expired(0, 'q');
    prop.resume();
    expect(units.length).toBe(3);
  });

  it('errors and zero-dirty commands are not propagated', () => {
    const { prop, units } = make();
    prop.record(0, ['SET', 'a', '1'], new RespError('ERR x'), 1);
    prop.record(0, ['SET', 'a', '1'], 'OK', 0);
    expect(units).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The persistence engine wired into the server
// ---------------------------------------------------------------------------------------------------------------

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

async function withServer<T>(options: RedisLiteOptions, fn: (r: Redis, server: RedisLite) => Promise<T>): Promise<T> {
  const server = await RedisLite.start({ port: 0, logLevel: 'silent', ...options });
  const r = new Redis(server.url, { maxRetriesPerRequest: null, lazyConnect: false });
  try {
    return await fn(r, server);
  } finally {
    r.disconnect();
    await server.close();
  }
}

async function errMsg(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'no error';
}

const infoField = (text: string, name: string): string | undefined => new RegExp(`(?:^|\\r\\n)${name}:([^\\r]*)`).exec(text)?.[1];

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
