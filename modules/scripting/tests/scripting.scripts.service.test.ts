import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type Redis from 'ioredis';

import { useServer } from '@/tests/helpers';

/** EVAL, EVALSHA (+ _RO) and SCRIPT, end to end. */

const t = useServer();

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** Error message of a rejected promise (fails the test if it resolves). */
async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected the command to fail');
}

const evalLua = (script: string, ...rest: Array<string | number | Buffer>) => t.call('EVAL', script, ...(rest.length ? rest : [0]));

// ---------------------------------------------------------------------------
// EVAL family
// ---------------------------------------------------------------------------
describe('EVAL / EVALSHA basics', () => {
  it('KEYS and ARGV (docs example)', async () => {
    expect(await t.call('EVAL', 'return {KEYS[1],KEYS[2],ARGV[1],ARGV[2]}', 2, 'key1', 'key2', 'first', 'second')).toEqual(['key1', 'key2', 'first', 'second']);
  });

  it('#KEYS and #ARGV', async () => {
    expect(await t.call('EVAL', 'return {#KEYS, #ARGV}', 1, 'a', 'b', 'c')).toEqual([1, 2]);
    expect(await t.call('EVAL', 'return {#KEYS, #ARGV}', 0)).toEqual([0, 0]);
  });

  it('numkeys errors', async () => {
    expect(await errorOf(t.call('EVAL', 'return 1', 2, 'a'))).toBe("ERR Number of keys can't be greater than number of args");
    expect(await errorOf(t.call('EVAL', 'return 1', -1))).toBe("ERR Number of keys can't be negative");
    expect(await errorOf(t.call('EVAL', 'return 1', 'abc'))).toBe('ERR value is not an integer or out of range');
    expect(await errorOf(t.call('EVALSHA', sha1('return 1'), 3, 'a'))).toMatch(/^(ERR Number of keys can't be greater than number of args|NOSCRIPT)/);
  });

  it('wrong number of arguments', async () => {
    expect(await errorOf(t.call('EVAL', 'return 1'))).toBe("ERR wrong number of arguments for 'eval' command");
    expect(await errorOf(t.call('EVALSHA', 'abc'))).toBe("ERR wrong number of arguments for 'evalsha' command");
  });

  it('EVAL caches the script so EVALSHA works afterwards', async () => {
    const script = 'return "cached-by-eval"';
    expect(await evalLua(script)).toBe('cached-by-eval');
    expect(await t.call('SCRIPT', 'EXISTS', sha1(script))).toEqual([1]);
    expect(await t.call('EVALSHA', sha1(script), 0)).toBe('cached-by-eval');
  });

  it('EVALSHA with unknown sha replies NOSCRIPT', async () => {
    expect(await errorOf(t.call('EVALSHA', 'ffffffffffffffffffffffffffffffffffffffff', 0))).toBe('NOSCRIPT No matching script. Please use EVAL.');
    expect(await errorOf(t.call('EVALSHA', 'tooshort', 0))).toBe('NOSCRIPT No matching script. Please use EVAL.');
  });

  it('redis.call writes data and reads it back', async () => {
    expect(await t.call('EVAL', "return redis.call('SET', KEYS[1], ARGV[1])", 1, 'ev:set', 'v1')).toBe('OK');
    expect(await t.call('GET', 'ev:set')).toBe('v1');
    expect(await t.call('EVAL', "return redis.call('GET', KEYS[1])", 1, 'ev:set')).toBe('v1');
  });
});

describe('EVAL_RO / EVALSHA_RO', () => {
  it('read-only commands work', async () => {
    await t.call('SET', 'ro:k', 'val');
    const script = "return redis.call('GET', KEYS[1])";
    expect(await t.call('EVAL_RO', script, 1, 'ro:k')).toBe('val');
    const sha = (await t.call('SCRIPT', 'LOAD', script)) as string;
    expect(await t.call('EVALSHA_RO', sha, 1, 'ro:k')).toBe('val');
  });

  it('write commands are rejected', async () => {
    const msg = await errorOf(t.call('EVAL_RO', "return redis.call('SET', KEYS[1], 'x')", 1, 'ro:w'));
    // unverified: exact suffix (script: <sha>, on @user_script:1.)
    expect(msg).toMatch(/^ERR Write commands are not allowed from read-only scripts/);
    expect(await t.call('EXISTS', 'ro:w')).toBe(0);
    const sha = (await t.call('SCRIPT', 'LOAD', "return redis.call('DEL', KEYS[1])")) as string;
    expect(await errorOf(t.call('EVALSHA_RO', sha, 1, 'ro:w'))).toMatch(/^ERR Write commands are not allowed from read-only scripts/);
  });

  it('EVALSHA_RO unknown sha', async () => {
    expect(await errorOf(t.call('EVALSHA_RO', 'ffffffffffffffffffffffffffffffffffffff00', 0))).toBe('NOSCRIPT No matching script. Please use EVAL.');
  });
});

describe('SCRIPT', () => {
  it('LOAD returns the sha1 of the body', async () => {
    const script = 'return 42';
    expect(await t.call('SCRIPT', 'LOAD', script)).toBe(sha1(script));
    expect(await t.call('EVALSHA', sha1(script), 0)).toBe(42);
  });

  it('LOAD with a compile error fails and caches nothing', async () => {
    const msg = await errorOf(t.call('SCRIPT', 'LOAD', 'return ('));
    expect(msg).toMatch(/^ERR Error compiling script/);
    expect(await t.call('SCRIPT', 'EXISTS', sha1('return ('))).toEqual([0]);
  });

  it('EXISTS returns 1/0 per sha', async () => {
    const sha = (await t.call('SCRIPT', 'LOAD', 'return "exists"')) as string;
    expect(await t.call('SCRIPT', 'EXISTS', sha, 'ffffffffffffffffffffffffffffffffffffffff', sha)).toEqual([1, 0, 1]);
  });

  it('FLUSH (default, SYNC, ASYNC) empties the cache', async () => {
    const sha = (await t.call('SCRIPT', 'LOAD', 'return "flushme"')) as string;
    expect(await t.call('SCRIPT', 'FLUSH')).toBe('OK');
    expect(await t.call('SCRIPT', 'EXISTS', sha)).toEqual([0]);
    expect(await errorOf(t.call('EVALSHA', sha, 0))).toBe('NOSCRIPT No matching script. Please use EVAL.');
    await t.call('SCRIPT', 'LOAD', 'return "flushme"');
    expect(await t.call('SCRIPT', 'FLUSH', 'SYNC')).toBe('OK');
    expect(await t.call('SCRIPT', 'EXISTS', sha)).toEqual([0]);
    await t.call('SCRIPT', 'LOAD', 'return "flushme"');
    expect(await t.call('SCRIPT', 'FLUSH', 'ASYNC')).toBe('OK');
    expect(await t.call('SCRIPT', 'EXISTS', sha)).toEqual([0]);
  });

  it('KILL with nothing running', async () => {
    expect(await errorOf(t.call('SCRIPT', 'KILL'))).toBe('NOTBUSY No scripts in execution right now.');
  });

  it('unknown subcommand', async () => {
    expect(await errorOf(t.call('SCRIPT', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try SCRIPT HELP.");
  });

  it('ioredis defineCommand falls back from EVALSHA to EVAL after NOSCRIPT', async () => {
    await t.call('SCRIPT', 'FLUSH');
    const r = t.client() as Redis & { echoKeyArg: (k: string, a: string) => Promise<unknown> };
    r.defineCommand('echoKeyArg', { numberOfKeys: 1, lua: 'return {KEYS[1], ARGV[1]}' });
    expect(await r.echoKeyArg('dc:k', 'dc:a')).toEqual(['dc:k', 'dc:a']);
    expect(await t.call('SCRIPT', 'EXISTS', sha1('return {KEYS[1], ARGV[1]}'))).toEqual([1]);
    expect(await r.echoKeyArg('dc:k2', 'dc:a2')).toEqual(['dc:k2', 'dc:a2']);
  });
});
