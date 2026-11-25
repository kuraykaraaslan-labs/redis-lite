import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

const t = useServer();

/** Error message of a rejected promise (fails the test if it resolves). */
async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected the command to fail');
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------
const LIB_A = "#!lua name=liba\nredis.register_function('fa_echo', function(keys, args) return {keys[1], args[1]} end)\nredis.register_function{function_name='fa_get', callback=function(keys, args) return redis.call('GET', keys[1]) end, flags={'no-writes'}, description='reads a key'}";

const LIB_B = "#!lua name=libb\nredis.register_function('fb_set', function(keys, args) return redis.call('SET', keys[1], args[1]) end)";

describe('FUNCTION LOAD', () => {
  it('loads a library and returns its name', async () => {
    await t.call('FUNCTION', 'FLUSH');
    expect(await t.call('FUNCTION', 'LOAD', LIB_A)).toBe('liba');
    expect(await t.call('FCALL', 'fa_echo', 1, 'fk', 'fv')).toEqual(['fk', 'fv']);
  });

  it('already exists without REPLACE; REPLACE swaps the functions', async () => {
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_A);
    expect(await errorOf(t.call('FUNCTION', 'LOAD', LIB_A))).toBe("ERR Library 'liba' already exists");
    const replacement = "#!lua name=liba\nredis.register_function('fa_new', function() return 'new' end)";
    expect(await t.call('FUNCTION', 'LOAD', 'REPLACE', replacement)).toBe('liba');
    expect(await t.call('FCALL', 'fa_new', 0)).toBe('new');
    expect(await errorOf(t.call('FCALL', 'fa_echo', 0))).toBe('ERR Function not found');
  });

  it('missing shebang', async () => {
    expect(await errorOf(t.call('FUNCTION', 'LOAD', "redis.register_function('x', function() return 1 end)"))).toBe('ERR Missing library metadata');
  });

  it('wrong engine', async () => {
    expect(await errorOf(t.call('FUNCTION', 'LOAD', "#!python name=py\nprint('x')"))).toBe("ERR Engine 'python' not found");
  });

  it('no library name', async () => {
    expect(await errorOf(t.call('FUNCTION', 'LOAD', "#!lua\nredis.register_function('x', function() return 1 end)"))).toBe('ERR Library name was not given');
  });

  it('invalid metadata', async () => {
    expect(await errorOf(t.call('FUNCTION', 'LOAD', "#!lua name=m foo=bar\nredis.register_function('x', function() return 1 end)"))).toBe('ERR Invalid metadata value given: foo=bar');
  });

  it('no functions registered', async () => {
    expect(await errorOf(t.call('FUNCTION', 'LOAD', '#!lua name=empty\nlocal x = 1'))).toBe('ERR No functions registered');
  });

  it('duplicate function across libraries fails atomically', async () => {
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_A);
    const dup = "#!lua name=libdup\nredis.register_function('dup_new', function() return 1 end)\nredis.register_function('fa_echo', function() return 2 end)";
    expect(await errorOf(t.call('FUNCTION', 'LOAD', dup))).toBe('ERR Function fa_echo already exists');
    expect(await errorOf(t.call('FCALL', 'dup_new', 0))).toBe('ERR Function not found');
    expect(await t.call('FUNCTION', 'LIST', 'LIBRARYNAME', 'libdup')).toEqual([]);
  });

  it('compile error', async () => {
    const msg = await errorOf(t.call('FUNCTION', 'LOAD', '#!lua name=broken\nreturn ('));
    // unverified: tail after the prefix
    expect(msg).toMatch(/^ERR Error compiling function/);
  });

  it('invalid function name', async () => {
    const msg = await errorOf(t.call('FUNCTION', 'LOAD', "#!lua name=badname\nredis.register_function('bad-name', function() return 1 end)"));
    expect(msg).toMatch(/Function names can only contain letters, numbers, or underscores\(_\) and must be at least one character long/);
  });

  it('unknown flag', async () => {
    const msg = await errorOf(t.call('FUNCTION', 'LOAD', "#!lua name=badflag\nredis.register_function{function_name='bf', callback=function() return 1 end, flags={'no-such-flag'}}"));
    expect(msg).toMatch(/unknown flag given/);
  });

  it('calling redis.call at load time is not allowed', async () => {
    const msg = await errorOf(t.call('FUNCTION', 'LOAD', "#!lua name=loadcall\nredis.call('PING')\nredis.register_function('lc', function() return 1 end)"));
    expect(msg).toMatch(/^ERR/);
    expect(await t.call('FUNCTION', 'LIST', 'LIBRARYNAME', 'loadcall')).toEqual([]);
  });
});

describe('FCALL / FCALL_RO', () => {
  it('keys and args, positional and table form', async () => {
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_A);
    await t.call('FUNCTION', 'LOAD', LIB_B);
    expect(await t.call('FCALL', 'fb_set', 1, 'fc:k', 'hello')).toBe('OK');
    expect(await t.call('FCALL', 'fa_get', 1, 'fc:k')).toBe('hello');
    expect(await t.call('FCALL_RO', 'fa_get', 1, 'fc:k')).toBe('hello');
  });

  it('FCALL_RO on a function without no-writes', async () => {
    expect(await errorOf(t.call('FCALL_RO', 'fb_set', 1, 'fc:k2', 'v'))).toBe('ERR Can not execute a script with write flag using *_ro command.');
    expect(await t.call('EXISTS', 'fc:k2')).toBe(0);
  });

  it('no-writes function attempting a write', async () => {
    await t.call('FUNCTION', 'LOAD', 'REPLACE', "#!lua name=libnw\nredis.register_function{function_name='nw_set', callback=function(keys) return redis.call('SET', keys[1], 'x') end, flags={'no-writes'}}");
    expect(await errorOf(t.call('FCALL', 'nw_set', 1, 'fc:nw'))).toMatch(/^ERR Write commands are not allowed from read-only scripts/);
  });

  it('unknown function and numkeys errors', async () => {
    expect(await errorOf(t.call('FCALL', 'no_such_fn', 0))).toBe('ERR Function not found');
    expect(await errorOf(t.call('FCALL', 'fa_echo', 2, 'a'))).toBe("ERR Number of keys can't be greater than number of args");
    expect(await errorOf(t.call('FCALL', 'fa_echo', -1))).toBe("ERR Number of keys can't be negative");
    expect(await errorOf(t.call('FCALL', 'fa_echo', 'x'))).toBe('ERR value is not an integer or out of range');
    expect(await errorOf(t.call('FCALL', 'fa_echo'))).toBe("ERR wrong number of arguments for 'fcall' command");
  });

  it('runtime error inside a function', async () => {
    await t.call('FUNCTION', 'LOAD', 'REPLACE', "#!lua name=liberr\nredis.register_function('fe_boom', function() error('kaboom') end)");
    expect(await errorOf(t.call('FCALL', 'fe_boom', 0))).toMatch(/kaboom/);
  });
});

describe('FUNCTION LIST / DELETE / FLUSH / STATS / KILL', () => {
  it('LIST shape, LIBRARYNAME filter and WITHCODE', async () => {
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_A);
    await t.call('FUNCTION', 'LOAD', LIB_B);
    const all = (await t.call('FUNCTION', 'LIST')) as unknown[][];
    expect(all).toHaveLength(2);
    const b = (await t.call('FUNCTION', 'LIST', 'LIBRARYNAME', 'libb')) as unknown[][];
    expect(b).toEqual([['library_name', 'libb', 'engine', 'LUA', 'functions', [['name', 'fb_set', 'description', null, 'flags', []]]]]);
    const a = (await t.call('FUNCTION', 'LIST', 'LIBRARYNAME', 'liba')) as unknown[][];
    expect(a).toHaveLength(1);
    const fns = a[0][5] as unknown[][];
    const byName = Object.fromEntries(fns.map((f) => [f[1], f]));
    expect(byName.fa_echo).toEqual(['name', 'fa_echo', 'description', null, 'flags', []]);
    expect(byName.fa_get).toEqual(['name', 'fa_get', 'description', 'reads a key', 'flags', ['no-writes']]);
    const withCode = (await t.call('FUNCTION', 'LIST', 'LIBRARYNAME', 'libb', 'WITHCODE')) as unknown[][];
    expect(withCode[0].slice(0, 6)).toEqual(['library_name', 'libb', 'engine', 'LUA', 'functions', [['name', 'fb_set', 'description', null, 'flags', []]]]);
    expect(withCode[0].slice(6)).toEqual(['library_code', LIB_B]);
    expect(await t.call('FUNCTION', 'LIST', 'LIBRARYNAME', 'lib*')).toHaveLength(2);
    expect(await t.call('FUNCTION', 'LIST', 'LIBRARYNAME', 'nomatch*')).toEqual([]);
  });

  it('DELETE', async () => {
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_B);
    expect(await t.call('FUNCTION', 'DELETE', 'libb')).toBe('OK');
    expect(await errorOf(t.call('FCALL', 'fb_set', 1, 'x', 'y'))).toBe('ERR Function not found');
    expect(await errorOf(t.call('FUNCTION', 'DELETE', 'libb'))).toBe('ERR Library not found');
  });

  it('FLUSH, FLUSH SYNC, FLUSH ASYNC', async () => {
    await t.call('FUNCTION', 'LOAD', 'REPLACE', LIB_A);
    expect(await t.call('FUNCTION', 'FLUSH')).toBe('OK');
    expect(await t.call('FUNCTION', 'LIST')).toEqual([]);
    await t.call('FUNCTION', 'LOAD', LIB_A);
    expect(await t.call('FUNCTION', 'FLUSH', 'SYNC')).toBe('OK');
    expect(await t.call('FUNCTION', 'LIST')).toEqual([]);
    await t.call('FUNCTION', 'LOAD', LIB_A);
    expect(await t.call('FUNCTION', 'FLUSH', 'ASYNC')).toBe('OK');
    expect(await t.call('FUNCTION', 'LIST')).toEqual([]);
  });

  it('STATS', async () => {
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_A);
    await t.call('FUNCTION', 'LOAD', LIB_B);
    expect(await t.call('FUNCTION', 'STATS')).toEqual(['running_script', null, 'engines', ['LUA', ['libraries_count', 2, 'functions_count', 3]]]);
  });

  it('STATS in RESP3 is a map', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    const out = await r.send('FUNCTION', 'STATS');
    expect(out).toBe('%2\r\n$14\r\nrunning_script\r\n_\r\n$7\r\nengines\r\n%1\r\n$3\r\nLUA\r\n%2\r\n$15\r\nlibraries_count\r\n:2\r\n$15\r\nfunctions_count\r\n:3\r\n');
  });

  it('KILL with nothing running', async () => {
    expect(await errorOf(t.call('FUNCTION', 'KILL'))).toBe('NOTBUSY No scripts in execution right now.');
  });

  it('unknown subcommand', async () => {
    expect(await errorOf(t.call('FUNCTION', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try FUNCTION HELP.");
  });
});

describe('FUNCTION DUMP / RESTORE', () => {
  const dump = async () => (await t.redis.callBuffer('FUNCTION', 'DUMP')) as Buffer;

  it('round trip after FLUSH (default APPEND)', async () => {
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_A);
    await t.call('FUNCTION', 'LOAD', LIB_B);
    const payload = await dump();
    const before = await t.call('FUNCTION', 'LIST', 'WITHCODE');
    await t.call('FUNCTION', 'FLUSH');
    expect(await t.call('FUNCTION', 'RESTORE', payload)).toBe('OK');
    const after = (await t.call('FUNCTION', 'LIST', 'WITHCODE')) as unknown[][];
    const sortByName = (l: unknown[][]) => [...l].sort((x, y) => String(x[1]).localeCompare(String(y[1])));
    expect(sortByName(after)).toEqual(sortByName(before as unknown[][]));
    expect(await t.call('FCALL', 'fa_echo', 1, 'k', 'v')).toEqual(['k', 'v']);
  });

  it('APPEND conflicts with an existing library', async () => {
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_A);
    const payload = await dump();
    expect(await errorOf(t.call('FUNCTION', 'RESTORE', payload))).toBe("ERR Library 'liba' already exists");
    expect(await errorOf(t.call('FUNCTION', 'RESTORE', payload, 'APPEND'))).toBe("ERR Library 'liba' already exists");
  });

  it('APPEND adds to other libraries', async () => {
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_A);
    const payload = await dump();
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_B);
    expect(await t.call('FUNCTION', 'RESTORE', payload, 'APPEND')).toBe('OK');
    expect(await t.call('FUNCTION', 'LIST')).toHaveLength(2);
  });

  it('REPLACE overwrites existing libraries', async () => {
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_A);
    const payload = await dump();
    await t.call('FUNCTION', 'LOAD', 'REPLACE', "#!lua name=liba\nredis.register_function('fa_other', function() return 'other' end)");
    expect(await t.call('FUNCTION', 'RESTORE', payload, 'REPLACE')).toBe('OK');
    expect(await t.call('FCALL', 'fa_echo', 1, 'k', 'v')).toEqual(['k', 'v']);
    expect(await errorOf(t.call('FCALL', 'fa_other', 0))).toBe('ERR Function not found');
  });

  it('FLUSH policy drops everything first', async () => {
    await t.call('FUNCTION', 'FLUSH');
    await t.call('FUNCTION', 'LOAD', LIB_A);
    const payload = await dump();
    await t.call('FUNCTION', 'LOAD', LIB_B);
    expect(await t.call('FUNCTION', 'RESTORE', payload, 'FLUSH')).toBe('OK');
    const list = (await t.call('FUNCTION', 'LIST')) as unknown[][];
    expect(list.map((l) => l[1])).toEqual(['liba']);
  });

  it('invalid payload and invalid policy', async () => {
    expect(await errorOf(t.call('FUNCTION', 'RESTORE', 'garbage'))).toBe('ERR payload version or checksum are wrong');
    const payload = await dump();
    // unverified: exact wording of the policy error
    expect(await errorOf(t.call('FUNCTION', 'RESTORE', payload, 'BOGUS'))).toMatch(/^ERR Wrong restore policy given/);
  });
});
