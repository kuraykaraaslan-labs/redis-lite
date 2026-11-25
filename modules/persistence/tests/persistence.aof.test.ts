import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Status } from '@/libs/resp';

import PersistenceService from '../persistence.service';
import { tempDir, FUNCTION_CODE, harness, populate, logical, fcall } from './persistence.helpers';

const { encodeAofCommand } = PersistenceService;

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
