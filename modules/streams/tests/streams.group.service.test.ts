import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { arity, err, INVALID_ID, toMap, WRONGTYPE } from './streams.test_helpers';

/**
 * XGROUP (streams.group.service).
 * Checked against the behaviour of Redis Open Source 8.8 (redis.io command docs, t_stream.c / pubsub.c reply and
 * error strings).
 */
const t = useServer();

// ============================================================================
// XGROUP
// ============================================================================
describe('XGROUP', () => {
  it('CREATE on an existing stream, BUSYGROUP, $ and ids', async () => {
    await t.call('XADD', 'xg:s', '1-0', 'f', 'v');
    expect(await t.call('XGROUP', 'CREATE', 'xg:s', 'g1', '0')).toBe('OK');
    expect(await t.call('XGROUP', 'CREATE', 'xg:s', 'g2', '$')).toBe('OK');
    expect(await t.call('XGROUP', 'CREATE', 'xg:s', 'g3', '1-0')).toBe('OK');
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:s', 'g1', '0'))).toBe('BUSYGROUP Consumer Group name already exists');
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:s', 'g4', 'bad'))).toBe(INVALID_ID);
    const groups = (await t.call('XINFO', 'GROUPS', 'xg:s')) as unknown[][];
    expect(groups.map((g) => toMap(g).name)).toEqual(['g1', 'g2', 'g3']);
    expect(toMap(groups[1])['last-delivered-id']).toBe('1-0');
    expect(toMap(groups[0])['last-delivered-id']).toBe('0-0');
  });

  it('CREATE on a missing key needs MKSTREAM', async () => {
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:none', 'g', '$'))).toBe(
      'ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.',
    );
    expect(await t.call('XGROUP', 'CREATE', 'xg:mk', 'g', '$', 'MKSTREAM')).toBe('OK');
    expect(await t.call('EXISTS', 'xg:mk')).toBe(1);
    expect(await t.call('TYPE', 'xg:mk')).toBe('stream');
    expect(await t.call('XLEN', 'xg:mk')).toBe(0);
  });

  it('CREATE with ENTRIESREAD', async () => {
    for (let i = 1; i <= 5; i++) await t.call('XADD', 'xg:er', `${i}-0`, 'f', 'v');
    expect(await t.call('XGROUP', 'CREATE', 'xg:er', 'g', '2-0', 'ENTRIESREAD', 2)).toBe('OK');
    const g = toMap(((await t.call('XINFO', 'GROUPS', 'xg:er')) as unknown[][])[0]);
    expect(g['entries-read']).toBe(2);
    expect(g.lag).toBe(3);
  });

  it('SETID', async () => {
    for (let i = 1; i <= 3; i++) await t.call('XADD', 'xg:setid', `${i}-0`, 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xg:setid', 'g', '$');
    expect(await t.call('XGROUP', 'SETID', 'xg:setid', 'g', '0')).toBe('OK');
    const r = (await t.call('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'xg:setid', '>')) as Array<[string, Array<[string]>]>;
    expect(r[0][1].map((e) => e[0])).toEqual(['1-0', '2-0', '3-0']);
    expect(await t.call('XGROUP', 'SETID', 'xg:setid', 'g', '$')).toBe('OK');
    expect(await t.call('XGROUP', 'SETID', 'xg:setid', 'g', '1-0', 'ENTRIESREAD', 1)).toBe('OK');
    const g = toMap(((await t.call('XINFO', 'GROUPS', 'xg:setid')) as unknown[][])[0]);
    expect(g['last-delivered-id']).toBe('1-0');
    expect(g['entries-read']).toBe(1);
    expect(g.lag).toBe(2);
    expect.soft(await err(t.call('XGROUP', 'SETID', 'xg:setid', 'nog', '0'))).toBe("NOGROUP No such consumer group 'nog' for key name 'xg:setid'");
    expect.soft(await err(t.call('XGROUP', 'SETID', 'xg:nokey', 'g', '0'))).toBe(
      'ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.',
    );
  });

  it('CREATECONSUMER / DELCONSUMER / DESTROY', async () => {
    await t.call('XADD', 'xg:cons', '1-0', 'f', 'v');
    await t.call('XADD', 'xg:cons', '2-0', 'f', 'v');
    await t.call('XGROUP', 'CREATE', 'xg:cons', 'g', '0');
    expect(await t.call('XGROUP', 'CREATECONSUMER', 'xg:cons', 'g', 'alice')).toBe(1);
    expect(await t.call('XGROUP', 'CREATECONSUMER', 'xg:cons', 'g', 'alice')).toBe(0);
    await t.call('XREADGROUP', 'GROUP', 'g', 'bob', 'STREAMS', 'xg:cons', '>');
    const cons = (await t.call('XINFO', 'CONSUMERS', 'xg:cons', 'g')) as unknown[][];
    expect(cons.map((c) => [toMap(c).name, toMap(c).pending])).toEqual([
      ['alice', 0],
      ['bob', 2],
    ]);
    expect(await t.call('XGROUP', 'DELCONSUMER', 'xg:cons', 'g', 'bob')).toBe(2);
    expect(await t.call('XGROUP', 'DELCONSUMER', 'xg:cons', 'g', 'bob')).toBe(0);
    expect(await t.call('XGROUP', 'DELCONSUMER', 'xg:cons', 'g', 'alice')).toBe(0);
    expect(await t.call('XINFO', 'CONSUMERS', 'xg:cons', 'g')).toEqual([]);
    // the deleted consumer's pending entries are gone from the PEL
    expect((await t.call('XPENDING', 'xg:cons', 'g')) as unknown[]).toEqual([0, null, null, null]);
    expect.soft(await err(t.call('XGROUP', 'CREATECONSUMER', 'xg:cons', 'nog', 'x'))).toBe(
      "NOGROUP No such consumer group 'nog' for key name 'xg:cons'",
    );
    expect.soft(await err(t.call('XGROUP', 'DELCONSUMER', 'xg:cons', 'nog', 'x'))).toBe(
      "NOGROUP No such consumer group 'nog' for key name 'xg:cons'",
    );
    expect(await t.call('XGROUP', 'DESTROY', 'xg:cons', 'g')).toBe(1);
    expect(await t.call('XGROUP', 'DESTROY', 'xg:cons', 'g')).toBe(0);
    expect(await t.call('XINFO', 'GROUPS', 'xg:cons')).toEqual([]);
  });

  it('errors: unknown subcommand, arity, wrong type', async () => {
    await t.call('XADD', 'xg:e', '1-0', 'f', 'v');
    expect.soft(await err(t.call('XGROUP', 'FOO', 'xg:e'))).toBe("ERR unknown subcommand 'FOO'. Try XGROUP HELP.");
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:e', 'g'))).toBe(arity('xgroup|create'));
    expect.soft(await err(t.call('XGROUP', 'DESTROY', 'xg:e'))).toBe(arity('xgroup|destroy'));
    // unverified (fairly sure): addReplySubcommandSyntaxError text
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:e', 'g', '0', 'FOO'))).toBe(
      "ERR unknown subcommand or wrong number of arguments for 'CREATE'. Try XGROUP HELP.",
    );
    expect.soft(await err(t.call('XGROUP'))).toBe(arity('xgroup'));
    await t.call('SET', 'xg:str', 'v');
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:str', 'g', '$'))).toBe(WRONGTYPE);
    expect.soft(await err(t.call('XGROUP', 'CREATE', 'xg:str', 'g', '$', 'MKSTREAM'))).toBe(WRONGTYPE);
    expect(Array.isArray(await t.call('XGROUP', 'HELP'))).toBe(true);
  });
});
