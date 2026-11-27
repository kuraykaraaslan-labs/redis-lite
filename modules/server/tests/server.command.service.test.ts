import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

import { errOf, errOrValue, pairs } from './server.test_helpers';

/**
 * COMMAND.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

describe('COMMAND', () => {
  it('COUNT matches the length of COMMAND', async () => {
    const count = (await t.call('COMMAND', 'COUNT')) as number;
    expect.soft(count).toBeGreaterThan(200);
    const all = (await t.call('COMMAND')) as unknown[];
    expect.soft(all).toHaveLength(count);
  });

  it('LIST and FILTERBY', async () => {
    const list = (await t.call('COMMAND', 'LIST')) as string[];
    expect.soft(list).toContain('get');
    expect.soft(list).toContain('client');
    const xa = (await t.call('COMMAND', 'LIST', 'FILTERBY', 'PATTERN', 'xa*')) as string[];
    expect.soft(xa).toEqual(expect.arrayContaining(['xack', 'xadd', 'xautoclaim']));
    expect.soft(xa.every((n) => n.startsWith('xa'))).toBe(true);
    const hll = (await t.call('COMMAND', 'LIST', 'FILTERBY', 'ACLCAT', 'hyperloglog')) as string[];
    expect.soft(hll).toEqual(expect.arrayContaining(['pfadd', 'pfcount', 'pfmerge']));
    expect.soft(await t.call('COMMAND', 'LIST', 'FILTERBY', 'MODULE', 'nosuchmodule')).toEqual([]);
    expect.soft(await errOf(t.call('COMMAND', 'LIST', 'FILTERBY', 'FOO', 'x'))).toBe('ERR syntax error');
  });

  it('INFO for GET', async () => {
    const [info] = (await t.call('COMMAND', 'INFO', 'get')) as unknown[][];
    expect.soft(info.slice(0, 7)).toEqual(['get', 2, ['readonly', 'fast'], 1, 1, 1, ['@read', '@string', '@fast']]);
    expect.soft(info[7]).toEqual([]);
    expect.soft(info[8]).toEqual([
      ['flags', ['RO', 'access'], 'begin_search', ['type', 'index', 'spec', ['index', 1]], 'find_keys', ['type', 'range', 'spec', ['lastkey', 0, 'keystep', 1, 'limit', 0]]],
    ]);
    expect.soft(info[9]).toEqual([]);
  });

  it('INFO uses status replies for flags and categories', async () => {
    const r = await t.raw();
    const reply = await r.send('COMMAND', 'INFO', 'get');
    expect.soft(reply.startsWith('*1\r\n*10\r\n$3\r\nget\r\n:2\r\n*2\r\n+readonly\r\n+fast\r\n:1\r\n:1\r\n:1\r\n*3\r\n+@read\r\n+@string\r\n+@fast\r\n')).toBe(true);
  });

  it('INFO for several commands, unknown ones are null, case-insensitive', async () => {
    const res = (await t.call('COMMAND', 'INFO', 'GET', 'nosuchcmd', 'set')) as unknown[];
    expect.soft(res).toHaveLength(3);
    expect.soft((res[0] as unknown[])[0]).toBe('get');
    expect.soft(res[1]).toBeNull();
    expect.soft((res[2] as unknown[]).slice(0, 2)).toEqual(['set', -3]);
  });

  it('INFO for a container command lists subcommands', async () => {
    const [info] = (await t.call('COMMAND', 'INFO', 'config')) as unknown[][];
    expect.soft(info[0]).toBe('config');
    expect.soft(info[1]).toBe(-2);
    const subs = (info[9] as unknown[][]).map((s) => s[0]);
    expect.soft(subs).toEqual(expect.arrayContaining(['config|get', 'config|set', 'config|resetstat']));
    const [sub] = (await t.call('COMMAND', 'INFO', 'config|get')) as unknown[][];
    expect.soft(sub.slice(0, 2)).toEqual(['config|get', -3]);
  });

  it('GETKEYS and GETKEYSANDFLAGS', async () => {
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'SET', 'a', 'b'))).toEqual(['a']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'MSET', 'a', '1', 'b', '2'))).toEqual(['a', 'b']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'EVAL', 'return 1', '2', 'k1', 'k2', 'arg'))).toEqual(['k1', 'k2']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'ZUNIONSTORE', 'dst', '2', 's1', 's2'))).toEqual(['dst', 's1', 's2']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYSANDFLAGS', 'GET', 'k'))).toEqual([['k', ['RO', 'access']]]);
    // Redis 7.0: COMMAND GETKEYS needs at least one argument after the command name (arity -4)
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS', 'PING'))).toBe("ERR wrong number of arguments for 'command|getkeys' command");
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS', 'PING', 'x'))).toBe('ERR The command has no key arguments');
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS', 'NOSUCH', 'a'))).toBe('ERR Invalid command specified');
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS', 'GET', 'a', 'b'))).toBe('ERR Invalid number of arguments specified for command');
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS'))).toBe("ERR wrong number of arguments for 'command|getkeys' command");
  });

  it('DOCS for GET', async () => {
    const res = (await t.call('COMMAND', 'DOCS', 'get')) as unknown[];
    expect.soft(res[0]).toBe('get');
    const doc = pairs(res[1]);
    expect.soft(doc.summary).toBe('Get the value of a key');
    expect.soft(doc.since).toBe('1.0.0');
    expect.soft(doc.group).toBe('string');
    expect.soft(doc.complexity).toBe('O(1)');
    const args = (doc.arguments as unknown[][]).map(pairs);
    expect.soft(args[0]).toMatchObject({ name: 'key', type: 'key', key_spec_index: 0 });
    expect.soft(await t.call('COMMAND', 'DOCS', 'nosuchcmd')).toEqual([]);
  });

  it('DOCS in RESP3 is a map', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft((await r.send('COMMAND', 'DOCS', 'get')).startsWith('%1\r\n$3\r\nget\r\n%')).toBe(true);
  });

  it('unknown subcommand', async () => {
    expect.soft(await errOf(t.call('COMMAND', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try COMMAND HELP.");
  });
});
