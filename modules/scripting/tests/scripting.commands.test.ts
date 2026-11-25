import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type Redis from 'ioredis';

import { useServer } from '@/tests/helpers';

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

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------
describe('Lua -> Redis conversion', () => {
  it('numbers: integers and float truncation', async () => {
    expect(await evalLua('return 10')).toBe(10);
    expect(await evalLua('return 3.99')).toBe(3);
    expect(await evalLua('return -3.99')).toBe(-3);
    expect(await evalLua('return 0.5')).toBe(0);
    expect(await evalLua('return {1, 2.7, 3}')).toEqual([1, 2, 3]);
  });

  it('strings, booleans and nil', async () => {
    expect(await evalLua("return 'hello'")).toBe('hello');
    expect(await evalLua('return true')).toBe(1);
    expect(await evalLua('return false')).toBeNull();
    expect(await evalLua('return nil')).toBeNull();
    expect(await evalLua('return')).toBeNull();
  });

  it('RESP2 wire encodings for true/false/nil/status', async () => {
    const r = await t.raw();
    expect(await r.send('EVAL', 'return true', '0')).toBe(':1\r\n');
    expect(await r.send('EVAL', 'return false', '0')).toBe('$-1\r\n');
    expect(await r.send('EVAL', 'return nil', '0')).toBe('$-1\r\n');
    expect(await r.send('EVAL', "return {ok='fine'}", '0')).toBe('+fine\r\n');
    expect(await r.send('EVAL', "return {err='My Error'}", '0')).toBe('-My Error\r\n');
    expect(await r.send('EVAL', 'return 3.99', '0')).toBe(':3\r\n');
    expect(await r.send('EVAL', "return {1,'a',{2}}", '0')).toBe('*3\r\n:1\r\n$1\r\na\r\n*1\r\n:2\r\n');
  });

  it('nested tables', async () => {
    expect(await evalLua("return {1, {2, {3, 'x'}}, 'y'}")).toEqual([1, [2, [3, 'x']], 'y']);
    expect(await evalLua('return {}')).toEqual([]);
  });

  it('table conversion stops at the first nil', async () => {
    expect(await evalLua("return {1,2,3,'foo',nil,'bar'}")).toEqual([1, 2, 3, 'foo']);
    expect(await evalLua('return {nil, 1}')).toEqual([]);
  });

  it('{ok=...} status and redis.status_reply', async () => {
    expect(await evalLua("return {ok='fine'}")).toBe('fine');
    expect(await evalLua("return redis.status_reply('TOCK')")).toBe('TOCK');
  });

  it('{err=...} error and redis.error_reply', async () => {
    expect(await errorOf(evalLua("return {err='My Error'}"))).toBe('My Error');
    expect(await errorOf(evalLua("return redis.error_reply('My Error')"))).toBe('My Error');
    expect(await errorOf(evalLua("return redis.error_reply('MYCODE custom failure')"))).toBe('MYCODE custom failure');
  });

  it('error_reply / status_reply build tables', async () => {
    expect(await evalLua("local t = redis.error_reply('x'); return {type(t), t.err}")).toEqual(['table', 'x']);
    expect(await evalLua("local t = redis.status_reply('y'); return {type(t), t.ok}")).toEqual(['table', 'y']);
  });
});

describe('Redis -> Lua conversion', () => {
  it('integer reply becomes a number', async () => {
    await t.call('DEL', 'rl:int');
    expect(await t.call('EVAL', "local v = redis.call('INCR', KEYS[1]); return {type(v), v}", 1, 'rl:int')).toEqual(['number', 1]);
  });

  it('bulk reply becomes a string', async () => {
    await t.call('SET', 'rl:bulk', '123');
    expect(await t.call('EVAL', "local v = redis.call('GET', KEYS[1]); return type(v)", 1, 'rl:bulk')).toBe('string');
  });

  it('nil bulk becomes false', async () => {
    expect(await t.call('EVAL', "local v = redis.call('GET', KEYS[1]); return {type(v), tostring(v)}", 1, 'rl:missing')).toEqual(['boolean', 'false']);
    expect(await t.call('EVAL', "return redis.call('GET', KEYS[1]) == false", 1, 'rl:missing')).toBe(1);
  });

  it('array reply becomes a table (and round-trips)', async () => {
    await t.call('DEL', 'rl:list');
    await t.call('RPUSH', 'rl:list', 'a', 'b', 'c');
    expect(await t.call('EVAL', "local v = redis.call('LRANGE', KEYS[1], 0, -1); return {type(v), #v, v[2]}", 1, 'rl:list')).toEqual(['table', 3, 'b']);
    expect(await t.call('EVAL', "return redis.call('LRANGE', KEYS[1], 0, -1)", 1, 'rl:list')).toEqual(['a', 'b', 'c']);
  });

  it('HGETALL inside a script (RESP2 default) is a flat table', async () => {
    await t.call('DEL', 'rl:h');
    await t.call('HSET', 'rl:h', 'f', 'v');
    expect(await t.call('EVAL', "return redis.call('HGETALL', KEYS[1])", 1, 'rl:h')).toEqual(['f', 'v']);
  });

  it('status reply becomes {ok=...}', async () => {
    expect(await t.call('EVAL', "local r = redis.call('SET', KEYS[1], 'x'); return {type(r), r.ok}", 1, 'rl:status')).toEqual(['table', 'OK']);
    expect(await t.call('EVAL', "return redis.call('PING')", 0)).toBe('PONG');
  });

  it('error via redis.pcall becomes {err=...}', async () => {
    await t.call('SET', 'rl:str', 'notanumber');
    expect(await t.call('EVAL', "local r = redis.pcall('INCR', KEYS[1]); return {type(r), r.err}", 1, 'rl:str')).toEqual(['table', 'ERR value is not an integer or out of range']);
  });

  it('returning the pcall error table replies with that error', async () => {
    await t.call('SET', 'rl:str2', 'notanumber');
    expect(await errorOf(t.call('EVAL', "return redis.pcall('INCR', KEYS[1])", 1, 'rl:str2'))).toBe('ERR value is not an integer or out of range');
  });

  it('Lua numbers passed to redis.call are converted to strings', async () => {
    await t.call('EVAL', "redis.call('SET', KEYS[1], 10); redis.call('SET', KEYS[2], 1.5); redis.call('SET', KEYS[3], 1700000000000)", 3, 'rl:n1', 'rl:n2', 'rl:n3');
    expect(await t.call('MGET', 'rl:n1', 'rl:n2', 'rl:n3')).toEqual(['10', '1.5', '1700000000000']);
  });
});

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

describe('Lua helper libraries', () => {
  it('redis.sha1hex', async () => {
    expect(await evalLua("return redis.sha1hex('')")).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(await evalLua("return redis.sha1hex('abc')")).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('redis.log and log levels', async () => {
    expect(await evalLua("redis.log(redis.LOG_WARNING, 'log from test'); return 1")).toBe(1);
    expect(await evalLua('return {redis.LOG_DEBUG, redis.LOG_VERBOSE, redis.LOG_NOTICE, redis.LOG_WARNING}')).toEqual([0, 1, 2, 3]);
  });

  it('cjson.encode arrays, objects, empty table, nested, scalars', async () => {
    expect(await evalLua('return cjson.encode({1,2,3})')).toBe('[1,2,3]');
    expect(await evalLua('return cjson.encode({a=1})')).toBe('{"a":1}');
    expect(await evalLua('return cjson.encode({})')).toBe('{}');
    expect(await evalLua('return cjson.encode({a={1,2}})')).toBe('{"a":[1,2]}');
    expect(await evalLua('return cjson.encode({1,{2,{3}}})')).toBe('[1,[2,[3]]]');
    expect(await evalLua("return cjson.encode('hi')")).toBe('"hi"');
    expect(await evalLua('return cjson.encode(1.5)')).toBe('1.5');
    expect(await evalLua('return cjson.encode(true)')).toBe('true');
    expect(await evalLua('return cjson.encode(cjson.null)')).toBe('null');
  });

  it('cjson.encode escapes', async () => {
    expect(await evalLua('return cjson.encode(\'a"b\\\\c\')')).toBe('"a\\"b\\\\c"');
    expect(await evalLua("return cjson.encode('line\\n')")).toBe('"line\\n"');
    // lua-cjson escapes the forward slash
    expect(await evalLua("return cjson.encode('a/b')")).toBe('"a\\/b"');
  });

  it('cjson.decode objects, arrays, nested, unicode, null', async () => {
    expect(await evalLua("local t = cjson.decode('[1,2,3]'); return {#t, t[2]}")).toEqual([3, 2]);
    expect(await evalLua("local t = cjson.decode('{\"a\":\"x\",\"b\":[1,{\"c\":true}]}'); return {t.a, t.b[1], tostring(t.b[2].c)}")).toEqual(['x', 1, 'true']);
    expect(await evalLua("return cjson.decode('\"\\\\u00e9\"')")).toBe('é');
    expect(await evalLua("return cjson.decode('\"\\\\u20ac\"')")).toBe('€');
    expect(await evalLua("return cjson.decode('[null]')[1] == cjson.null")).toBe(1);
    expect(await evalLua("return cjson.decode('3.5') * 2")).toBe(7);
  });

  it('cjson.decode invalid input raises', async () => {
    const msg = await errorOf(evalLua("return cjson.decode('{bad')"));
    expect(msg).toMatch(/^ERR/);
  });

  it('cjson round trip', async () => {
    expect(await evalLua("return cjson.encode(cjson.decode('{\"k\":[1,2,{\"z\":\"w\"}]}'))")).toBe('{"k":[1,2,{"z":"w"}]}');
  });

  it('cmsgpack integer widths (first byte and length)', async () => {
    const enc = (lua: string) => evalLua(`local p = cmsgpack.pack(${lua}); return {#p, string.byte(p, 1)}`);
    expect(await enc('1')).toEqual([1, 0x01]);
    expect(await enc('127')).toEqual([1, 0x7f]);
    expect(await enc('128')).toEqual([2, 0xcc]);
    expect(await enc('256')).toEqual([3, 0xcd]);
    expect(await enc('65536')).toEqual([5, 0xce]);
    expect(await enc('4294967296')).toEqual([9, 0xcf]);
    expect(await enc('-1')).toEqual([1, 0xff]);
    expect(await enc('-32')).toEqual([1, 0xe0]);
    expect(await enc('-33')).toEqual([2, 0xd0]);
    expect(await enc('-129')).toEqual([3, 0xd1]);
    expect(await enc('-32769')).toEqual([5, 0xd2]);
    expect(await enc('-2147483649')).toEqual([9, 0xd3]);
  });

  it('cmsgpack integer round trips', async () => {
    for (const n of [0, 1, 127, 128, 255, 256, 65535, 65536, 4294967295, 4294967296, 1700000000000, -1, -32, -33, -128, -129, -32768, -32769, -2147483648, -2147483649]) {
      expect(await evalLua(`return cmsgpack.unpack(cmsgpack.pack(${n})) == ${n}`)).toBe(1);
    }
    expect(await evalLua('return cmsgpack.unpack(cmsgpack.pack(1700000000000))')).toBe(1700000000000);
    expect(await evalLua('return cmsgpack.unpack(cmsgpack.pack(-2147483649))')).toBe(-2147483649);
  });

  it('cmsgpack floats', async () => {
    expect(await evalLua('local p = cmsgpack.pack(1.5); return {#p, string.byte(p, 1)}')).toEqual([5, 0xca]);
    expect(await evalLua('local p = cmsgpack.pack(0.1); return {#p, string.byte(p, 1)}')).toEqual([9, 0xcb]);
    expect(await evalLua('return tostring(cmsgpack.unpack(cmsgpack.pack(1.5)))')).toBe('1.5');
    expect(await evalLua('return cmsgpack.unpack(cmsgpack.pack(0.1)) == 0.1')).toBe(1);
    expect(await evalLua('return tostring(cmsgpack.unpack(cmsgpack.pack(-2.25)))')).toBe('-2.25');
  });

  it('cmsgpack strings of every length class', async () => {
    const enc = (n: number) => evalLua(`local s = string.rep('x', ${n}); local p = cmsgpack.pack(s); return {#p, string.byte(p, 1), cmsgpack.unpack(p) == s}`);
    expect(await enc(0)).toEqual([1, 0xa0, 1]);
    expect(await enc(31)).toEqual([32, 0xbf, 1]);
    expect(await enc(32)).toEqual([34, 0xd9, 1]);
    expect(await enc(255)).toEqual([257, 0xd9, 1]);
    expect(await enc(256)).toEqual([259, 0xda, 1]);
    expect(await enc(65535)).toEqual([65538, 0xda, 1]);
    expect(await enc(65536)).toEqual([65541, 0xdb, 1]);
  });

  it('cmsgpack arrays and maps', async () => {
    expect(await evalLua('local p = cmsgpack.pack({1,2,3}); return {#p, string.byte(p, 1, -1)}')).toEqual([4, 0x93, 1, 2, 3]);
    expect(await evalLua('local p = cmsgpack.pack({a=1}); return {#p, string.byte(p, 1, -1)}')).toEqual([4, 0x81, 0xa1, 0x61, 0x01]);
    expect(await evalLua('local t = {}; for i=1,16 do t[i]=i end; local p = cmsgpack.pack(t); return {string.byte(p, 1, 3)}')).toEqual([0xdc, 0x00, 0x10]);
    expect(await evalLua('local t = {}; for i=1,16 do t["k"..i]=i end; local p = cmsgpack.pack(t); return {string.byte(p, 1, 3)}')).toEqual([0xde, 0x00, 0x10]);
    expect(await evalLua("local t = cmsgpack.unpack(cmsgpack.pack({a=1, b={1,2,'x'}, c={d='e'}})); return {t.a, t.b[1], t.b[2], t.b[3], t.c.d}")).toEqual([1, 1, 2, 'x', 'e']);
    expect(await evalLua('local t = cmsgpack.unpack(cmsgpack.pack({10,20,30})); return t')).toEqual([10, 20, 30]);
  });

  it('cmsgpack booleans, nil and multiple values', async () => {
    expect(await evalLua('return {string.byte(cmsgpack.pack(true)), string.byte(cmsgpack.pack(false))}')).toEqual([0xc3, 0xc2]);
    expect(await evalLua('return {cmsgpack.unpack(cmsgpack.pack(1, 2, 3))}')).toEqual([1, 2, 3]);
    expect(await evalLua('return tostring(cmsgpack.unpack(cmsgpack.pack(false)))')).toBe('false');
  });

  it('bit library', async () => {
    expect(await evalLua('return bit.band(0xff, 0x0f)')).toBe(15);
    expect(await evalLua('return bit.bor(1, 2, 4)')).toBe(7);
    expect(await evalLua('return bit.bxor(3, 1)')).toBe(2);
    expect(await evalLua('return bit.bnot(0)')).toBe(-1);
    expect(await evalLua('return bit.lshift(1, 4)')).toBe(16);
    expect(await evalLua('return bit.lshift(1, 31)')).toBe(-2147483648);
    expect(await evalLua('return bit.rshift(-1, 28)')).toBe(15);
    expect(await evalLua('return bit.arshift(-256, 4)')).toBe(-16);
    expect(await evalLua('return bit.tobit(0xffffffff)')).toBe(-1);
    expect(await evalLua('return bit.tobit(4294967296 + 5)')).toBe(5);
    expect(await evalLua('return bit.tohex(255)')).toBe('000000ff');
    expect(await evalLua('return bit.tohex(255, 2)')).toBe('ff');
    expect(await evalLua('return bit.tohex(255, -4)')).toBe('00FF');
    expect(await evalLua('return bit.tohex(-1)')).toBe('ffffffff');
  });

  it('Lua 5.1 compat globals', async () => {
    expect(await evalLua('return {unpack({1,2,3})}')).toEqual([1, 2, 3]);
    expect(await evalLua("return loadstring('return 5')()")).toBe(5);
    expect(await evalLua('return table.getn({1,2,3})')).toBe(3);
    expect(await evalLua('return math.pow(2, 10)')).toBe(1024);
    expect(await evalLua("return string.format('%05.1f', 3.14159)")).toBe('003.1');
    expect(await evalLua('return type(table.concat)')).toBe('function');
  });

  it('large integers keep integer formatting through tostring', async () => {
    expect(await t.call('EVAL', 'return tostring(tonumber(ARGV[1]))', 0, '1700000000000')).toBe('1700000000000');
    expect(await t.call('EVAL', 'return tostring(ARGV[1] + 0)', 0, '1700000000000')).toBe('1700000000000');
    expect(await t.call('EVAL', 'return ARGV[1] + 0', 0, '1700000000000')).toBe(1700000000000);
    expect(await t.call('EVAL', 'return tostring(1700000000000 * 1000)', 0)).toBe('1.7e+15');
  });
});

describe('sandbox', () => {
  const absent = (expr: string) => `local ok, v = pcall(function() return ${expr} end); if ok and v ~= nil then return 'present' end; return 'absent'`;

  it('io, os.execute, require, dofile, loadfile are not available', async () => {
    for (const e of ['io', 'os.execute', 'require', 'dofile', 'loadfile', 'os.exit', 'os.getenv']) {
      expect(await evalLua(absent(e)), e).toBe('absent');
    }
  });

  it('os.clock is available', async () => {
    expect(await evalLua('return type(os.clock())')).toBe('number');
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

describe('scripts and RESP3', () => {
  it('default script resp is 2: HGETALL inside script comes back as a flat array on RESP3', async () => {
    await t.call('DEL', 'r3s:h');
    await t.call('HSET', 'r3s:h', 'a', '1');
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect(await r.send('EVAL', "return redis.call('HGETALL', KEYS[1])", '1', 'r3s:h')).toBe('*2\r\n$1\r\na\r\n$1\r\n1\r\n');
    expect(await r.send('EVAL', 'return false', '0')).toBe('_\r\n');
    expect(await r.send('EVAL', 'return true', '0')).toBe(':1\r\n');
  });

  it('redis.setresp(3) returns maps, booleans and doubles', async () => {
    await t.call('DEL', 'r3s:h2', 'r3s:z');
    await t.call('HSET', 'r3s:h2', 'a', '1');
    await t.call('ZADD', 'r3s:z', '1.5', 'm');
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect(await r.send('EVAL', "redis.setresp(3); return redis.call('HGETALL', KEYS[1])", '1', 'r3s:h2')).toBe('%1\r\n$1\r\na\r\n$1\r\n1\r\n');
    expect(await r.send('EVAL', 'redis.setresp(3); return true', '0')).toBe('#t\r\n');
    expect(await r.send('EVAL', 'redis.setresp(3); return false', '0')).toBe('#f\r\n');
    expect(await r.send('EVAL', "redis.setresp(3); return redis.call('ZSCORE', KEYS[1], 'm')", '1', 'r3s:z')).toBe(',1.5\r\n');
    // RESP2 client: map flattened, booleans as integers, double as bulk
    const r2 = await t.raw();
    expect(await r2.send('EVAL', "redis.setresp(3); return redis.call('HGETALL', KEYS[1])", '1', 'r3s:h2')).toBe('*2\r\n$1\r\na\r\n$1\r\n1\r\n');
    expect(await r2.send('EVAL', 'redis.setresp(3); return false', '0')).toBe(':0\r\n');
    expect(await r2.send('EVAL', "redis.setresp(3); return redis.call('ZSCORE', KEYS[1], 'm')", '1', 'r3s:z')).toBe('$3\r\n1.5\r\n');
  });

  it('redis.setresp with an invalid version', async () => {
    const msg = await errorOf(evalLua('redis.setresp(4)'));
    // unverified: exact text "RESP version must be 2 or 3."
    expect(msg).toMatch(/RESP version must be 2 or 3/);
  });
});
