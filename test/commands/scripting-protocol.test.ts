import { createHash } from 'node:crypto';
import { connect } from 'node:net';

import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';

import { useServer } from '../helpers';

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

/** Writes raw bytes and collects the reply until `done(received)` is true, the socket closes, or the timeout hits. */
function rawExchange(payload: string | Buffer, done: (s: string) => boolean, timeoutMs = 2000): Promise<{ data: string; closed: boolean }> {
  return new Promise((resolve) => {
    let data = '';
    let closed = false;
    const s = connect(t.server.port, '127.0.0.1', () => {
      s.write(payload);
    });
    s.setEncoding('latin1');
    const finish = () => {
      clearTimeout(timer);
      s.destroy();
      resolve({ data, closed });
    };
    const timer = setTimeout(finish, timeoutMs);
    s.on('data', (d: string) => {
      data += d;
      if (done(data)) finish();
    });
    s.on('close', () => {
      closed = true;
      finish();
    });
    s.on('error', () => undefined);
  });
}

const cmd = (...args: string[]) => `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;

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
    expect(await evalLua("return cjson.encode({a=1})")).toBe('{"a":1}');
    expect(await evalLua('return cjson.encode({})')).toBe('{}');
    expect(await evalLua("return cjson.encode({a={1,2}})")).toBe('{"a":[1,2]}');
    expect(await evalLua("return cjson.encode({1,{2,{3}}})")).toBe('[1,[2,[3]]]');
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
    expect(await evalLua("local p = cmsgpack.pack({1,2,3}); return {#p, string.byte(p, 1, -1)}")).toEqual([4, 0x93, 1, 2, 3]);
    expect(await evalLua("local p = cmsgpack.pack({a=1}); return {#p, string.byte(p, 1, -1)}")).toEqual([4, 0x81, 0xa1, 0x61, 0x01]);
    expect(await evalLua('local t = {}; for i=1,16 do t[i]=i end; local p = cmsgpack.pack(t); return {string.byte(p, 1, 3)}')).toEqual([0xdc, 0x00, 0x10]);
    expect(await evalLua('local t = {}; for i=1,16 do t["k"..i]=i end; local p = cmsgpack.pack(t); return {string.byte(p, 1, 3)}')).toEqual([0xde, 0x00, 0x10]);
    expect(await evalLua("local t = cmsgpack.unpack(cmsgpack.pack({a=1, b={1,2,'x'}, c={d='e'}})); return {t.a, t.b[1], t.b[2], t.b[3], t.c.d}")).toEqual([1, 1, 2, 'x', 'e']);
    expect(await evalLua("local t = cmsgpack.unpack(cmsgpack.pack({10,20,30})); return t")).toEqual([10, 20, 30]);
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
    expect(await evalLua("return {type(string.sub), type(math.floor), type(table.insert), type(cjson), type(cmsgpack), type(bit), type(struct)}")).toEqual(['function', 'function', 'function', 'table', 'table', 'table', 'table']);
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

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

describe('HELLO', () => {
  it('HELLO with no args returns the RESP2 info array', async () => {
    const r = (await t.client().call('HELLO')) as unknown[];
    const m: Record<string, unknown> = {};
    for (let i = 0; i < r.length; i += 2) m[String(r[i])] = r[i + 1];
    expect(Object.keys(m)).toEqual(['server', 'version', 'proto', 'id', 'mode', 'role', 'modules']);
    expect(m.server).toBe('redis');
    expect(m.proto).toBe(2);
    expect(typeof m.id).toBe('number');
    expect(m.mode).toBe('standalone');
    expect(m.role).toBe('master');
    expect(m.modules).toEqual([]);
  });

  it('HELLO 3 returns a map, HELLO 2 switches back', async () => {
    const r = await t.raw();
    const h3 = await r.send('HELLO', '3');
    expect(h3.startsWith('%7\r\n$6\r\nserver\r\n$5\r\nredis\r\n$7\r\nversion\r\n')).toBe(true);
    expect(h3).toContain('$5\r\nproto\r\n:3\r\n');
    expect(h3).toContain('$4\r\nmode\r\n$10\r\nstandalone\r\n$4\r\nrole\r\n$6\r\nmaster\r\n$7\r\nmodules\r\n*0\r\n');
    expect(await r.send('GET', 'hello:missing')).toBe('_\r\n');
    const noArgs = await r.send('HELLO');
    expect(noArgs.startsWith('%7\r\n')).toBe(true);
    expect(noArgs).toContain('$5\r\nproto\r\n:3\r\n');
    const h2 = await r.send('HELLO', '2');
    expect(h2.startsWith('*14\r\n$6\r\nserver\r\n$5\r\nredis\r\n')).toBe(true);
    expect(h2).toContain('$5\r\nproto\r\n:2\r\n');
    expect(await r.send('GET', 'hello:missing')).toBe('$-1\r\n');
  });

  it('HELLO errors', async () => {
    const r = await t.raw();
    expect(await r.send('HELLO', '4')).toBe('-NOPROTO unsupported protocol version\r\n');
    expect(await r.send('HELLO', '1')).toBe('-NOPROTO unsupported protocol version\r\n');
    expect(await r.send('HELLO', 'abc')).toBe('-ERR Protocol version is not an integer or out of range\r\n');
  });

  it('HELLO 3 SETNAME', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3', 'SETNAME', 'proto-client');
    expect(await r.send('CLIENT', 'GETNAME')).toBe('$12\r\nproto-client\r\n');
  });
});

describe('RESP2 vs RESP3 encodings', () => {
  it('nulls', async () => {
    await t.call('DEL', 'p:nolist');
    const r2 = await t.raw();
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    expect(await r2.send('GET', 'p:none')).toBe('$-1\r\n');
    expect(await r3.send('GET', 'p:none')).toBe('_\r\n');
    expect(await r2.send('LPOP', 'p:nolist', '2')).toBe('*-1\r\n');
    expect(await r3.send('LPOP', 'p:nolist', '2')).toBe('_\r\n');
    expect(await r2.send('HGET', 'p:nohash', 'f')).toBe('$-1\r\n');
    expect(await r3.send('HGET', 'p:nohash', 'f')).toBe('_\r\n');
  });

  it('maps: HGETALL, CONFIG GET, XINFO STREAM', async () => {
    await t.call('DEL', 'p:h', 'p:s');
    await t.call('HSET', 'p:h', 'f1', 'v1');
    await t.call('XADD', 'p:s', '1-1', 'a', 'b');
    const r2 = await t.raw();
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    expect(await r2.send('HGETALL', 'p:h')).toBe('*2\r\n$2\r\nf1\r\n$2\r\nv1\r\n');
    expect(await r3.send('HGETALL', 'p:h')).toBe('%1\r\n$2\r\nf1\r\n$2\r\nv1\r\n');
    expect(await r3.send('HGETALL', 'p:nohash')).toBe('%0\r\n');
    expect(await r2.send('CONFIG', 'GET', 'maxmemory-policy')).toBe('*2\r\n$16\r\nmaxmemory-policy\r\n$10\r\nnoeviction\r\n');
    expect(await r3.send('CONFIG', 'GET', 'maxmemory-policy')).toBe('%1\r\n$16\r\nmaxmemory-policy\r\n$10\r\nnoeviction\r\n');
    const x2 = await r2.send('XINFO', 'STREAM', 'p:s');
    expect(x2.startsWith('*')).toBe(true);
    expect(x2).toContain('$6\r\nlength\r\n:1\r\n');
    const x3 = await r3.send('XINFO', 'STREAM', 'p:s');
    expect(x3.startsWith('%')).toBe(true);
    expect(x3).toContain('$6\r\nlength\r\n:1\r\n');
  });

  it('sets', async () => {
    await t.call('DEL', 'p:set');
    await t.call('SADD', 'p:set', 'only');
    const r2 = await t.raw();
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    expect(await r2.send('SMEMBERS', 'p:set')).toBe('*1\r\n$4\r\nonly\r\n');
    expect(await r3.send('SMEMBERS', 'p:set')).toBe('~1\r\n$4\r\nonly\r\n');
    expect(await r3.send('SMEMBERS', 'p:noset')).toBe('~0\r\n');
    expect(await r3.send('SINTER', 'p:set', 'p:set')).toBe('~1\r\n$4\r\nonly\r\n');
  });

  it('doubles: ZSCORE, ZINCRBY, ZADD INCR, ZMSCORE, inf', async () => {
    await t.call('DEL', 'p:z');
    await t.call('ZADD', 'p:z', '1.5', 'a', '2', 'b', 'inf', 'pinf', '-inf', 'ninf');
    const r2 = await t.raw();
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    expect(await r2.send('ZSCORE', 'p:z', 'a')).toBe('$3\r\n1.5\r\n');
    expect(await r3.send('ZSCORE', 'p:z', 'a')).toBe(',1.5\r\n');
    expect(await r2.send('ZSCORE', 'p:z', 'b')).toBe('$1\r\n2\r\n');
    expect(await r3.send('ZSCORE', 'p:z', 'b')).toBe(',2\r\n');
    expect(await r3.send('ZSCORE', 'p:z', 'nomember')).toBe('_\r\n');
    expect(await r2.send('ZSCORE', 'p:z', 'pinf')).toBe('$3\r\ninf\r\n');
    expect(await r3.send('ZSCORE', 'p:z', 'pinf')).toBe(',inf\r\n');
    expect(await r2.send('ZSCORE', 'p:z', 'ninf')).toBe('$4\r\n-inf\r\n');
    expect(await r3.send('ZSCORE', 'p:z', 'ninf')).toBe(',-inf\r\n');
    expect(await r2.send('ZINCRBY', 'p:z', '1', 'a')).toBe('$3\r\n2.5\r\n');
    expect(await r3.send('ZINCRBY', 'p:z', '1', 'a')).toBe(',3.5\r\n');
    expect(await r2.send('ZADD', 'p:z', 'INCR', '1', 'a')).toBe('$3\r\n4.5\r\n');
    expect(await r3.send('ZADD', 'p:z', 'INCR', '1', 'a')).toBe(',5.5\r\n');
    expect(await r2.send('ZADD', 'p:z', 'NX', 'INCR', '1', 'a')).toBe('$-1\r\n');
    expect(await r3.send('ZADD', 'p:z', 'NX', 'INCR', '1', 'a')).toBe('_\r\n');
    expect(await r2.send('ZMSCORE', 'p:z', 'b', 'nomember')).toBe('*2\r\n$1\r\n2\r\n$-1\r\n');
    expect(await r3.send('ZMSCORE', 'p:z', 'b', 'nomember')).toBe('*2\r\n,2\r\n_\r\n');
  });

  it('verbatim strings: INFO, CLIENT INFO, CLIENT LIST', async () => {
    const r2 = await t.raw();
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    const checkVerbatim = (s: string) => {
      const m = /^=(\d+)\r\n/.exec(s);
      expect(m).not.toBeNull();
      const header = m![0];
      const body = s.slice(header.length, s.length - 2);
      expect(s.endsWith('\r\n')).toBe(true);
      expect(body.startsWith('txt:')).toBe(true);
      expect(Buffer.byteLength(body, 'latin1')).toBe(Number(m![1]));
      return body.slice(4);
    };
    expect((await r2.send('INFO', 'server')).startsWith('$')).toBe(true);
    expect(checkVerbatim(await r3.send('INFO', 'server'))).toMatch(/^# Server\r\n/);
    expect((await r2.send('CLIENT', 'INFO')).startsWith('$')).toBe(true);
    expect(checkVerbatim(await r3.send('CLIENT', 'INFO'))).toMatch(/^id=\d+ addr=/);
    expect(checkVerbatim(await r3.send('CLIENT', 'LIST'))).toMatch(/^id=\d+ addr=/);
  });

  it('push frames for pub/sub in RESP3, arrays in RESP2', async () => {
    const s3 = await t.raw();
    await s3.send('HELLO', '3');
    expect(await s3.send('SUBSCRIBE', 'p:ch')).toBe('>3\r\n$9\r\nsubscribe\r\n$4\r\np:ch\r\n:1\r\n');
    const s2 = await t.raw();
    expect(await s2.send('SUBSCRIBE', 'p:ch')).toBe('*3\r\n$9\r\nsubscribe\r\n$4\r\np:ch\r\n:1\r\n');
    expect(await t.call('PUBLISH', 'p:ch', 'msg')).toBe(2);
    expect(await s3.read()).toBe('>3\r\n$7\r\nmessage\r\n$4\r\np:ch\r\n$3\r\nmsg\r\n');
    expect(await s2.read()).toBe('*3\r\n$7\r\nmessage\r\n$4\r\np:ch\r\n$3\r\nmsg\r\n');
    expect(await s3.send('UNSUBSCRIBE', 'p:ch')).toBe('>3\r\n$11\r\nunsubscribe\r\n$4\r\np:ch\r\n:0\r\n');
  });

  it('errors are the same in both protocols', async () => {
    const r3 = await t.raw();
    await r3.send('HELLO', '3');
    expect(await r3.send('GET')).toBe("-ERR wrong number of arguments for 'get' command\r\n");
  });
});

describe('wire level', () => {
  it('pipelining many commands in one write', async () => {
    await t.call('DEL', 'pipe:ctr');
    const n = 500;
    let payload = '';
    for (let i = 0; i < n; i++) payload += cmd('INCR', 'pipe:ctr');
    payload += cmd('GET', 'pipe:ctr');
    const expected = Array.from({ length: n }, (_, i) => `:${i + 1}\r\n`).join('') + `$3\r\n${n}\r\n`;
    const { data } = await rawExchange(payload, (s) => s.length >= expected.length);
    expect(data).toBe(expected);
  });

  it('pipelined commands split across arbitrary byte boundaries', async () => {
    const payload = Buffer.from(cmd('SET', 'pipe:split', 'v') + cmd('GET', 'pipe:split') + 'PING\r\n');
    const expected = '+OK\r\n$1\r\nv\r\n+PONG\r\n';
    const result = await new Promise<string>((resolve) => {
      let data = '';
      const s = connect(t.server.port, '127.0.0.1', async () => {
        for (let i = 0; i < payload.length; i += 3) {
          s.write(payload.subarray(i, i + 3));
          await new Promise((r) => setTimeout(r, 1));
        }
      });
      s.setEncoding('latin1');
      const timer = setTimeout(() => {
        s.destroy();
        resolve(data);
      }, 2000);
      s.on('data', (d: string) => {
        data += d;
        if (data.length >= expected.length) {
          clearTimeout(timer);
          s.destroy();
          resolve(data);
        }
      });
    });
    expect(result).toBe(expected);
  });

  it('1 MB bulk string round trip', async () => {
    const big = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    await t.redis.set('big:k', big);
    const back = (await t.redis.getBuffer('big:k')) as Buffer;
    expect(back.length).toBe(big.length);
    expect(Buffer.compare(back, big)).toBe(0);
    expect(await t.call('STRLEN', 'big:k')).toBe(1024 * 1024);
    const viaEval = (await t.redis.callBuffer('EVAL', 'return ARGV[1]', '0', big)) as Buffer;
    expect(Buffer.compare(viaEval, big)).toBe(0);
  });

  it('inline protocol', async () => {
    const { data } = await rawExchange('PING\r\nSET inline:k "hello world"\r\nGET inline:k\r\nECHO \'single quoted\'\r\n', (s) => s.endsWith('$13\r\nsingle quoted\r\n'));
    expect(data).toBe('+PONG\r\n+OK\r\n$11\r\nhello world\r\n$13\r\nsingle quoted\r\n');
  });

  it('inline protocol with LF only and hex escapes in double quotes', async () => {
    const { data } = await rawExchange('ECHO "a\\x41\\n"\n', (s) => s.length >= 9);
    expect(data).toBe('$3\r\naA\n\r\n');
  });

  it('inline protocol: unbalanced quotes', async () => {
    const { data, closed } = await rawExchange('SET k "unterminated\r\n', () => false, 1000);
    expect(data).toBe('-ERR Protocol error: unbalanced quotes in request\r\n');
    expect(closed).toBe(true);
  });

  it('empty inline line is ignored', async () => {
    const { data } = await rawExchange('\r\nPING\r\n', (s) => s.includes('PONG'));
    expect(data).toBe('+PONG\r\n');
  });

  it("malformed multibulk: expected '$'", async () => {
    const { data, closed } = await rawExchange('*1\r\nfoo\r\n', () => false, 1000);
    expect(data).toBe("-ERR Protocol error: expected '$', got 'f'\r\n");
    expect(closed).toBe(true);
  });

  it('malformed multibulk: invalid multibulk length', async () => {
    const { data, closed } = await rawExchange('*abc\r\n', () => false, 1000);
    expect(data).toBe('-ERR Protocol error: invalid multibulk length\r\n');
    expect(closed).toBe(true);
  });

  it('malformed multibulk: invalid bulk length', async () => {
    const { data, closed } = await rawExchange('*1\r\n$abc\r\n', () => false, 1000);
    expect(data).toBe('-ERR Protocol error: invalid bulk length\r\n');
    expect(closed).toBe(true);
  });

  it('valid command before a protocol error is still answered', async () => {
    const { data, closed } = await rawExchange(cmd('PING') + '*1\r\nxyz\r\n', () => false, 1000);
    expect(data).toBe("+PONG\r\n-ERR Protocol error: expected '$', got 'x'\r\n");
    expect(closed).toBe(true);
  });

  it('*0 and *-1 multibulk are ignored', async () => {
    const { data } = await rawExchange('*0\r\n*-1\r\n' + cmd('PING'), (s) => s.includes('PONG'));
    expect(data).toBe('+PONG\r\n');
  });
});
