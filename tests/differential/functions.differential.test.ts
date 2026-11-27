import { expect, it } from 'vitest';

import { differential, s, v } from './differential.harness';
import type { StepObject } from './differential.harness';
import { sorted, sortedDeep } from './differential.normalizers';
import { intProbes } from './differential.probes';
import { parseResp, payload, show } from './differential.resp';

/** FUNCTION LOAD [REPLACE] of a library source. */
function load(code: string, replace = false): StepObject {
  return { cmd: ['FUNCTION', 'LOAD', ...(replace ? ['REPLACE'] : []), code] };
}

/** A library `name` registering `fns` (each `return <body>`), all with the given flags. */
function lib(name: string, fns: Record<string, string>): string {
  const body = Object.entries(fns).map(([f, ret]) => `redis.register_function('${f}', function(keys, args) return ${ret} end)`);
  return `#!lua name=${name}\n${body.join('\n')}`;
}

const MYLIB = lib('mylib', { myfunc: "'hello'" });
const ECHO = "#!lua name=echo\nredis.register_function('echo', function(keys, args) return {keys, args} end)";
const RW = [
  '#!lua name=rw',
  "redis.register_function('setter', function(keys, args) return redis.call('SET', keys[1], args[1]) end)",
  "redis.register_function{function_name = 'getter', callback = function(keys) return redis.call('GET', keys[1]) end, flags = {'no-writes'}}",
  "redis.register_function{function_name = 'badro', callback = function(keys) return redis.call('SET', keys[1], 'x') end, flags = {'no-writes'}}",
].join('\n');

differential(
  'functions',
  [
    // FUNCTION LOAD
    s('FUNCTION LOAD and FCALL', [load(MYLIB), 'FCALL myfunc 0', 'FCALL myfunc 1 k a']),
    s('FCALL function name is case insensitive', [load(MYLIB), 'FCALL MYFUNC 0', 'FCALL_RO MyFunc 0']),
    s('FUNCTION LOAD existing library', [load(MYLIB), load(MYLIB), load(MYLIB, true), load(lib('mylib', { other: '2' }), true), 'FCALL other 0', 'FCALL myfunc 0']),
    s('FUNCTION LOAD metadata errors', [load("redis.register_function('f', function() return 1 end)"), load('#!lua\nreturn 1'), load('#!js name=x\nreturn 1'), load('#!lua name=x foo=bar\nreturn 1'), load('#!lua name=\nreturn 1'), load('#!lua name=bad-name\nreturn 1'), load('#!lua name=x name=y\nreturn 1'), load('#! name=x\nreturn 1')]),
    s('FUNCTION LOAD without functions', [load('#!lua name=empty\nreturn 1'), load('#!lua name=empty\nlocal x = 1')]),
    s('FUNCTION LOAD compile and runtime errors', [load('#!lua name=x\nreturn +'), load('#!lua name=x\nreturn nosuch.x')]),
    s('FUNCTION LOAD calling error()', [load("#!lua name=x\nerror('boom')")]),
    s('FUNCTION LOAD calling redis.call', [load("#!lua name=x\nredis.call('SET', 'k', 'v')")]),
    s('FUNCTION LOAD REPLACE without code', ['FUNCTION LOAD REPLACE']),
    s('FUNCTION LOAD arity', ['FUNCTION LOAD']),
    s('FUNCTION LOAD unknown option', [{ cmd: ['FUNCTION', 'LOAD', 'FOO', MYLIB] }]),
    s('FUNCTION LOAD trailing argument', [{ cmd: ['FUNCTION', 'LOAD', MYLIB, 'extra'] }]),
    s('register_function errors', [
      load("#!lua name=x\nredis.register_function('f')"),
      load("#!lua name=x\nredis.register_function('f', 'notafunction')"),
      load("#!lua name=x\nredis.register_function('f', function() end)\nredis.register_function('f', function() end)"),
      load("#!lua name=x\nredis.register_function{function_name = 'f', callback = function() end, flags = {'nosuch'}}"),
      load("#!lua name=x\nredis.register_function{function_name = 'f', callback = function() end, foo = 1}"),
      load("#!lua name=x\nredis.register_function{callback = function() end}"),
      load("#!lua name=x\nredis.register_function{function_name = 'f', callback = function() end, flags = 'no-writes'}"),
      load('#!lua name=x\nredis.register_function()'),
    ]),
    s('register_function invalid name text', [load("#!lua name=x\nredis.register_function('bad-name', function() end)")], v("invalid function names were reported with the 'Library names can only contain' text in 7.0; later versions say 'Function names'", 'low')),
    s('function globals', [load(lib('g', { types: "{type(KEYS), type(ARGV), type(os), type(__redis__err__handler)}" })), 'FCALL types 0', load(lib('g2', { gl: "(function() local t = {} for k in pairs(_G) do t[#t + 1] = k end table.sort(t) return t end)()" })), 'FCALL gl 0', load(lib('g3', { genv: "{tostring(_G == getfenv(0)), tostring(rawget(_G, 'KEYS')), tostring(rawget(_G, 'redis') ~= nil), type(getmetatable(_G))}" })), 'FCALL genv 0', load(lib('g4', { gk: 'KEYS' })), 'FCALL gk 0', load(lib('g5', { ga: '_G.ARGV' })), 'FCALL ga 0']),
    s('function errors from redis.call', [load(lib('e', { e1: "(function() local ok, e = pcall(redis.call, 'NOSUCH') return {type(e), e} end)()", e2: "redis.call('INCR', 'k', 'x')" })), 'FCALL e1 0', 'FCALL e2 0', load("#!lua name=bad\nerror({err = 5})")]),
    s('function error table without err', [load("#!lua name=t\nredis.register_function('t', function() error({foo = 1}) end)"), 'FCALL t 0'], { fresh: true }),
    s('function name already in another library', [load(MYLIB), load(lib('other', { myfunc: '1' }))]),
    s('register_function with description and flags', [load("#!lua name=d\nredis.register_function{function_name = 'f', callback = function() return 1 end, description = 'desc', flags = {'no-writes', 'allow-oom', 'allow-stale', 'no-cluster', 'allow-cross-slot-keys'}}"), 'FCALL_RO f 0', 'FUNCTION LIST']),
    s('redis.call unavailable while loading', [load("#!lua name=x\nreturn redis.call('PING')"), load('#!lua name=x\nreturn redis.setresp(3)')]),
    s('redis.log available while loading', [load("#!lua name=x\nredis.log(redis.LOG_WARNING, 'loading')\nredis.register_function('f', function() return 1 end)"), 'FCALL f 0']),
    s('register_function at runtime', [load("#!lua name=x\nredis.register_function('f', function() redis.register_function('g', function() end) end)"), 'FCALL f 0']),

    // FCALL / FCALL_RO
    s('FCALL keys and args', [load(ECHO), 'FCALL echo 2 k1 k2 a1 a2', 'FCALL echo 0', 'FCALL echo 0 a']),
    s('FCALL errors', [load(ECHO), 'FCALL nosuch 0', 'FCALL echo -1', 'FCALL echo 3 a', 'FCALL echo', 'FCALL']),
    s('FCALL non-numeric numkeys', [load(ECHO), 'FCALL echo x', 'FCALL echo 1.5 a']),
    s('FCALL read write flags', [load(RW), 'FCALL setter 1 k v', 'FCALL getter 1 k', 'FCALL_RO getter 1 k', 'FCALL_RO setter 1 k v', 'FCALL_RO nosuch 0']),
    s('FCALL write in no-writes function', [load(RW), 'FCALL badro 1 k']),
    s('FCALL runtime errors', [load("#!lua name=e\nredis.register_function('boom', function() error('boom') end)\nredis.register_function('wt', function() return redis.call('LLEN', 's') end)"), 'SET s v', 'FCALL boom 0', 'FCALL wt 0']),
    s('FCALL error table', [load("#!lua name=e\nredis.register_function('e', function() return {err = 'MYERR custom'} end)\nredis.register_function('st', function() return redis.status_reply('FINE') end)"), 'FCALL e 0', 'FCALL st 0']),
    s('FCALL return conversions', [load("#!lua name=c\nredis.register_function('c', function() return {1, 2.9, 'x', true, false, {ok = 'S'}} end)"), 'FCALL c 0']),
    s('FCALL setresp 3', [load("#!lua name=r\nredis.register_function('r', function() redis.setresp(3) return redis.call('HGETALL', 'h') end)"), 'HSET h a 1', 'FCALL r 0']),
    s('functions share library locals', [load("#!lua name=s\nlocal function helper(x) return x * 2 end\nredis.register_function('a', function(k, a) return helper(tonumber(a[1])) end)\nredis.register_function('b', function() return helper(21) end)"), 'FCALL a 0 5', 'FCALL b 0']),
    s('function cannot create globals', [load("#!lua name=g\nredis.register_function('g', function() x = 1 return 1 end)"), 'FCALL g 0']),
    s('FCALL inside MULTI', [load(MYLIB), 'MULTI', 'FCALL myfunc 0', 'EXEC']),
    s('FCALL from EVAL', [load(MYLIB), { cmd: ['EVAL', "return redis.call('FCALL', 'myfunc', 0)", '0'] }]),

    // FUNCTION LIST / DELETE / FLUSH / STATS
    s('FUNCTION LIST', [load(MYLIB), 'FUNCTION LIST', 'FUNCTION LIST WITHCODE', 'FUNCTION LIST LIBRARYNAME my*', 'FUNCTION LIST LIBRARYNAME nomatch', 'FUNCTION LIST WITHCODE LIBRARYNAME mylib']),
    s('FUNCTION LIST several libraries', [load(MYLIB), load(ECHO), load(RW), { cmd: 'FUNCTION LIST', norm: sortedDeep }, { cmd: 'FUNCTION LIST LIBRARYNAME e*', norm: sortedDeep }]),
    s('FUNCTION LIST unknown argument', ['FUNCTION LIST FOO']),
    s('FUNCTION LIST LIBRARYNAME without pattern', ['FUNCTION LIST LIBRARYNAME']),
    s('FUNCTION LIST repeated WITHCODE', ['FUNCTION LIST WITHCODE WITHCODE']),
    s('FUNCTION LIST repeated LIBRARYNAME', ['FUNCTION LIST LIBRARYNAME a LIBRARYNAME b']),
    s('FUNCTION LIST empty', ['FUNCTION LIST']),
    s('FUNCTION DELETE', [load(MYLIB), 'FUNCTION DELETE mylib', 'FUNCTION DELETE mylib', 'FCALL myfunc 0', 'FUNCTION DELETE', 'FUNCTION DELETE a b']),
    s('FUNCTION FLUSH', [load(MYLIB), 'FUNCTION FLUSH', 'FUNCTION LIST', load(MYLIB), 'FUNCTION FLUSH ASYNC', load(MYLIB), 'FUNCTION FLUSH SYNC']),
    s('FUNCTION FLUSH bad option', ['FUNCTION FLUSH FOO', 'FUNCTION FLUSH SYNC ASYNC']),
    s('FUNCTION STATS', ['FUNCTION STATS', load(MYLIB), load(RW), 'FUNCTION STATS', 'FUNCTION STATS x']),
    s('FUNCTION KILL and errors', ['FUNCTION KILL', 'FUNCTION', 'FUNCTION FOO', 'FUNCTION KILL x']),
    s('FUNCTION HELP', ['FUNCTION HELP'], v('the HELP footer reads "Print this help." in newer Redis (7.0: "Prints this help.")', 'medium')),
    s('FUNCTION RESTORE bad payload', ['FUNCTION RESTORE garbage']),
    s('FUNCTION RESTORE arity', ['FUNCTION RESTORE']),
    s('FUNCTION RESTORE unknown policy', ['FUNCTION RESTORE "" FOO']),
    s('FUNCTION RESTORE trailing argument', ['FUNCTION RESTORE x APPEND extra']),
    s('FUNCTION LIST after FLUSHALL keeps functions', [load(MYLIB), 'FLUSHALL', { cmd: 'FUNCTION LIST', norm: sorted }]),

    // integer arguments at the int64 and int32 edges (see differential.probes): the function is looked up first
    ...intProbes('FCALL numkeys', ['FCALL nofunc $N', 'FCALL_RO nofunc $N', load(MYLIB), 'FCALL myfunc $N', 'FCALL_RO myfunc $N']),
  ],
  ({ env }) => {
    // FUNCTION DUMP payloads embed the RDB version, so they are not compared byte for byte: a payload dumped by each
    // server is restored into that same server, and the oracle's (older RDB) payload is also fed to redis-lite.
    const steps = (dump: string): string[][] => [
      ['FUNCTION', 'RESTORE', dump],
      ['FUNCTION', 'RESTORE', dump, 'APPEND'],
      ['FUNCTION', 'RESTORE', dump, 'REPLACE'],
      ['FCALL', 'myfunc', '0'],
      ['FUNCTION', 'FLUSH'],
      ['FUNCTION', 'LOAD', lib('mylib', { other: '7' })],
      ['FUNCTION', 'RESTORE', dump, 'REPLACE'],
      ['FCALL', 'other', '0'],
      ['FUNCTION', 'LOAD', lib('extra', { extra: '1' })],
      ['FUNCTION', 'RESTORE', dump, 'FLUSH'],
      ['FCALL', 'extra', '0'],
      ['FUNCTION', 'RESTORE', dump, 'BAD'],
      ['FUNCTION', 'LIST', 'WITHCODE'],
    ];
    for (const proto of [2, 3] as const) {
      for (const source of ['own', 'oracle'] as const) {
        it(`FUNCTION DUMP / RESTORE policies (${source} payload) [RESP${proto}]`, async () => {
          const { oracle, lite, close } = await env().pair(proto);
          try {
            const run = async (c: typeof oracle, dump: string): Promise<string[]> => {
              const out: string[] = [];
              for (const cmd of steps(dump)) out.push(show(await c.call(cmd)));
              return out;
            };
            const dumpOf = async (c: typeof oracle): Promise<string> => {
              await c.call(['FUNCTION', 'LOAD', MYLIB]);
              const d = payload(parseResp(await c.call(['FUNCTION', 'DUMP'])).node);
              await c.call(['FUNCTION', 'FLUSH']);
              return d;
            };
            const oracleDump = await dumpOf(oracle);
            const liteDump = source === 'own' ? await dumpOf(lite) : oracleDump;
            expect(await run(lite, liteDump)).toEqual(await run(oracle, oracleDump));
          } finally {
            await close();
          }
        });
      }
    }
  },
);
