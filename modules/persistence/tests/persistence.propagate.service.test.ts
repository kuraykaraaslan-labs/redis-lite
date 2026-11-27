import { describe, expect, it } from 'vitest';

import type { Reply } from '@/libs/resp';
import { RespSet } from '@/libs/resp';

import PersistenceService from '../persistence.service';
import { tempDir, FUNCTION_CODE, harness } from './persistence.helpers';
import type { Harness } from './persistence.helpers';

const { propagate } = PersistenceService;

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

  it('RESTORE with a relative TTL becomes ABSTTL', async () => {
    const h = await setup();
    h.run('SET', 'src', 'v');
    const payload = h.run('DUMP', 'src') as string;
    h.run('RESTORE', 'dst', '50000', payload);
    expect(h.last()).toEqual([['RESTORE', 'dst', String(h.server.databases[0].getExpire('dst')), payload, 'ABSTTL']]);
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
