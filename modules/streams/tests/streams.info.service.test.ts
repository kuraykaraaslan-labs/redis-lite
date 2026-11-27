import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { arity, bulk, entry, err, expectOrderedFields, INVALID_ID, openResp3, toMap, WRONGTYPE } from './streams.test_helpers';

/**
 * XINFO, XSETID (streams.info.service).
 * Checked against the behaviour of Redis Open Source 8.8 (redis.io command docs, t_stream.c / pubsub.c reply and
 * error strings).
 */
const t = useServer();
const resp3 = () => openResp3(t);

// ============================================================================
// XINFO / XSETID
// ============================================================================
describe('XINFO', () => {
  it('STREAM radix-tree-nodes counts the nodes of the compressed trie of master ids', async () => {
    const counters = async (key: string): Promise<[unknown, unknown]> => {
      const m = toMap((await t.call('XINFO', 'STREAM', key)) as unknown[]);
      return [m['radix-tree-keys'], m['radix-tree-nodes']];
    };
    // values observed on Redis 7.0: head + shared prefix, a branch per diverging byte, a leaf per key
    for (let i = 1; i <= 250; i++) await t.call('XADD', 'xi:rax', `${i}-0`, 'f', 'v');
    expect(await counters('xi:rax')).toEqual([3, 8]);
    await t.call('XTRIM', 'xi:rax', 'MAXLEN', '~', '120');
    expect(await counters('xi:rax')).toEqual([2, 6]);
    await t.call('CONFIG', 'SET', 'stream-node-max-entries', '1');
    try {
      for (const id of ['1-0', '2-0', '65536-0']) await t.call('XADD', 'xi:rax2', id, 'f', 'v');
      expect(await counters('xi:rax2')).toEqual([3, 10]);
      await t.call('XDEL', 'xi:rax2', '2-0');
      expect(await counters('xi:rax2')).toEqual([2, 6]);
    } finally {
      await t.call('CONFIG', 'SET', 'stream-node-max-entries', '100');
    }
    await t.call('XADD', 'xi:rax3', 'MAXLEN', '0', '1-0', 'f', 'v');
    expect(await counters('xi:rax3')).toEqual([0, 1]);
  });

  it('STREAM fields, order and values', async () => {
    for (let i = 1; i <= 3; i++) await t.call('XADD', 'xi:s', `${i}-0`, 'f', String(i));
    await t.call('XDEL', 'xi:s', '2-0');
    await t.call('XGROUP', 'CREATE', 'xi:s', 'g', '0');
    const flat = (await t.call('XINFO', 'STREAM', 'xi:s')) as unknown[];
    expectOrderedFields(flat, [
      'length',
      'radix-tree-keys',
      'radix-tree-nodes',
      'last-generated-id',
      'max-deleted-entry-id',
      'entries-added',
      'recorded-first-entry-id',
      'groups',
      'first-entry',
      'last-entry',
    ]);
    const m = toMap(flat);
    expect(m.length).toBe(2);
    expect(m['radix-tree-keys']).toBe(1);
    expect(m['last-generated-id']).toBe('3-0');
    expect(m['max-deleted-entry-id']).toBe('2-0');
    expect(m['entries-added']).toBe(3);
    expect(m['recorded-first-entry-id']).toBe('1-0');
    expect(m.groups).toBe(1);
    expect(m['first-entry']).toEqual(['1-0', ['f', '1']]);
    expect(m['last-entry']).toEqual(['3-0', ['f', '3']]);
  });

  it('STREAM on an empty stream has nil first/last entry', async () => {
    await t.call('XGROUP', 'CREATE', 'xi:empty', 'g', '$', 'MKSTREAM');
    const m = toMap((await t.call('XINFO', 'STREAM', 'xi:empty')) as unknown[]);
    expect(m.length).toBe(0);
    expect(m['last-generated-id']).toBe('0-0');
    expect(m['entries-added']).toBe(0);
    expect(m['first-entry']).toBeNull();
    expect(m['last-entry']).toBeNull();
  });

  it('STREAM in RESP3 is a map', async () => {
    await t.call('XADD', 'xi:r3', '1-0', 'f', 'v');
    const c3 = await resp3();
    const out = await c3.send('XINFO', 'STREAM', 'xi:r3');
    expect(out.startsWith('%')).toBe(true);
    expect(out).toContain(`${bulk('length')}:1\r\n`);
    expect(out).toContain(`${bulk('first-entry')}${entry('1-0', 'f', 'v')}`);
    expect(out).toContain(`${bulk('last-generated-id')}${bulk('1-0')}`);
  });

  it('STREAM FULL', async () => {
    await t.call('XADD', 'xi:full', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xi:full', 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xi:full', '>');
    const m = toMap((await t.call('XINFO', 'STREAM', 'xi:full', 'FULL')) as unknown[]);
    expect(m.length).toBe(1);
    expect(m.entries).toEqual([['1-0', ['f', 'v']]]);
    const groups = m.groups as unknown[][];
    const g = toMap(groups[0]);
    expect(g.name).toBe('g');
    expect(g['last-delivered-id']).toBe('1-0');
    expect(g['entries-read']).toBe(1);
    expect(g.lag).toBe(0);
    expect(g['pel-count']).toBe(1);
  });

  it('GROUPS fields, entries-read and lag', async () => {
    for (let i = 1; i <= 3; i++) await t.call('XADD', 'xi:g', `${i}-0`, 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xi:g', 'g', '0');
    let flat = ((await t.call('XINFO', 'GROUPS', 'xi:g')) as unknown[][])[0];
    expect(flat.filter((_, i) => i % 2 === 0)).toEqual(['name', 'consumers', 'pending', 'last-delivered-id', 'entries-read', 'lag']);
    expect(flat).toEqual(['name', 'g', 'consumers', 0, 'pending', 0, 'last-delivered-id', '0-0', 'entries-read', null, 'lag', 3]);
    await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'COUNT', 2, 'STREAMS', 'xi:g', '>');
    flat = ((await t.call('XINFO', 'GROUPS', 'xi:g')) as unknown[][])[0];
    expect(flat).toEqual(['name', 'g', 'consumers', 1, 'pending', 2, 'last-delivered-id', '2-0', 'entries-read', 2, 'lag', 1]);
    await t.call('XADD', 'xi:g', '4-0', 'f', 'v');
    expect(toMap(((await t.call('XINFO', 'GROUPS', 'xi:g')) as unknown[][])[0]).lag).toBe(2);
    await t.call('XGROUP', 'CREATE', 'xi:g', 'g2', '$');
    const g2 = toMap(((await t.call('XINFO', 'GROUPS', 'xi:g')) as unknown[][])[1]);
    expect(g2['entries-read']).toBe(null); // `$` leaves the counter unknown in Redis 7.0
    expect(g2.lag).toBe(0);
  });

  it('CONSUMERS fields', async () => {
    await t.call('XADD', 'xi:c', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xi:c', 'g', '0');
    await t.call('XREADGROUP', 'GROUP', 'g', 'c1', 'STREAMS', 'xi:c', '>');
    await t.call('XGROUP', 'CREATECONSUMER', 'xi:c', 'g', 'c2');
    const cons = (await t.call('XINFO', 'CONSUMERS', 'xi:c', 'g')) as unknown[][];
    expect(cons).toHaveLength(2);
    expect(cons[0].filter((_, i) => i % 2 === 0)).toEqual(['name', 'pending', 'idle']);
    const c1 = toMap(cons[0]);
    expect(c1.name).toBe('c1');
    expect(c1.pending).toBe(1);
    expect(typeof c1.idle).toBe('number');
    const c2 = toMap(cons[1]);
    expect(c2.name).toBe('c2');
    expect(c2.pending).toBe(0);
  });

  it('GROUPS / CONSUMERS in RESP3 are arrays of maps', async () => {
    await t.call('XADD', 'xi:r3g', '1-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xi:r3g', 'g', '0');
    await t.call('XGROUP', 'CREATECONSUMER', 'xi:r3g', 'g', 'c');
    const c3 = await resp3();
    expect(await c3.send('XINFO', 'GROUPS', 'xi:r3g')).toBe(
      `*1\r\n%6\r\n${bulk('name')}${bulk('g')}${bulk('consumers')}:1\r\n${bulk('pending')}:0\r\n` +
        `${bulk('last-delivered-id')}${bulk('0-0')}${bulk('entries-read')}_\r\n${bulk('lag')}:1\r\n`,
    );
    const cons = await c3.send('XINFO', 'CONSUMERS', 'xi:r3g', 'g');
    expect(cons.startsWith(`*1\r\n%3\r\n${bulk('name')}${bulk('c')}${bulk('pending')}:0\r\n${bulk('idle')}:`)).toBe(true);
  });

  it('errors', async () => {
    expect.soft(await err(t.call('XINFO', 'STREAM', 'xi:none'))).toBe('ERR no such key');
    expect.soft(await err(t.call('XINFO', 'GROUPS', 'xi:none'))).toBe('ERR no such key');
    await t.call('XADD', 'xi:e', '1-0', 'f', 'v');
    expect.soft(await err(t.call('XINFO', 'CONSUMERS', 'xi:e', 'nog'))).toBe("NOGROUP No such consumer group 'nog' for key name 'xi:e'");
    expect.soft(await err(t.call('XINFO', 'FOO', 'xi:e'))).toBe("ERR unknown subcommand 'FOO'. Try XINFO HELP.");
    expect.soft(await err(t.call('XINFO', 'STREAM'))).toBe(arity('xinfo|stream'));
    await t.call('SET', 'xi:str', 'v');
    expect.soft(await err(t.call('XINFO', 'STREAM', 'xi:str'))).toBe(WRONGTYPE);
  });
});

describe('XSETID', () => {
  it('sets the last id and affects XADD', async () => {
    await t.call('XADD', 'xs:s', '1-0', 'f', 'v');
    expect(await t.call('XSETID', 'xs:s', '10-0')).toBe('OK');
    expect(toMap((await t.call('XINFO', 'STREAM', 'xs:s')) as unknown[])['last-generated-id']).toBe('10-0');
    expect.soft(await err(t.call('XADD', 'xs:s', '5-0', 'f', 'v'))).toBe(
      'ERR The ID specified in XADD is equal or smaller than the target stream top item',
    );
    expect(await t.call('XADD', 'xs:s', '10-*', 'f', 'v')).toBe('10-1');
  });

  it('ENTRIESADDED and MAXDELETEDID', async () => {
    await t.call('XADD', 'xs:o', '1-0', 'f', 'v');
    expect(await t.call('XSETID', 'xs:o', '5-0', 'ENTRIESADDED', 10, 'MAXDELETEDID', '3-0')).toBe('OK');
    const m = toMap((await t.call('XINFO', 'STREAM', 'xs:o')) as unknown[]);
    expect(m['entries-added']).toBe(10);
    expect(m['max-deleted-entry-id']).toBe('3-0');
    expect(m['last-generated-id']).toBe('5-0');
  });

  it('errors', async () => {
    await t.call('XADD', 'xs:e', '5-0', 'f', 'v');
    expect.soft(await err(t.call('XSETID', 'xs:e', '4-0'))).toBe('ERR The ID specified in XSETID is smaller than the target stream top item');
    expect.soft(await err(t.call('XSETID', 'xs:none', '1-0'))).toBe('ERR no such key');
    expect.soft(await err(t.call('XSETID', 'xs:e', 'bad'))).toBe(INVALID_ID);
    expect.soft(await err(t.call('XSETID', 'xs:e', '9-0', 'ENTRIESADDED', 0))).toBe(
      'ERR The entries_added specified in XSETID is smaller than the target stream length',
    );
    expect.soft(await err(t.call('XSETID', 'xs:e', '9-0', 'MAXDELETEDID', '10-0'))).toBe(
      'ERR The ID specified in XSETID is smaller than the provided max_deleted_entry_id',
    );
    expect.soft(await err(t.call('XSETID', 'xs:e'))).toBe(arity('xsetid'));
    await t.call('SET', 'xs:str', 'v');
    expect.soft(await err(t.call('XSETID', 'xs:str', '1-0'))).toBe(WRONGTYPE);
  });
});
