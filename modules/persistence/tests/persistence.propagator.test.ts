import { describe, expect, it } from 'vitest';

import { OK, RespError } from '@/libs/resp';

import { RedisLiteServer } from '@/modules/server/server.core';

import { Propagator } from '../persistence.propagator';
import type { PropagatedOp } from '../persistence.types';

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
