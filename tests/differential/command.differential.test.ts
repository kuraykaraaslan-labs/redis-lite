import { expect, it } from 'vitest';

import { differential, s } from './differential.harness';
import { commandInfo, sorted, sortedDeep } from './differential.normalizers';
import { parseResp, payload } from './differential.resp';
import type { RespNode } from './differential.resp';

/** Commands compared with COMMAND INFO (RESP2: the RESP3 types are covered by the dedicated scenarios). */
const INFO = ['get', 'expire', 'incr', 'lpush', 'lrange', 'lmove', 'hset', 'sadd', 'zadd', 'zrange', 'zrangestore', 'xread',
  'evalsha', 'publish', 'subscribe', 'echo', 'select', 'type', 'rename', 'multi', 'exec', 'watch', 'getdel', 'setrange',
  'bitcount', 'bitop', 'pfadd', 'geoadd', 'georadius', 'lcs', 'copy', 'restore', 'expiretime', 'append', 'strlen', 'hdel',
  'hincrby', 'lindex', 'linsert', 'rpoplpush', 'sintercard', 'zunionstore', 'zscore', 'xack', 'getbit', 'setbit',
  'bitfield_ro', 'persist', 'pexpire', 'renamenx', 'lmpop', 'zmpop', 'incrbyfloat', 'psetex', 'setnx', 'hmget',
  'zrevrange', 'zrangebyscore', 'zlexcount', 'geosearch', 'geosearchstore', 'geodist', 'pfmerge', 'xrange', 'xlen', 'xdel',
  'unwatch', 'discard', 'auth', 'hello', 'reset', 'quit', 'swapdb', 'psubscribe', 'punsubscribe', 'readonly', 'set', 'getex',
  'pfcount', 'eval', 'fcall', 'sort', 'sort_ro', 'bitfield', 'xadd', 'del', 'exists', 'ttl', 'mget', 'mset', 'hgetall',
  'smembers', 'ping', 'keys', 'info', 'dbsize', 'flushall', 'time', 'dump', 'spop', 'srandmember', 'hrandfield',
  'zrandmember', 'sinter', 'xclaim', 'unlink', 'touch', 'msetnx', 'hscan', 'sscan', 'zscan', 'xtrim', 'xpending', 'zrank',
  'zrevrank'];

/** The ACL categories of Redis 7.0.15. */
const ACL_CATEGORIES = ['keyspace', 'read', 'write', 'set', 'sortedset', 'list', 'hash', 'string', 'bitmap', 'hyperloglog',
  'geo', 'stream', 'pubsub', 'admin', 'fast', 'slow', 'blocking', 'dangerous', 'connection', 'transaction', 'scripting'];

/** Commands whose COMMAND DOCS since / group / argument tree are compared field by field. */
const DOCS = ['get', 'set', 'del', 'expire', 'lpush', 'lpos', 'hset', 'sadd', 'zadd', 'zrange', 'xadd', 'xread', 'eval',
  'publish', 'ping', 'select', 'client', 'config', 'scan', 'sort', 'bitfield', 'geosearch', 'lmpop', 'getex', 'copy'];

differential('command', [
  // COMMAND INFO per command
  ...INFO.map((cmd) => s(`COMMAND INFO ${cmd}`, [`COMMAND INFO ${cmd}`], { proto: 2, norm: commandInfo })),
  s('COMMAND INFO of container commands (subcommands sorted)', [
    { cmd: 'COMMAND INFO config', norm: commandInfo }, { cmd: 'COMMAND INFO xinfo', norm: commandInfo },
  ], { proto: 2 }),
  s('COMMAND INFO legacy key positions of sharded pub/sub', ['COMMAND INFO ssubscribe', 'COMMAND INFO spublish'], { proto: 2 }),
  s('COMMAND INFO lpos key-spec flags', ['COMMAND INFO lpos'], { proto: 2 }),
  s('COMMAND INFO smove key-spec flags', ['COMMAND INFO smove'], { proto: 2 }),
  s('COMMAND INFO move key-spec flags', ['COMMAND INFO move'], { proto: 2 }),
  s('COMMAND INFO xautoclaim key-spec flags', ['COMMAND INFO xautoclaim'], { proto: 2 }),
  s('COMMAND INFO xreadgroup key-spec flags', ['COMMAND INFO xreadgroup'], { proto: 2 }),
  s('COMMAND INFO blocking commands flags', ['COMMAND INFO blpop', 'COMMAND INFO bzpopmin', 'COMMAND INFO brpoplpush'], { proto: 2 }),
  s('COMMAND INFO scan and randomkey tips', ['COMMAND INFO scan', 'COMMAND INFO randomkey'], { proto: 2 }),
  s('COMMAND INFO of an unknown command', ['COMMAND INFO nosuch']),
  s('COMMAND INFO mixes known and unknown commands', [{ cmd: 'COMMAND INFO get nosuch echo', norm: commandInfo }], { proto: 2 }),
  s('COMMAND INFO of a subcommand', ['COMMAND INFO config|get', 'COMMAND INFO client|id'], { proto: 2 }),
  s('COMMAND INFO of an unknown subcommand', ['COMMAND INFO config|nosuch', 'COMMAND INFO get|x']),
  s('COMMAND INFO is case-insensitive', ['COMMAND INFO GET'], { proto: 2 }),
  s('COMMAND INFO key specs and subcommands in RESP3', ['COMMAND INFO get'], { proto: 3 }),
  s('COMMAND INFO keyless command in RESP3', ['COMMAND INFO echo'], { proto: 3 }),
  s('COMMAND INFO tips in RESP3', ['COMMAND INFO dbsize'], { proto: 3 }),

  // COMMAND COUNT / LIST / DOCS / HELP
  s('COMMAND COUNT', ['COMMAND COUNT']),
  s('COMMAND COUNT arity', ['COMMAND COUNT x']),
  s('COMMAND LIST FILTERBY pattern', [{ cmd: 'COMMAND LIST FILTERBY pattern xa*', norm: sorted }]),
  s('COMMAND LIST FILTERBY pattern with a class', [{ cmd: 'COMMAND LIST FILTERBY pattern [bl]pop', norm: sorted }]),
  s('COMMAND LIST FILTERBY pattern matching subcommands', [{ cmd: 'COMMAND LIST FILTERBY pattern config*', norm: sorted }]),
  s('COMMAND LIST FILTERBY pattern matching nothing', ['COMMAND LIST FILTERBY pattern zzz*']),
  s('COMMAND LIST FILTERBY aclcat unknown', ['COMMAND LIST FILTERBY aclcat nosuch']),
  s('COMMAND LIST FILTERBY module', ['COMMAND LIST FILTERBY module x']),
  s('COMMAND LIST FILTERBY errors', ['COMMAND LIST FILTERBY bogus x', 'COMMAND LIST bogus', 'COMMAND LIST FILTERBY pattern', 'COMMAND LIST FILTERBY']),
  s('COMMAND DOCS of an unknown command', ['COMMAND DOCS nosuch']),
  s('COMMAND DOCS of get', ['COMMAND DOCS get']),
  s('COMMAND HELP', ['COMMAND HELP']),
  s('COMMAND DOCS with history, doc flags and deprecation', ['COMMAND DOCS hset', 'COMMAND DOCS getset', 'COMMAND DOCS slaveof']),
  s('COMMAND DOCS of a container and of several commands', [{ cmd: 'COMMAND DOCS memory', norm: sortedDeep }, 'COMMAND DOCS get nosuch echo']),
  s('COMMAND DOCS of a subcommand', ['COMMAND DOCS client|kill', 'COMMAND DOCS config|set']),
  s('COMMAND INFO of a container in RESP3', [{ cmd: 'COMMAND INFO slowlog', norm: commandInfo }], { proto: 3 }),
  s('COMMAND INFO of commands removed or added around 7.0', ['COMMAND INFO hexpire', 'COMMAND INFO waitaof', 'COMMAND INFO client|no-touch']),

  // <CMD> HELP of every container (the other containers' HELP scenarios live in their own suites)
  ...['ACL', 'CLIENT', 'CLUSTER', 'MEMORY', 'LATENCY', 'MODULE', 'DEBUG'].map((cmd) => s(`${cmd} HELP`, [`${cmd} HELP`])),

  // ACL CAT of every category (derived from the table)
  ...ACL_CATEGORIES.map((cat) => s(`ACL CAT ${cat}`, [{ cmd: `ACL CAT ${cat}`, norm: sorted }])),
  ...ACL_CATEGORIES.map((cat) => s(`COMMAND LIST FILTERBY aclcat ${cat}`, [{ cmd: `COMMAND LIST FILTERBY aclcat ${cat}`, norm: sorted }])),
  s('COMMAND unknown subcommand', ['COMMAND bogus', 'COMMAND bogus x']),

  // COMMAND GETKEYS / GETKEYSANDFLAGS
  s('COMMAND GETKEYS single key', ['COMMAND GETKEYS set a b', 'COMMAND GETKEYS get k']),
  s('COMMAND GETKEYS multiple keys', ['COMMAND GETKEYS mset a 1 b 2', 'COMMAND GETKEYS mget a b c', 'COMMAND GETKEYS del x y']),
  s('COMMAND GETKEYS with numkeys', ['COMMAND GETKEYS zunionstore d 2 a b', 'COMMAND GETKEYS eval "return 1" 2 a b', 'COMMAND GETKEYS lmpop 2 a b left']),
  s('COMMAND GETKEYS eval with zero keys', ['COMMAND GETKEYS eval "return 1" 0']),
  s('COMMAND GETKEYS eval with numkeys past the arguments', ['COMMAND GETKEYS eval "return 1" 5 a b']),
  s('COMMAND GETKEYS keyword-based keys', ['COMMAND GETKEYS sort a store b', 'COMMAND GETKEYS xread streams a b 0 0',
    'COMMAND GETKEYS xreadgroup group g c streams s 0', 'COMMAND GETKEYS georadius k 0 0 1 m store d']),
  s('COMMAND GETKEYS of a two-key command', ['COMMAND GETKEYS lmove a b left right', 'COMMAND GETKEYS rename a b', 'COMMAND GETKEYS copy a b']),
  s('COMMAND GETKEYS unknown command', ['COMMAND GETKEYS nosuch a']),
  s('COMMAND GETKEYS arity', ['COMMAND GETKEYS']),
  s('COMMAND GETKEYS with a wrong arity for the target', ['COMMAND GETKEYS get']),
  s('COMMAND GETKEYS of a keyless command', ['COMMAND GETKEYS ping']),
  s('COMMAND GETKEYS target arity and keyless targets', ['COMMAND GETKEYS ping x', 'COMMAND GETKEYS get a b', 'COMMAND GETKEYS set a']),
  s('COMMAND GETKEYS of a subcommand with keys', ['COMMAND GETKEYS object encoding k', 'COMMAND GETKEYS memory usage k']),
  s('COMMAND GETKEYS is case-insensitive', ['COMMAND GETKEYS SET a b']),
  s('COMMAND GETKEYSANDFLAGS of SET without GET', ['COMMAND GETKEYSANDFLAGS set a b']),
  s('COMMAND GETKEYSANDFLAGS of SET with GET', ['COMMAND GETKEYSANDFLAGS set a b get']),
  s('COMMAND GETKEYSANDFLAGS of LMOVE', ['COMMAND GETKEYSANDFLAGS lmove a b left right']),
  s('COMMAND GETKEYSANDFLAGS of MSET', ['COMMAND GETKEYSANDFLAGS mset a 1 b 2']),
  s('COMMAND GETKEYSANDFLAGS of GET', ['COMMAND GETKEYSANDFLAGS get k']),
  s('COMMAND GETKEYSANDFLAGS of SORT STORE', ['COMMAND GETKEYSANDFLAGS sort a store b']),
  s('COMMAND GETKEYSANDFLAGS unknown command', ['COMMAND GETKEYSANDFLAGS nosuch a']),
  s('COMMAND GETKEYSANDFLAGS arity', ['COMMAND GETKEYSANDFLAGS']),
], ({ env }) => {
  // COMMAND DOCS: since, group and the argument tree (names, types, flags) must match
  const field = (map: RespNode, key: string): RespNode | undefined => {
    for (let i = 0; i < map.children.length; i += 2) if (payload(map.children[i]) === key) return map.children[i + 1];
    return undefined;
  };
  const args = (list: RespNode | undefined): unknown =>
    (list?.children ?? []).map((a) => ({
      name: payload(field(a, 'name') as RespNode),
      type: payload(field(a, 'type') as RespNode),
      token: field(a, 'token') && payload(field(a, 'token') as RespNode),
      flags: field(a, 'flags')?.children.map((f) => f.raw),
      args: args(field(a, 'arguments')),
    }));
  const docs = (reply: string): unknown => {
    const node = parseResp(reply).node;
    const out: Record<string, unknown> = {};
    for (let i = 0; i < node.children.length; i += 2) {
      const d = node.children[i + 1];
      out[payload(node.children[i])] = { since: payload(field(d, 'since') as RespNode), group: payload(field(d, 'group') as RespNode),
        arguments: args(field(d, 'arguments')) };
    }
    return out;
  };
  for (const cmd of DOCS) {
    it(`COMMAND DOCS ${cmd}: since, group and arguments`, async () => {
      const p = await env().pair(2);
      try {
        const o = docs(await p.oracle.call(['COMMAND', 'DOCS', cmd]));
        const l = docs(await p.lite.call(['COMMAND', 'DOCS', cmd]));
        expect(l).toEqual(o);
      } finally {
        await p.close();
      }
    });
  }
});
