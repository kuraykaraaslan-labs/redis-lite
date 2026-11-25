import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

/** redis.call / redis.pcall: how command errors reach the script. */

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

const evalLua = (script: string, ...rest: Array<string | number | Buffer>) => t.call('EVAL', script, ...(rest.length ? rest : [0]));

describe('redis.call vs redis.pcall errors', () => {
  it('redis.call raises and the script fails with the command error', async () => {
    await t.call('SET', 'ce:str', 'abc');
    const msg = await errorOf(t.call('EVAL', "return redis.call('INCR', KEYS[1])", 1, 'ce:str'));
    // unverified: Redis appends " script: <sha>, on @user_script:1."
    expect(msg).toMatch(/^ERR value is not an integer or out of range/);
  });

  it('wrong type error from redis.call', async () => {
    await t.call('DEL', 'ce:list');
    await t.call('RPUSH', 'ce:list', 'x');
    const msg = await errorOf(t.call('EVAL', "return redis.call('GET', KEYS[1])", 1, 'ce:list'));
    expect(msg).toMatch(/^WRONGTYPE Operation against a key holding the wrong kind of value/);
  });

  it('script continues after redis.pcall error', async () => {
    await t.call('SET', 'ce:str3', 'abc');
    expect(await t.call('EVAL', "redis.pcall('INCR', KEYS[1]); return 'after'", 1, 'ce:str3')).toBe('after');
  });

  it('Lua pcall around redis.call catches the error', async () => {
    await t.call('SET', 'ce:str4', 'abc');
    expect(await t.call('EVAL', "local ok = pcall(redis.call, 'INCR', KEYS[1]); return tostring(ok)", 1, 'ce:str4')).toBe('false');
  });

  it('unknown command from a script', async () => {
    const msg = await errorOf(evalLua("return redis.call('nosuchcommand')"));
    // Redis 7+ uses the regular command lookup error inside scripts
    expect(msg).toMatch(/^ERR unknown command 'nosuchcommand', with args beginning with:/);
  });

  it('wrong arity from a script', async () => {
    const msg = await errorOf(evalLua("return redis.call('GET')"));
    // Redis 7+ uses the regular arity error inside scripts
    expect(msg).toMatch(/^ERR wrong number of arguments for 'get' command/);
  });

  it('redis.call with no arguments', async () => {
    const msg = await errorOf(evalLua('return redis.call()'));
    expect(msg).toMatch(/Please specify at least one argument for this redis lib call/);
  });

  it('commands not allowed from scripts', async () => {
    for (const c of ["redis.call('SUBSCRIBE', 'ch')", "redis.call('MULTI')", "redis.call('EVAL', 'return 1', 0)"]) {
      const msg = await errorOf(evalLua(`return ${c}`));
      expect(msg).toMatch(/^ERR This Redis command is not allowed from script/);
    }
  });
});
