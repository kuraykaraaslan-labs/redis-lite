import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';

import { arity, err, INVALID_ID, NOT_INT, openResp3, toMap, WRONGTYPE } from './streams.test_helpers';

/**
 * XACK, XPENDING, XCLAIM, XAUTOCLAIM (streams.pending.service).
 * Checked against the behaviour of Redis Open Source 8.8 (redis.io command docs, t_stream.c / pubsub.c reply and
 * error strings).
 */
const t = useServer();
const resp3 = () => openResp3(t);

// ============================================================================
// XACK / XPENDING
// ============================================================================
describe('XACK', () => {
  it('acknowledges pending ids', async () => {
    for (let i = 1; i <= 3; i++) await t.call('XADD', 'xack:s', `${i}-0`, 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xack:s', 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xack:s', '>');
    expect(await t.call('XACK', 'xack:s', 'g', '1-0')).toBe(1);
    expect(await t.call('XACK', 'xack:s', 'g', '1-0', '2-0', '3-0', '9-0')).toBe(2);
    expect(await t.call('XACK', 'xack:s', 'g', '1-0')).toBe(0);
    expect(await t.call('XACK', 'xack:s', 'nog', '1-0')).toBe(0);
    expect(await t.call('XACK', 'xack:none', 'g', '1-0')).toBe(0);
    expect((await t.call('XPENDING', 'xack:s', 'g') as unknown[])[0]).toBe(0);
  });

  it('errors', async () => {
    await t.call('XADD', 'xack:e', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xack:e', 'g', '0');
    expect.soft(await err(t.call('XACK', 'xack:e', 'g', 'bad'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XACK', 'xack:e', 'g'))).toBe(arity('xack'));
    await t.call('SET', 'xack:str', 'v');
    expect.soft(await err(t.call('XACK', 'xack:str', 'g', '1-0'))).toBe(WRONGTYPE);
  });
});

describe('XPENDING', () => {
  const k = 'xp:s';
  const setup = async () => {
    if ((await t.call('EXISTS', k)) === 1) return;
    for (let i = 1; i <= 5; i++) await t.call('XADD', k, `${i}-0`, 'f', 'v');
    await t.call('XGROUP', 'CREATE', k, 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'alice', 'COUNT', 2, 'STREAMS', k, '>');
    await t.call('XREADGROUP', 'GROUP', 'g', 'bob', 'COUNT', 3, 'STREAMS', k, '>');
  };

  it('summary form', async () => {
    await setup();
    expect(await t.call('XPENDING', k, 'g')).toEqual([5, '1-0', '5-0', [['alice', '2'], ['bob', '3']]]);
  });

  it('summary of an empty group (RESP2 and RESP3)', async () => {
    await t.call('XGROUP', 'CREATE', 'xp:empty', 'g', '$', 'MKSTREAM');
    expect(await t.call('XPENDING', 'xp:empty', 'g')).toEqual([0, null, null, null]);
    const c2 = await t.raw();
    expect(await c2.send('XPENDING', 'xp:empty', 'g')).toBe('*4\r\n:0\r\n$-1\r\n$-1\r\n*-1\r\n');
    const c3 = await resp3();
    expect(await c3.send('XPENDING', 'xp:empty', 'g')).toBe('*4\r\n:0\r\n_\r\n_\r\n_\r\n');
  });

  it('extended form, COUNT, consumer filter, ranges', async () => {
    await setup();
    const all = (await t.call('XPENDING', k, 'g', '-', '+', 10)) as Array<[string, string, number, number]>;
    expect(all.map((e) => [e[0], e[1], e[3]])).toEqual([
      ['1-0', 'alice', 1],
      ['2-0', 'alice', 1],
      ['3-0', 'bob', 1],
      ['4-0', 'bob', 1],
      ['5-0', 'bob', 1],
    ]);
    for (const e of all) {
      expect(typeof e[2]).toBe('number');
      expect(e[2]).toBeGreaterThanOrEqual(0);
    }
    expect(((await t.call('XPENDING', k, 'g', '-', '+', 2)) as unknown[]).length).toBe(2);
    expect(((await t.call('XPENDING', k, 'g', '-', '+', 10, 'bob')) as Array<[string]>).map((e) => e[0])).toEqual(['3-0', '4-0', '5-0']);
    expect(((await t.call('XPENDING', k, 'g', '2', '4', 10)) as Array<[string]>).map((e) => e[0])).toEqual(['2-0', '3-0', '4-0']);
    expect(((await t.call('XPENDING', k, 'g', '(2-0', '+', 10)) as Array<[string]>).map((e) => e[0])).toEqual(['3-0', '4-0', '5-0']);
    expect(await t.call('XPENDING', k, 'g', '-', '+', 10, 'nobody')).toEqual([]);
    expect(await t.call('XPENDING', k, 'g', '-', '+', 0)).toEqual([]);
  });

  it('IDLE filter', async () => {
    await setup();
    expect(await t.call('XPENDING', k, 'g', 'IDLE', 100000, '-', '+', 10)).toEqual([]);
    await sleep(30);
    expect(((await t.call('XPENDING', k, 'g', 'IDLE', 20, '-', '+', 10, 'alice')) as unknown[]).length).toBe(2);
  });

  it('errors', async () => {
    await setup();
    expect.soft(await err(t.call('XPENDING', k, 'nog'))).toBe("NOGROUP No such key 'xp:s' or consumer group 'nog'");
    expect.soft(await err(t.call('XPENDING', 'xp:missing', 'g'))).toBe("NOGROUP No such key 'xp:missing' or consumer group 'g'");
    expect.soft(await err(t.call('XPENDING', k, 'g', '-', '+'))).toBe('ERR syntax error');
    expect.soft(await err(t.call('XPENDING', k, 'g', '-', '+', 'x'))).toBe(NOT_INT);
    expect.soft(await err(t.call('XPENDING', k, 'g', 'bad', '+', 10))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XPENDING', k))).toBe(arity('xpending'));
    await t.call('SET', 'xp:str', 'v');
    expect.soft(await err(t.call('XPENDING', 'xp:str', 'g'))).toBe(WRONGTYPE);
  });
});

// ============================================================================
// XCLAIM / XAUTOCLAIM
// ============================================================================
describe('XCLAIM', () => {
  const prep = async (key: string, n = 3) => {
    for (let i = 1; i <= n; i++) await t.call('XADD', key, `${i}-0`, 'f', String(i));
    await t.call('XGROUP', 'CREATE', key, 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'alice', 'STREAMS', key, '>');
  };
  const pending = async (key: string) => (await t.call('XPENDING', key, 'g', '-', '+', 100)) as Array<[string, string, number, number]>;

  it('claims idle entries and increments deliveries', async () => {
    await prep('xc:s');
    await sleep(20);
    expect(await t.call('XCLAIM', 'xc:s', 'g', 'bob', 10, '1-0', '2-0')).toEqual([
      ['1-0', ['f', '1']],
      ['2-0', ['f', '2']],
    ]);
    const p = await pending('xc:s');
    expect(p.map((e) => [e[0], e[1], e[3]])).toEqual([
      ['1-0', 'bob', 2],
      ['2-0', 'bob', 2],
      ['3-0', 'alice', 1],
    ]);
    expect(p[0][2]).toBeLessThan(20); // idle reset on claim
  });

  it('min-idle-time not reached: nothing claimed', async () => {
    await prep('xc:fresh');
    expect(await t.call('XCLAIM', 'xc:fresh', 'g', 'bob', 1_000_000, '1-0')).toEqual([]);
    expect((await pending('xc:fresh'))[0][1]).toBe('alice');
  });

  it('JUSTID returns ids and does not increment deliveries', async () => {
    await prep('xc:jid');
    expect(await t.call('XCLAIM', 'xc:jid', 'g', 'bob', 0, '1-0', '3-0', 'JUSTID')).toEqual(['1-0', '3-0']);
    const p = await pending('xc:jid');
    expect(p.map((e) => [e[0], e[1], e[3]])).toEqual([
      ['1-0', 'bob', 1],
      ['2-0', 'alice', 1],
      ['3-0', 'bob', 1],
    ]);
  });

  it('IDLE, TIME, RETRYCOUNT', async () => {
    await prep('xc:opts');
    await t.call('XCLAIM', 'xc:opts', 'g', 'bob', 0, '1-0', 'IDLE', 50000, 'RETRYCOUNT', 7);
    let p = await pending('xc:opts');
    expect(p[0][1]).toBe('bob');
    expect(p[0][2]).toBeGreaterThanOrEqual(50000);
    expect(p[0][2]).toBeLessThan(55000);
    expect(p[0][3]).toBe(7);
    await t.call('XCLAIM', 'xc:opts', 'g', 'carol', 0, '2-0', 'TIME', Date.now() - 30000, 'JUSTID');
    p = await pending('xc:opts');
    expect(p[1][1]).toBe('carol');
    expect(p[1][2]).toBeGreaterThanOrEqual(30000);
    expect(p[1][2]).toBeLessThan(35000);
    expect(p[1][3]).toBe(1);
  });

  it('FORCE creates a PEL entry for an existing but unpending id', async () => {
    for (let i = 1; i <= 3; i++) await t.call('XADD', 'xc:force', `${i}-0`, 'f', String(i));
    await t.call('XGROUP', 'CREATE', 'xc:force', 'g', '$');
    expect(await t.call('XCLAIM', 'xc:force', 'g', 'bob', 0, '2-0')).toEqual([]);
    expect(await t.call('XCLAIM', 'xc:force', 'g', 'bob', 0, '2-0', 'FORCE')).toEqual([['2-0', ['f', '2']]]);
    // FORCE on an id not in the stream does nothing
    expect(await t.call('XCLAIM', 'xc:force', 'g', 'bob', 0, '9-0', 'FORCE')).toEqual([]);
    const p = await pending('xc:force');
    expect(p.map((e) => [e[0], e[1]])).toEqual([['2-0', 'bob']]);
  });

  it('LASTID advances the group last id', async () => {
    await prep('xc:lastid');
    await t.call('XGROUP', 'SETID', 'xc:lastid', 'g', '1-0');
    await t.call('XCLAIM', 'xc:lastid', 'g', 'bob', 0, '1-0', 'LASTID', '3-0');
    expect(toMap(((await t.call('XINFO', 'GROUPS', 'xc:lastid')) as unknown[][])[0])['last-delivered-id']).toBe('3-0');
    // a smaller LASTID does not move it back
    await t.call('XCLAIM', 'xc:lastid', 'g', 'bob', 0, '1-0', 'LASTID', '2-0');
    expect(toMap(((await t.call('XINFO', 'GROUPS', 'xc:lastid')) as unknown[][])[0])['last-delivered-id']).toBe('3-0');
  });

  it('deleted entries are dropped from the PEL and not returned', async () => {
    await prep('xc:del');
    await t.call('XDEL', 'xc:del', '2-0');
    expect(await t.call('XCLAIM', 'xc:del', 'g', 'bob', 0, '1-0', '2-0', '3-0')).toEqual([
      ['1-0', ['f', '1']],
      ['3-0', ['f', '3']],
    ]);
    expect((await pending('xc:del')).map((e) => e[0])).toEqual(['1-0', '3-0']);
  });

  it('creates the claiming consumer', async () => {
    await prep('xc:newc');
    await t.call('XCLAIM', 'xc:newc', 'g', 'zed', 0, '1-0');
    const names = ((await t.call('XINFO', 'CONSUMERS', 'xc:newc', 'g')) as unknown[][]).map((c) => toMap(c).name);
    expect(names).toEqual(['alice', 'zed']);
  });

  it('errors', async () => {
    await prep('xc:e');
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'nog', 'bob', 0, '1-0'))).toBe("NOGROUP No such key 'xc:e' or consumer group 'nog'");
    expect.soft(await err(t.call('XCLAIM', 'xc:missing', 'g', 'bob', 0, '1-0'))).toBe(
      "NOGROUP No such key 'xc:missing' or consumer group 'g'",
    );
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 'x', '1-0'))).toBe('ERR Invalid min-idle-time argument for XCLAIM');
    // ids are parsed until the first non-id, which is then treated as an option
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 0, 'bad'))).toBe("ERR Unrecognized XCLAIM option 'bad'");
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 0, '1-0', 'IDLE', 'x'))).toBe('ERR Invalid IDLE option argument for XCLAIM');
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 0, '1-0', 'TIME', 'x'))).toBe('ERR Invalid TIME option argument for XCLAIM');
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 0, '1-0', 'RETRYCOUNT', 'x'))).toBe(
      'ERR Invalid RETRYCOUNT option argument for XCLAIM',
    );
    expect.soft(await err(t.call('XCLAIM', 'xc:e', 'g', 'bob', 0))).toBe(arity('xclaim'));
    await t.call('SET', 'xc:str', 'v');
    expect.soft(await err(t.call('XCLAIM', 'xc:str', 'g', 'bob', 0, '1-0'))).toBe(WRONGTYPE);
  });
});

describe('XAUTOCLAIM', () => {
  const prep = async (key: string, n: number) => {
    for (let i = 1; i <= n; i++) await t.call('XADD', key, `${i}-0`, 'f', String(i));
    await t.call('XGROUP', 'CREATE', key, 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'alice', 'STREAMS', key, '>');
  };

  it('claims everything with cursor 0-0', async () => {
    await prep('xac:s', 2);
    expect(await t.call('XAUTOCLAIM', 'xac:s', 'g', 'bob', 0, '0-0')).toEqual([
      '0-0',
      [
        ['1-0', ['f', '1']],
        ['2-0', ['f', '2']],
      ],
      [],
    ]);
    const p = (await t.call('XPENDING', 'xac:s', 'g', '-', '+', 10)) as Array<[string, string, number, number]>;
    expect(p.map((e) => [e[1], e[3]])).toEqual([
      ['bob', 2],
      ['bob', 2],
    ]);
  });

  it('COUNT and cursor iteration', async () => {
    await prep('xac:cur', 5);
    expect(await t.call('XAUTOCLAIM', 'xac:cur', 'g', 'bob', 0, '0', 'COUNT', 2)).toEqual([
      '3-0',
      [
        ['1-0', ['f', '1']],
        ['2-0', ['f', '2']],
      ],
      [],
    ]);
    expect(await t.call('XAUTOCLAIM', 'xac:cur', 'g', 'bob', 0, '3-0', 'COUNT', 2, 'JUSTID')).toEqual(['5-0', ['3-0', '4-0'], []]);
    expect(await t.call('XAUTOCLAIM', 'xac:cur', 'g', 'bob', 0, '5-0', 'COUNT', 2, 'JUSTID')).toEqual(['0-0', ['5-0'], []]);
    // JUSTID did not bump deliveries
    const p = (await t.call('XPENDING', 'xac:cur', 'g', '-', '+', 10)) as Array<[string, string, number, number]>;
    expect(p.map((e) => e[3])).toEqual([2, 2, 1, 1, 1]);
  });

  it('min-idle-time filters', async () => {
    await prep('xac:idle', 2);
    expect(await t.call('XAUTOCLAIM', 'xac:idle', 'g', 'bob', 1_000_000, '0')).toEqual(['0-0', [], []]);
  });

  it('deleted entries are reported and removed from the PEL', async () => {
    await prep('xac:del', 3);
    await t.call('XDEL', 'xac:del', '1-0', '3-0');
    expect(await t.call('XAUTOCLAIM', 'xac:del', 'g', 'bob', 0, '0')).toEqual(['0-0', [['2-0', ['f', '2']]], ['1-0', '3-0']]);
    expect(((await t.call('XPENDING', 'xac:del', 'g')) as unknown[])[0]).toBe(1);
  });

  it('errors', async () => {
    await prep('xac:e', 1);
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:e', 'nog', 'bob', 0, '0'))).toBe("NOGROUP No such key 'xac:e' or consumer group 'nog'");
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:e', 'g', 'bob', 0, '0', 'COUNT', 0))).toBe(
      'ERR COUNT must be > 0',
    );
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:e', 'g', 'bob', 0, 'bad'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:e', 'g', 'bob', 0, '0', 'FOO'))).toBe('ERR syntax error');
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:e', 'g', 'bob', 0))).toBe(arity('xautoclaim'));
    await t.call('SET', 'xac:str', 'v');
    expect.soft(await err(t.call('XAUTOCLAIM', 'xac:str', 'g', 'bob', 0, '0'))).toBe(WRONGTYPE);
  });
});
