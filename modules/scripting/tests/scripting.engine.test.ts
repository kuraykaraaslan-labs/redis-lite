import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

/** The Lua engine: runtime and compile errors, the sandbox, binary safety and atomicity. */

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

describe('Lua runtime and compile errors', () => {
  it('compile error text', async () => {
    const msg = await errorOf(evalLua('return ('));
    // unverified: tail of the message (user_script:1: unexpected symbol near '<eof>')
    expect(msg).toMatch(/^ERR Error compiling script/);
    expect(msg).toContain('user_script:1:');
  });

  it('runtime error text', async () => {
    const msg = await errorOf(evalLua("error('boom')"));
    // unverified: Redis 7+ appends " script: <sha>, on @user_script:1."
    expect(msg).toMatch(/^ERR user_script:1: boom/);
  });

  it('arithmetic on nil', async () => {
    const msg = await errorOf(evalLua('local x = nil; return x + 1'));
    expect(msg).toMatch(/^ERR user_script:1: attempt to perform arithmetic on/);
  });

  it('accessing an undefined global', async () => {
    const msg = await errorOf(evalLua('return nosuchglobal'));
    expect(msg).toMatch(/Script attempted to access nonexistent global variable 'nosuchglobal'/);
  });

  it('creating a global is rejected', async () => {
    const msg = await errorOf(evalLua('myglobal = 1; return 1'));
    // unverified: Redis 7+ says "Attempt to modify a readonly table"
    expect(msg).toMatch(/^ERR/);
  });
});
describe('sandbox', () => {
  const absent = (expr: string) => `local ok, v = pcall(function() return ${expr} end); if ok and v ~= nil then return 'present' end; return 'absent'`;

  it('io, os.execute, require, dofile, loadfile are not available', async () => {
    for (const e of ['io', 'os.execute', 'require', 'dofile', 'loadfile', 'os.exit', 'os.getenv']) {
      expect(await evalLua(absent(e)), e).toBe('absent');
    }
  });

  it('os is not available (Redis 7.0)', async () => {
    expect(await errorOf(evalLua('return type(os)'))).toMatch(/nonexistent global variable 'os'/);
  });

  it('standard libraries that are loaded', async () => {
    expect(await evalLua('return {type(string.sub), type(math.floor), type(table.insert), type(cjson), type(cmsgpack), type(bit), type(struct)}')).toEqual(['function', 'function', 'function', 'table', 'table', 'table', 'table']);
  });
});

describe('binary safety and atomicity', () => {
  it('binary arguments and return values', async () => {
    const bin = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x41]);
    const out = (await t.redis.callBuffer('EVAL', 'return ARGV[1]', '0', bin)) as Buffer;
    expect(Buffer.compare(out, bin)).toBe(0);
    await t.redis.callBuffer('EVAL', "return redis.call('SET', KEYS[1], ARGV[1])", '1', 'bin:k', bin);
    expect(Buffer.compare((await t.redis.getBuffer('bin:k')) as Buffer, bin)).toBe(0);
    expect(await t.call('EVAL', 'return #ARGV[1]', 0, bin)).toBe(6);
    const built = (await t.redis.callBuffer('EVAL', 'return string.char(0, 255, 1)', '0')) as Buffer;
    expect([...built]).toEqual([0, 255, 1]);
  });

  it('scripts are atomic', async () => {
    await t.call('DEL', 'atom:k');
    const script = "redis.call('SET', KEYS[1], 'intermediate'); local x = 0; for i = 1, 300000 do x = x + i end; redis.call('SET', KEYS[1], 'final'); return 1";
    const other = t.client();
    const p = t.call('EVAL', script, 1, 'atom:k');
    const reads = await Promise.all([other.get('atom:k'), other.get('atom:k'), other.get('atom:k')]);
    await p;
    for (const r of reads) expect(r === null || r === 'final').toBe(true);
    expect(await t.call('GET', 'atom:k')).toBe('final');
  });

  it('effects of a failing script before the error are kept (no rollback)', async () => {
    await t.call('DEL', 'atom:partial');
    await errorOf(t.call('EVAL', "redis.call('SET', KEYS[1], 'x'); error('boom')", 1, 'atom:partial'));
    expect(await t.call('GET', 'atom:partial')).toBe('x');
  });
});
