import { createHash } from 'node:crypto';

import { differential, s, v } from './differential.harness';
import type { StepObject } from './differential.harness';
import { all, commandStats, sortedInfoLines } from './differential.normalizers';
import { intProbes } from './differential.probes';

/** EVAL `body` (numkeys + keys + args after it; `0` when none). */
function ev(body: string, ...rest: string[]): StepObject {
  return { cmd: ['EVAL', body, ...(rest.length ? rest : ['0'])] };
}

/** EVAL_RO `body`. */
function ro(body: string, ...rest: string[]): StepObject {
  return { cmd: ['EVAL_RO', body, ...(rest.length ? rest : ['0'])] };
}

/** SHA1 of `return 1` (stable, Redis caches scripts by it). */
const SHA_RETURN_1 = 'e0e1f9fabfc9d4800c877a703b823ac0578ff8db';

const DEL_K = "return redis.call('DEL', 'k')";

function sha1(body: string): string {
  return createHash('sha1').update(body, 'latin1').digest('hex');
}

differential('scripting', [
  // Lua -> RESP conversions
  s('Lua integer and float return', [ev('return 1'), ev('return 3.99'), ev('return -3.7'), ev('return 0.5'), ev('return -0.5'), ev('return 2^53'), ev('return 1e15')]),
  s('Lua string and boolean return', [ev("return 'hello'"), ev("return ''"), ev('return true'), ev('return false'), ev('return nil'), ev('return')]),
  s('Lua table return', [ev('return {1, 2, 3}'), ev("return {1, 'a', {2, {3, 'b'}}}"), ev('return {}'), ev('return {a = 1, b = 2}'), ev("return {1, 2, a = 'x'}")]),
  s('Lua table return stops at nil', [ev('return {1, nil, 3}'), ev('return {nil, 2}'), ev('return {1, false, 3}'), ev('return {true, false}')]),
  s('Lua float inside table truncated', [ev('return {1.9, -1.9, 3.0}')]),
  s('Lua err and ok tables', [ev("return {err = 'My Error'}"), ev("return {err = 'WRONGTYPE custom'}"), ev("return {ok = 'FINE'}"), ev("return {err = 'x', ok = 'y'}")]),
  s('Lua ok table with CRLF', [ev("return {ok = 'line\\r\\nbreak'}"), ev("return redis.status_reply('a\\nb')"), ev("return {err = 'bad\\r\\nline'}")]),
  s('redis.error_reply with dash prefix', [ev("return redis.error_reply('-ERR prefixed')"), ev("return redis.error_reply('-MYCODE x')")]),
  s('redis.error_reply without code prefix', [ev("return redis.error_reply('ERROR')"), ev("return redis.error_reply('two words')"), ev("return redis.error_reply('')")]),
  s('redis.status_reply and error_reply', [ev("return redis.status_reply('STATUS')"), ev("return redis.status_reply('')")]),
  s('redis.error_reply without arguments', [ev('return redis.error_reply()')]),
  s('redis.status_reply bad arguments', [ev("return redis.status_reply(1, 2)"), ev('return redis.error_reply({})')]),
  s('Lua binary string return', [ev("return '\\0\\255\\r\\n'")]),

  // RESP -> Lua conversions
  s('redis.call reply types in Lua', ['SET k 5', 'RPUSH l a b', ev("return {type(redis.call('GET', 'k')), type(redis.call('GET', 'missing')), type(redis.call('INCR', 'k')), type(redis.call('LRANGE', 'l', 0, -1)), type(redis.call('SET', 'x', 'y'))}")]),
  s('redis.call nil bulk is false', [ev("return redis.call('GET', 'missing') == false")]),
  s('redis.call status reply is ok table', [ev("return redis.call('SET', 'k', 'v')['ok']"), ev("return redis.call('PING')")]),
  s('redis.call passes replies through', ['RPUSH l a b c', 'HSET h f v', ev("return redis.call('LRANGE', 'l', 0, -1)"), ev("return redis.call('HGETALL', 'h')"), ev("return redis.call('INCRBYFLOAT', 'f', '1.5')"), ev("return redis.call('ZADD', 'z', 1, 'm')")]),
  s('redis.call argument conversion', [ev("redis.call('SET', 'k', 1.5) return redis.call('GET', 'k')"), ev("redis.call('SET', 'k', 3.0) return redis.call('GET', 'k')"), ev("redis.call('SET', 'k', 10) return redis.call('GET', 'k')"), ev("redis.call('SET', 'k', -0.25) return redis.call('GET', 'k')")]),
  s('redis.call large float argument', [ev("redis.call('SET', 'k', 1e20) return redis.call('GET', 'k')"), ev("redis.call('SET', 'k', 2^53) return redis.call('GET', 'k')"), ev("redis.call('SET', 'k', 0.1) return redis.call('GET', 'k')")], v('Lua numbers passed to redis.call are formatted with %.17g in 7.0 (0.10000000000000001); newer Redis uses the shortest round-trip form (0.1)', 'medium')),
  s('redis.call bad argument types', [ev("return redis.call('SET', 'k', true)"), ev("return redis.call('SET', 'k', {})"), ev("return redis.call('SET', 'k', nil)"), ev('return redis.call()'), ev('return redis.pcall()')]),
  s('redis.call MULTI inside script', [ev("return redis.call('MULTI')"), ev("return redis.call('EVAL', 'return 1', 0)")]),

  // errors raised by scripts
  s('redis.call runtime error aborts script', ['SET s str', ev("redis.call('INCR', 's') return 'unreached'"), ev("return redis.call('LPUSH', 's', 'x')")]),
  s('redis.pcall returns error table', ['SET s str', ev("local r = redis.pcall('INCR', 's') return r['err']"), ev("return redis.pcall('INCR', 's')"), ev("return type(redis.pcall('INCR', 's'))")]),
  s('Lua pcall around redis.call', ['SET s str', ev("local ok, e = pcall(redis.call, 'INCR', 's') return {tostring(ok), type(e), e['err']}")], v('errors raised by redis.call reach Lua pcall as {err=...} tables instead of strings after 7.0', 'low')),
  s('Lua pcall around error()', [ev("local ok, e = pcall(function() error('boom') end) return {tostring(ok), e}"), ev("local ok, e = pcall(function() error('boom', 0) end) return e")]),
  s('Lua pcall around error() with table', [ev("local ok, e = pcall(function() error({err = 'X'}) end) return {tostring(ok), type(e), e['err']}")], v('error objects raised as tables keep their err field through Lua pcall after 7.0 (7.0.15 shows a non-table)', 'low')),
  s('Lua pcall around arity error', [ev("local ok, e = pcall(redis.call, 'INCR', 's', 'x') return {tostring(ok), type(e)}"), ev("local ok, e = pcall(redis.call, 'NOSUCH') return {tostring(ok), type(e)}")], v('errors raised by redis.call reach Lua pcall as {err=...} tables instead of strings after 7.0', 'low')),
  s('error() with string', [ev("error('boom')"), ev("error('boom', 0)"), ev("error('boom', 2)")]),
  s('error() with table', [ev("error({err = 'MYERR custom message'})"), ev("error({err = 'plain'})")]),
  s('error() with number', [ev('error(42)')]),
  s('error() without argument', [ev('error()'), ev('error(nil)')]),
  s('error() with table without err field', [ev("error({foo = 'bar'})")], { fresh: true, ...v('Redis 7.0.15 crashes (connection closed) on error() with a table lacking err; fixed after 7.0', 'medium') }),
  s('script runtime errors', [ev('return nosuch()'), ev('return 1 + {}')]),
  s('Lua 5.1 index error text', [ev('local t = nil return t.x')]),
  s('Lua 5.1 method call error text', [ev("return ('x'):nosuch()")]),
  s('Lua 5.1 field and operator error texts', [ev('local t = {} return t.a.b'), ev('return #nil'), ev("return 'a' < 1")]),
  s('Lua 5.1 compile error at eof', [ev('return 1 +'), ev('if true then')]),
  s('Lua 5.1 compile error expected symbol', [ev('retrun 1')]),
  s('script compile error unterminated string', [ev("return 'unterminated")]),
  s('unknown command from script', [ev("return redis.call('NOSUCH')")], v('script errors for unknown commands / wrong arity use the regular command error text since 7.2 (shared command checks)', 'medium')),
  s('unknown command from script via pcall', [ev("return redis.pcall('NOSUCH', 'a')")], v('script errors for unknown commands / wrong arity use the regular command error text since 7.2 (shared command checks)', 'medium')),
  s('wrong arity from script', [ev("return redis.call('GET')")], v('script errors for unknown commands / wrong arity use the regular command error text since 7.2 (shared command checks)', 'medium')),
  s('wrong arity from script via pcall', [ev("return redis.pcall('SET', 'k')")], v('script errors for unknown commands / wrong arity use the regular command error text since 7.2 (shared command checks)', 'medium')),
  s('global variable access', [ev('x = 1'), ev('return undefined_global'), ev("return _G['x']"), ev('local x = 5 return x')]),
  s('protected globals', [ev('redis = nil'), ev('string.foo = 1 return 1'), ev("return rawset(_G, 'x', 1)")]),
  s('readonly globals metatable', [ev('setmetatable(_G, nil)'), ev("return getmetatable('').__index == string")]),
  s('dangerous functions removed', [ev("return loadstring('return 1')()"), ev('return type(dofile)'), ev('return type(loadfile)'), ev('return type(io)')]),
  s('print is not available', [ev('return type(print)')]),
  s('Lua os table', [ev('return type(os)'), ev('return type(os.clock())')], v('the os table (os.clock only) became available to scripts after 7.0 (8.0)', 'medium')),
  s('WRONGTYPE from script', ['SET s str', ev("return redis.call('LLEN', 's')")]),
  s('script error inside MULTI keeps going', ['MULTI', ev("error('boom')"), 'SET k v', 'EXEC']),

  // KEYS / ARGV / numkeys
  s('KEYS and ARGV', [ev('return {KEYS[1], KEYS[2], ARGV[1], ARGV[2], #KEYS, #ARGV}', '2', 'k1', 'k2', 'a1', 'a2'), ev('return {#KEYS, #ARGV}', '0', 'a', 'b'), ev('return {#KEYS, #ARGV}', '3', 'a', 'b', 'c')]),
  s('numkeys errors', [ev('return 1', '-1'), ev('return 1', '2', 'a'), ev('return 1', 'x'), ev('return 1', '1.5', 'a'), ev('return 1', '99999999999999999999')]),
  s('EVAL arity', ['EVAL', "EVAL 'return 1'", 'EVALSHA', `EVALSHA ${SHA_RETURN_1}`, 'EVAL_RO', 'FCALL']),
  s('KEYS are binary safe', [ev('return KEYS[1]', '1', '\x00\xff'), ev('return #ARGV[1]', '0', 'abc\x00def')]),

  // EVALSHA / SCRIPT
  s('EVAL caches script for EVALSHA', [ev('return 1'), `EVALSHA ${SHA_RETURN_1} 0`, `SCRIPT EXISTS ${SHA_RETURN_1}`]),
  s('EVALSHA unknown and malformed', ['EVALSHA ffffffffffffffffffffffffffffffffffffffff 0', 'EVALSHA abc 0', `EVALSHA ${SHA_RETURN_1.toUpperCase()} 0`, 'SCRIPT LOAD "return 1"', `EVALSHA ${SHA_RETURN_1.toUpperCase()} 0`]),
  s('SCRIPT LOAD and EXISTS', ['SCRIPT LOAD "return 1"', 'SCRIPT LOAD "return 1"', `SCRIPT EXISTS ${SHA_RETURN_1} ffffffffffffffffffffffffffffffffffffffff ${SHA_RETURN_1.toUpperCase()} x`, `EVALSHA ${SHA_RETURN_1} 0`, `EVALSHA_RO ${SHA_RETURN_1} 0`]),
  s('SCRIPT LOAD compile error', ['SCRIPT LOAD "return +"', 'SCRIPT LOAD ""', 'SCRIPT LOAD']),
  s('SCRIPT FLUSH', ['SCRIPT LOAD "return 1"', 'SCRIPT FLUSH', `SCRIPT EXISTS ${SHA_RETURN_1}`, `EVALSHA ${SHA_RETURN_1} 0`, 'SCRIPT FLUSH ASYNC', 'SCRIPT FLUSH SYNC']),
  s('SCRIPT FLUSH bad option', ['SCRIPT FLUSH FOO', 'SCRIPT FLUSH SYNC ASYNC']),
  s('SCRIPT errors', ['SCRIPT', 'SCRIPT FOO', 'SCRIPT EXISTS']),
  s('SCRIPT HELP', ['SCRIPT HELP'], v('the HELP footer reads "Print this help." in newer Redis (7.0: "Prints this help.")', 'medium')),
  s('SCRIPT KILL when idle', ['SCRIPT KILL', 'SCRIPT KILL x', 'FUNCTION KILL']),
  s('EVAL_RO rejects writes', [ro("return redis.call('SET', 'k', 'v')"), ro("return redis.pcall('SET', 'k', 'v')"), 'SET k v', ro("return redis.call('GET', 'k')"), 'EXISTS k']),
  s('EVALSHA_RO', [{ cmd: ['SCRIPT', 'LOAD', DEL_K] }, { cmd: ['EVALSHA_RO', sha1(DEL_K), '0'] }, { cmd: ['EVALSHA', sha1(DEL_K), '0'] }, 'EVALSHA_RO ffffffffffffffffffffffffffffffffffffffff 0']),

  // shebang flags
  s('shebang no-writes', [ev("#!lua flags=no-writes\nreturn redis.call('SET', 'k', 'v')"), ev("#!lua flags=no-writes\nreturn redis.call('GET', 'k')"), ro("#!lua flags=no-writes\nreturn 1"), ro("#!lua\nreturn 1")]),
  s('shebang flags and errors', [ev('#!lua\nreturn 1'), ev('#!lua flags=allow-oom,allow-stale,no-cluster\nreturn 1'), ev('#!lua flags=nosuch\nreturn 1'), ev('#!lua name=foo\nreturn 1'), ev('#!js\nreturn 1'), ev('#!lua flags=\nreturn 1'), ev('#!lua flags=no-writes flags=no-writes\nreturn 1')]),
  s('shebang allow-cross-slot-keys', [ev('#!lua flags=allow-cross-slot-keys\nreturn #KEYS', '2', 'a', 'b')]),
  s('shebang scripts are cached', [ev('#!lua\nreturn 7'), 'SCRIPT LOAD "#!lua\nreturn 7"']),

  // redis.* helpers
  s('redis.sha1hex', [ev("return redis.sha1hex('')"), ev("return redis.sha1hex('abc')"), ev('return redis.sha1hex(123)')]),
  s('redis.sha1hex arity', [ev('return redis.sha1hex()'), ev("return redis.sha1hex('a', 'b')")]),
  s('redis.log', [ev("redis.log(redis.LOG_WARNING, 'hello') return 1"), ev("redis.log(redis.LOG_DEBUG, 'a', 'b', 1) return 1")]),
  s('redis.log arity', [ev('redis.log(redis.LOG_WARNING)'), ev('redis.log()')]),
  s('redis.log bad level', [ev("redis.log(99, 'x')"), ev("redis.log('x', 'y')")]),
  s('redis log constants', [ev('return {redis.LOG_DEBUG, redis.LOG_VERBOSE, redis.LOG_NOTICE, redis.LOG_WARNING}')]),
  s('redis.set_repl bad flags', [ev('redis.set_repl(99)'), ev('redis.set_repl()')]),
  s('redis replication helpers', [ev('return redis.replicate_commands()'), ev('redis.set_repl(redis.REPL_ALL) return 1'), ev('return {redis.REPL_NONE, redis.REPL_AOF, redis.REPL_SLAVE, redis.REPL_REPLICA, redis.REPL_ALL}')]),
  s('redis.breakpoint and debug outside debugger', [ev('return redis.breakpoint()'), ev("redis.debug('x') return 1")]),
  s('redis.acl_check_cmd', [ev("return redis.acl_check_cmd('GET', 'k')"), ev("return redis.acl_check_cmd('NOSUCH')"), ev('return redis.acl_check_cmd()')]),
  s('redis.setresp errors', [ev('redis.setresp(4)'), ev('redis.setresp()'), ev("redis.setresp('x')")]),

  // RESP3 inside scripts
  s('setresp 3 map and set', ['HSET h a 1', 'SADD st x', ev("redis.setresp(3) local r = redis.call('HGETALL', 'h') return r['map']['a']"), ev("redis.setresp(3) return redis.call('HGETALL', 'h')"), ev("redis.setresp(3) return redis.call('SMEMBERS', 'st')")]),
  s('setresp 3 double', ['ZADD z 1.5 m', ev("redis.setresp(3) return redis.call('ZSCORE', 'z', 'm')"), ev("redis.setresp(3) return redis.call('ZSCORE', 'z', 'm')['double']"), ev("redis.setresp(2) return redis.call('ZSCORE', 'z', 'm')")]),
  s('setresp 3 null and boolean', [ev("redis.setresp(3) return redis.call('GET', 'missing')"), ev("redis.setresp(3) return type(redis.call('GET', 'missing'))"), ev("redis.setresp(3) return redis.call('EXISTS', 'x')")]),
  s('Lua double return formatting', [ev('return {double = 3.14}'), ev('return {double = 0.1}')], v('double replies use the shortest round-trip representation (fpconv) since 7.2 instead of %.17g', 'medium')),
  s('Lua RESP3 typed returns', [ev('return {double = 1/0}'), ev('return {double = 2.5}'), ev("return {map = {a = 1}}"), ev("return {set = {a = true}}"), ev("return {big_number = '123456789012345678901234567890'}"), ev("return {verbatim_string = {format = 'txt', string = 'hi'}}")]),
  s('Lua RESP3 typed returns after setresp', [ev('redis.setresp(3) return {double = 0.5}'), ev("redis.setresp(3) return {map = {k = 'v'}}"), ev("redis.setresp(3) return {set = {m = true}}"), ev('redis.setresp(3) return true'), ev('redis.setresp(3) return false'), ev('redis.setresp(3) return nil')]),
  s('setresp 3 HELLO-less client sees RESP2', ['RPUSH l a', ev("redis.setresp(3) return redis.call('LPOS', 'l', 'zz')")]),

  // Redis 7.0 error objects: pcall hands out the err text, redis.call errors carry ignore_error_stats_update
  s('Lua pcall error value forms', [ev("local ok, e = pcall(error, {err = 'X'}) return {type(e), e}"), ev("local ok, e = pcall(function() error({err = 5}) end) return {type(e), tostring(e)}"), ev("local ok, e = pcall(function() error({err = {}}) end) return type(e)"), ev("local ok, e = pcall(function() error({foo = 1}) end) return type(e)"), ev("local ok, e = pcall(function() error(setmetatable({}, {__index = function() return 'Z' end})) end) return {type(e), e}"), ev("local ok, e = xpcall(function() error({err = 'X'}) end, function(m) return type(m) end) return e"), ev("local ok, e = coroutine.resume(coroutine.create(function() error({err = 'X'}) end)) return type(e)")]),
  s('Lua pcall error text reused', ['SET s str', ev("local ok, e = pcall(redis.call, 'INCR', 's') return e"), ev("local ok, e = pcall(redis.call, 'INCR', 's') error(e)"), ev("local ok, e = pcall(redis.call, 'INCR', 's') error(e, 0)"), ev("local ok, e = pcall(function() error({err = 'X'}) end) error(e)")]),
  s('Lua pcall around redis lib errors', [ev("local ok, e = pcall(redis.setresp, 4) return e"), ev("local ok, e = pcall(redis.setresp) return e"), ev("local ok, e = pcall(redis.set_repl, 99) return e"), ev("local ok, e = pcall(redis.set_repl) return e"), ev("local ok, e = pcall(redis.sha1hex) return e"), ev("local ok, e = pcall(redis.log) return e"), ev("local ok, e = pcall(redis.log, 'x', 'y') return e"), ev("local ok, e = pcall(redis.log, 9, 'y') return e"), ev("local ok, e = pcall(redis.acl_check_cmd, 'nosuch') return e"), ev("local ok, e = pcall(redis.acl_check_cmd) return e"), ev("local ok, e = pcall(redis.call) return e"), ev("local ok, e = pcall(redis.call, 'SET', 'k', {}) return e"), ev("local ok, e = pcall(redis.error_reply) return type(e)")]),
  s('Lua pcall library argument errors', [ev("local ok, e = pcall(bit.band, 'x') return e"), ev("local ok, e = pcall(bit.tohex, {}) return e"), ev("local ok, e = pcall(string.rep) return e"), ev("local ok, e = pcall(string.format, '%d', 'x') return e"), ev("local ok, e = pcall(math.floor, 'x') return e"), ev("local ok, e = pcall(table.concat, 1) return e"), ev("local ok, e = pcall(struct.pack) return e"), ev("local ok, e = pcall(cjson.encode) return e"), ev("local ok, e = pcall(cmsgpack.pack) return e"), ev("local ok, e = pcall(tonumber) return e"), ev("local ok, e = pcall(setmetatable, 1) return e"), ev("local ok, e = pcall(function() local y = bit.band('x') return y end) return e")]),
  s('redis.call error table fields', ['SET s str', ev("local e = redis.pcall('INCR', 's') local t = {} for k, v in pairs(e) do t[#t + 1] = k .. '=' .. tostring(v) end table.sort(t) return t"), ev("local e = redis.pcall('NOSUCH') local t = {} for k, v in pairs(e) do t[#t + 1] = k .. '=' .. tostring(v) end table.sort(t) return t"), ev("local e = redis.pcall('GET') local t = {} for k, v in pairs(e) do t[#t + 1] = k .. '=' .. tostring(v) end table.sort(t) return t"), ev("local e = redis.pcall() local t = {} for k, v in pairs(e) do t[#t + 1] = k .. '=' .. tostring(v) end table.sort(t) return t"), ev("local e = redis.pcall({}) local t = {} for k, v in pairs(e) do t[#t + 1] = k .. '=' .. tostring(v) end table.sort(t) return t"), ev("local ok, e = xpcall(function() redis.call('INCR', 's') end, function(m) return m end) local t = {} for k, v in pairs(e) do t[#t + 1] = k .. '=' .. tostring(v) end table.sort(t) return t"), ev("local ok, e = xpcall(function() redis.setresp(9) end, function(m) return m end) local t = {} for k, v in pairs(e) do t[#t + 1] = k .. '=' .. tostring(v) end table.sort(t) return t")]),
  s('error stats of script errors', ['SET s str', 'CONFIG RESETSTAT', ev("return redis.pcall('INCR', 's')"), ev("return redis.call('INCR', 's')"), ev("local ok = pcall(redis.call, 'INCR', 's') return 1"), ev("redis.pcall('NOSUCH') return 1"), ev("redis.pcall('GET') return 1"), ev("redis.pcall('BLPOP', 'l', 0) return 1"), ev("return redis.call('CONFIG', 'NOSUCH')"), ev("local ok = pcall(redis.setresp, 9) return 1"), ev("redis.pcall() redis.pcall({}) return 1"), 'INFO errorstats', 'CONFIG RESETSTAT', ev("local e = redis.pcall('INCR', 's') return {err = e.err}"), ev("local e = redis.pcall('INCR', 's') error(e)"), ev("local e = redis.pcall('INCR', 's') e.err = 'MY other' return e"), ev("return {err = 'ERR x', ignore_error_stats_update = true}"), ev("error({err = 'ERR x', ignore_error_stats_update = true})"), ev("local ok, e = pcall(redis.call, 'INCR', 's') return redis.error_reply(e)"), 'INFO errorstats']),
  s('script command rejections in commandstats', ['CONFIG RESETSTAT', ev("redis.pcall('GET') return 1"), ev("redis.pcall('BLPOP', 'l', 0) return 1"), ev("redis.pcall('CONFIG', 'NOSUCH') return 1"), ev("redis.pcall('NOSUCH') return 1"), 'INFO errorstats', 'INFO commandstats'], { norm: all(commandStats, sortedInfoLines) }),
  s('error() with table err number or metatable', [ev('error({err = 5})'), ev("error(setmetatable({}, {__index = function() return 'Z' end}))"), ev("error({err = 'X', source = 'S', line = 9})"), ev("return {err = {}}"), ev('return {err = 5}'), ev('error(true)')]),
  s('error() with table err not a string', [ev('error({err = true})')], { fresh: true }),
  s('error handler global', [ev('return type(__redis__err__handler)'), ev("local t = __redis__err__handler('X') return {type(t), t.err, t.source, t.line}"), ev('local t = __redis__err__handler(5) return {t.err, t.source, t.line}'), ev('local t = __redis__err__handler(nil) return {t.err, t.source}'), ev("local t = __redis__err__handler({err = 'X', source = 'S', line = 9}) return {t.err, t.source, t.line}"), ev("local t = {err = 'X'} return tostring(__redis__err__handler(t) == t)"), ev("local function f() return __redis__err__handler('X') end local t = f() return {t.err, t.source, t.line}"), ev('local t = __redis__err__handler({}) return {tostring(t.err), t.source}'), ev('return pcall(__redis__err__handler)'), ev('__redis__err__handler = 1')]),
  s('Lua globals of EVAL scripts', [ev("local t = {} for k in pairs(_G) do t[#t + 1] = k end table.sort(t) return t"), ev("local t = {} for k in pairs(redis) do t[#t + 1] = k end table.sort(t) return t")]),
  s('redis version from script', [ev('return {redis.REDIS_VERSION, redis.REDIS_VERSION_NUM}')]),
  s('commands not allowed from script', [ev("return redis.call('BLPOP', 'l', 0)"), ev("return redis.call('BRPOP', 'l', 0)"), ev("return redis.call('BLMOVE', 'l', 'm', 'LEFT', 'LEFT', 0)"), ev("return redis.call('BZPOPMIN', 'z', 0)"), ev("return redis.call('WAIT', 0, 0)"), ev("return redis.call('MULTI')"), ev("return redis.call('CLIENT', 'PAUSE', 1)"), ev("return redis.pcall('SUBSCRIBE', 'c')"), ev("return redis.call('BLPOP')"), ev("local ok, e = pcall(redis.call, 'EVAL', 'return 1', 0) return e")]),
  s('unknown subcommand and arity from script', [ev("return redis.call('CONFIG', 'NOSUCH')"), ev("return redis.pcall('CONFIG')"), ev("return redis.pcall('CONFIG', 'GET')"), ev("return redis.pcall('NOSUCH', 'GET')"), ev("return redis.pcall('GET', 'a', 'b')"), ev("\nlocal function f()\n redis.call('nosuch')\nend\nf()")]),
  s('Lua double return of special values', [ev('return {double = 0/0}'), ev('return {double = -(0/0)}'), ev('return {double = -1/0}'), ev('return {double = -0.0}'), ev('return {double = 1e300}'), ev('return {double = 123456789}'), ev('redis.setresp(3) return {double = 0/0}'), ev("redis.call('SET', 'k', 0/0) return redis.call('GET', 'k')")]),
  s('redis.call number arguments', [ev("redis.call('SET', 'k', 123456789012345678) return redis.call('GET', 'k')"), ev("redis.call('SET', 'k', 1e-5) return redis.call('GET', 'k')"), ev("redis.call('SET', 'k', 1.5) return redis.call('GET', 'k')"), ev("redis.call('SET', 'k', -0.0) return redis.call('GET', 'k')"), ev("redis.call('SET', 'k', 1/0) return redis.call('GET', 'k')"), ev("redis.call('SET', 'k', 1e300) return redis.call('GET', 'k')"), ev("redis.call('SET', 'k', 100) return redis.call('GET', 'k')")]),

  // integer arguments at the int64 and int32 edges (see differential.probes)
  ...intProbes('EVAL numkeys', ['EVAL "return 1" $N', 'EVALSHA e0e1f9fabfc9d4800c877a703b823ac0578ff8db $N', 'FCALL f $N', 'FCALL_RO f $N']),
  ...intProbes('EVAL_RO numkeys', ['EVAL_RO "return 1" $N', 'EVALSHA_RO e0e1f9fabfc9d4800c877a703b823ac0578ff8db $N']),
]);
