import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

/** The Lua prelude: redis.* helpers, cjson, cmsgpack, bit, struct and Lua 5.1 compatibility. */

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
