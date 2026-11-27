import { differential, gap, s } from './differential.harness';
import type { Scenario, StepObject } from './differential.harness';

/** EVAL `body` with no keys. */
function ev(body: string, ...args: string[]): StepObject {
  return { cmd: ['EVAL', body, '0', ...args] };
}

/** EVAL returning tostring(<expr>) for each expression (one step per expression). */
function str(...exprs: string[]): StepObject[] {
  return exprs.map((e) => ev(`return tostring(${e})`));
}

/**
 * One scenario per EVAL step, named `<group>: <script>`: the steps of a group are independent probes of the Lua
 * runtime, and a separate scenario per probe reports every divergent one instead of only the first.
 */
function each(group: string, steps: StepObject[]): Scenario[] {
  return steps.map((st) => {
    const script = (st.cmd as string[])[1];
    const name = `${group}: ${script}${(st.cmd as string[]).length > 3 ? ` ${(st.cmd as string[]).slice(3).join(' ')}` : ''}`;
    return NEGATIVE_ZERO_GAP.has(script) ? s(name, [st], gap(NEGATIVE_ZERO_WHY, 'high')) : s(name, [st]);
  });
}

/**
 * KNOWN GAP, not a version difference: Lua 5.4 folds the literal `-0` into the integer 0, so a negative zero never
 * exists in a script and these probes print `0` where Redis's Lua 5.1 prints `-0`. Fixing them needs a real Lua 5.1
 * engine (see docs/DIFFERENTIAL.md, Known gaps).
 */
const NEGATIVE_ZERO_WHY = 'Lua 5.4 has no negative-zero literal; needs a Lua 5.1 engine';
const NEGATIVE_ZERO_GAP = new Set(['return tostring(-0)', "return -0 .. ''", 'return cjson.encode(-0)']);

differential('scripting.lua', [
  // number -> string formatting
  ...each('tostring of integers and large numbers', str('1', '-1', '0', '1e15', '1e16', '2^53', '2^63', '123456789012345678', '-2^31')),
  ...each('tostring of fractions', str('0.1', '1/3', '-0.5', '3.14159', '1e-5', '1.5e300', '100.0')),
  ...each('tostring of special values', str('1/0', '-1/0', '-0', '0/0 ~= 0/0')),
  ...each('concatenation formats numbers', [ev("return '' .. 0.1"), ev("return 'x' .. 1e15"), ev("return 1 .. ''"), ev("return 2^53 .. ''"), ev("return 1/0 .. ''"), ev("return -0 .. ''")]),
  ...each('string.format', [ev("return string.format('%d', 3.7)"), ev("return string.format('%5.2f|%-5s|%x', 3.14159, 'ab', 255)"), ev("return string.format('%q', 'a\\nb\"c')"), ev("return string.format('%g %g', 1e20, 0.1)"), ev("return string.format('%s', 1)")]),
  ...each('tonumber', [ev("return tonumber('0x10')"), ev("return tonumber('  12  ')"), ev("return tostring(tonumber('abc'))"), ev("return tonumber('1e2')"), ev("return tonumber('10', 2)"), ev("return tonumber('z', 36)")]),
  ...each('integer division and modulo', [ev('return 7 % 3'), ev('return -7 % 3'), ev('return tostring(7 / 2)'), ev('return math.floor(-3.5)'), ev('return tostring(math.fmod(-7, 3))'), ev('return tostring(2^0.5)')]),
  ...each('math library', [ev('return tostring(math.huge)'), ev('return math.max(3, 9, 1)'), ev('return tostring(math.pi)'), ev('return math.abs(-4)'), ev('return tostring(math.sqrt(2))'), ev('return type(math.random)')]),

  // string library
  ...each('string functions', [ev("return string.rep('ab', 3)"), ev("return string.upper('aBc')"), ev("return string.sub('hello', 2, -2)"), ev("return string.byte('A')"), ev('return string.char(72, 105)'), ev("return string.len('\\0ab')"), ev("return string.reverse('abc')")]),
  ...each('string patterns', [ev("return string.find('hello world', 'o w')"), ev("return {string.find('hello', 'l+')}"), ev("return string.match('key=val', '(%w+)=(%w+)')"), ev("return (string.gsub('aaa', 'a', 'b', 2))"), ev("local t = {} for w in string.gmatch('a b c', '%a') do t[#t + 1] = w end return t")]),
  ...each('table library', [ev('local t = {3, 1, 2} table.sort(t) return t'), ev("return table.concat({1, 2, 3}, ',')"), ev('local t = {} table.insert(t, 1) table.insert(t, 1, 0) return t'), ev('local t = {1, 2, 3} table.remove(t, 1) return t'), ev('return #{1, 2, 3}'), ev('return select(\'#\', 1, nil, 3)'), ev('return {unpack({1, 2, 3})}')]),
  ...each('Lua 5.1 specifics', [ev('return type(table.getn)'), ev('return type(setfenv)'), ev('return type(math.pow)'), ev('return type(string.gfind)'), ev('return type(table.unpack)'), ev('return type(bit32)'), ev('return _VERSION')]),

  // cjson
  ...each('cjson.encode basics', [ev("return cjson.encode({1, 2, 3})"), ev("return cjson.encode({a = 1})"), ev("return cjson.encode('str')"), ev('return cjson.encode(true)'), ev('return cjson.encode(cjson.null)'), ev('return cjson.encode({})'), ev("return cjson.encode({{}, {a = {}}})")]),
  ...each('cjson.encode numbers', [ev('return cjson.encode(0.1)'), ev('return cjson.encode(1e20)'), ev('return cjson.encode(3)'), ev('return cjson.encode(-0)'), ev('return cjson.encode(2^53)'), ev('return cjson.encode(1/3)'), ev('return cjson.encode(123456789012)')]),
  ...each('cjson.encode strings escaping', [ev("return cjson.encode('a\"b\\\\c/d\\n\\t\\1')"), ev("return cjson.encode('\\255\\128')"), ev("return cjson.encode({['k\"'] = 'v'})")]),
  ...each('cjson.encode errors', [ev('return cjson.encode(1/0)'), ev('return cjson.encode(function() end)'), ev('return cjson.encode({[1] = 1, [5] = 5})'), ev('return cjson.encode({[1] = 1, a = 2})'), ev('return cjson.encode()'), ev('local t = {} t[1] = t return cjson.encode(t)')]),
  ...each('cjson.encode sparse arrays', [ev('return cjson.encode({[1] = 1, [2] = 2, [4] = 4})'), ev('return cjson.encode({[2] = 2})'), ev("return cjson.encode({[1.5] = 'x'})")]),
  ...each('cjson.decode basics', [ev("return cjson.decode('[1,2,3]')"), ev("return cjson.decode('{\"a\":{\"b\":[1,\"x\"]}}')['a']['b']"), ev("return cjson.decode('\"str\"')"), ev("return tostring(cjson.decode('true'))"), ev("return cjson.decode('null') == cjson.null"), ev("return tostring(cjson.decode('1.5'))")]),
  ...each('cjson.decode numbers', [ev("return tostring(cjson.decode('1e400'))"), ev("return tostring(cjson.decode('12345678901234567890'))"), ev("return tostring(cjson.decode('-0'))"), ev("return tostring(cjson.decode('0x10'))"), ev("return cjson.decode('[1.9, -1.9]')")]),
  ...each('cjson.decode unicode escapes', [ev("return cjson.decode('\"\\\\u00e9\\\\u4e2d\"')"), ev("return cjson.decode('\"\\\\ud83d\\\\ude00\"')"), ev("return cjson.decode('\"\\\\u0000x\"')")]),
  ...each('cjson.decode errors', [ev("return cjson.decode('[1,2')"), ev("return cjson.decode('{a:1}')"), ev("return cjson.decode('')"), ev("return cjson.decode('[1] x')"), ev("return cjson.decode('nul')"), ev("return cjson.decode('\"\\\\x\"')"), ev('return cjson.decode()'), ev('return cjson.decode(5)')]),
  ...each('cjson nesting limit', [ev("return cjson.decode(string.rep('[', 1001) .. string.rep(']', 1001))"), ev("local t = {} local c = t for i = 1, 1100 do c[1] = {} c = c[1] end return cjson.encode(t)")]),
  ...each('cjson round trip', [ev("return cjson.encode(cjson.decode('{\"a\":[1,2,{\"b\":null}]}'))"), ev("return cjson.encode(cjson.decode('[]'))"), ev("return cjson.encode(cjson.decode('{}'))")]),
  ...each('cjson decode_array_with_array_mt and helpers', [ev('return type(cjson.encode_keep_buffer)'), ev('return type(cjson.decode_invalid_numbers)'), ev('return type(cjson.encode_max_depth)'), ev('return type(cjson.decode_array_with_array_mt)')]),

  // cmsgpack
  ...each('cmsgpack.pack', [ev('return cmsgpack.pack(1)'), ev("return cmsgpack.pack('abc')"), ev('return cmsgpack.pack({1, 2, 3})'), ev('return cmsgpack.pack({a = 1})'), ev('return cmsgpack.pack(1.5)'), ev('return cmsgpack.pack(-1)'), ev('return cmsgpack.pack(nil)'), ev('return cmsgpack.pack(true, false)'), ev('return cmsgpack.pack(70000)'), ev('return cmsgpack.pack(2^40)')]),
  ...each('cmsgpack.unpack', [ev("return cmsgpack.unpack(cmsgpack.pack({1, 'a', {2}}))"), ev("return {cmsgpack.unpack(cmsgpack.pack(1, 2, 3))}"), ev("return tostring(cmsgpack.unpack(cmsgpack.pack(0.25)))"), ev("return cmsgpack.unpack('\\145\\1')"), ev("return cmsgpack.unpack('\\129\\161a\\1')['a']")]),
  ...each('cmsgpack.unpack errors', [ev("return cmsgpack.unpack('')"), ev("return cmsgpack.unpack('\\193')"), ev('return cmsgpack.unpack()'), ev("return cmsgpack.unpack('\\145')")]),
  ...each('cmsgpack limits and helpers', [ev("return {cmsgpack.unpack_one(cmsgpack.pack(1, 2))}"), ev("return {cmsgpack.unpack_limit(cmsgpack.pack(1, 2, 3), 2)}"), ev('return cmsgpack.pack()'), ev("return #cmsgpack.pack(string.rep('x', 300))")]),

  // bit
  ...each('bit operations', [ev('return bit.band(0xff, 0x0f)'), ev('return bit.bor(1, 2, 4)'), ev('return bit.bxor(5, 3)'), ev('return bit.bnot(0)'), ev('return bit.lshift(1, 31)'), ev('return bit.rshift(-1, 28)'), ev('return bit.arshift(-256, 4)'), ev('return bit.tobit(2^32 + 1)'), ev('return bit.rol(1, 33)'), ev('return bit.bswap(0x12345678)')]),
  ...each('bit.tohex', [ev('return bit.tohex(255)'), ev('return bit.tohex(-1)'), ev('return bit.tohex(255, 4)'), ev('return bit.tohex(255, -4)'), ev('return bit.tohex(0x12345678, 2)')]),
  ...each('bit errors', [ev('return bit.band()'), ev("return bit.band('x', 1)"), ev('return bit.tohex()')]),

  // struct
  ...each('struct.pack', [ev("return struct.pack('>I2', 258)"), ev("return struct.pack('<i4', -2)"), ev("return struct.pack('b', 65)"), ev("return struct.pack('>d', 1.5)"), ev("return struct.pack('s', 'ab')"), ev("return struct.pack('c3', 'abcdef')"), ev("return struct.pack('>I4I2', 1, 2)")]),
  ...each('struct.unpack', [ev("return {struct.unpack('>I2', '\\1\\2')}"), ev("return {struct.unpack('<i4', '\\254\\255\\255\\255')}"), ev("return {struct.unpack('c2c1', 'abc')}"), ev("return {struct.unpack('s', 'ab\\0rest')}"), ev("return {struct.unpack('>I2', '\\0\\1\\0\\2', 3)}")]),
  ...each('struct.size and errors', [ev("return struct.size('>I4I2b')"), ev("return struct.size('s')"), ev("return struct.pack('>I2')"), ev("return struct.unpack('>I4', 'ab')"), ev("return struct.pack('y', 1)"), ev("return struct.pack('i17', 1)")]),

  // misc
  ...each('ARGV numbers are strings', [ev("return {type(ARGV[1]), ARGV[1] + 1, tonumber(ARGV[2])}", '41', '1.5')]),
  ...each('closures and varargs', [ev("local function f(...) return select('#', ...) end return f(1, 2, nil)"), ev('local n = 0 local function inc() n = n + 1 return n end inc() return inc()')]),
  ...each('coroutines', [ev('local co = coroutine.create(function(a) local b = coroutine.yield(a + 1) return b * 2 end) local _, x = coroutine.resume(co, 1) local _, y = coroutine.resume(co, 10) return {x, y, coroutine.status(co)}')]),
  ...each('long string building', [ev("local t = {} for i = 1, 1000 do t[i] = 'x' end return #table.concat(t)"), ev("return #string.rep('ab', 100000)")]),
  ...each('metatables in scripts', [ev("local t = setmetatable({}, {__index = function(_, k) return k .. '!' end}) return t.hi"), ev("return getmetatable('x').__index == string")]),
]);
