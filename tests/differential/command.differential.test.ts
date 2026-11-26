import { expect, it } from 'vitest';

import { differential, s, v } from './differential.harness';
import type { Scenario } from './differential.harness';
import { commandInfo, sorted } from './differential.normalizers';
import { parseResp, payload } from './differential.resp';
import type { RespNode } from './differential.resp';

const TIPS_TYPE = 'command tips are simple strings in newer Redis (7.0 sends bulk strings); no confirmed version';
const KEY_SPEC_NOTES = 'key-spec "notes" are missing in redis-lite';

/**
 * Commands compared with COMMAND INFO over RESP2 (RESP3 differs for every keyed command, see the dedicated scenario).
 * A command mapped to a reason is a known mismatch (see the classification in the report).
 */
const INFO: Record<string, string | [string, 'high' | 'medium' | 'low'] | null> = {
  get: null, expire: null, incr: null, lpush: null, lrange: null, lmove: null, hset: null, sadd: null, zadd: null,
  zrange: null, zrangestore: null, xread: null, evalsha: null, publish: null, subscribe: null, echo: null, select: null,
  type: null, rename: null, multi: null, exec: null, watch: null, getdel: null, setrange: null, bitcount: null, bitop: null,
  pfadd: null, geoadd: null, georadius: null, lcs: null, copy: null, restore: null, expiretime: null, append: null,
  strlen: null, hdel: null, hincrby: null, lindex: null, linsert: null, rpoplpush: null, sintercard: null,
  zunionstore: null, zscore: null, xack: null, getbit: null, setbit: null, bitfield_ro: null, persist: null, pexpire: null, renamenx: null, lmpop: null, zmpop: null, incrbyfloat: null, psetex: null,
  setnx: null, hmget: null, zrevrange: null, zrangebyscore: null,
  zlexcount: null, geosearch: null, geosearchstore: null, geodist: null, pfmerge: null, xrange: null, xlen: null,
  xdel: null, unwatch: null, discard: null, auth: null, hello: null, reset: null,
  quit: null, swapdb: null, psubscribe: null, punsubscribe: null, readonly: null,
  set: KEY_SPEC_NOTES, getex: KEY_SPEC_NOTES, pfcount: KEY_SPEC_NOTES, eval: KEY_SPEC_NOTES, fcall: KEY_SPEC_NOTES,
  sort: KEY_SPEC_NOTES, sort_ro: KEY_SPEC_NOTES, bitfield: KEY_SPEC_NOTES,
  // key specs (incl. notes) match; only the tips reply type differs
  xadd: [TIPS_TYPE, 'low'],
  del: [TIPS_TYPE, 'low'], exists: [TIPS_TYPE, 'low'], ttl: [TIPS_TYPE, 'low'], mget: [TIPS_TYPE, 'low'],
  mset: [TIPS_TYPE, 'low'], hgetall: [TIPS_TYPE, 'low'], smembers: [TIPS_TYPE, 'low'], ping: [TIPS_TYPE, 'low'],
  keys: [TIPS_TYPE, 'low'], info: [TIPS_TYPE, 'low'], dbsize: [TIPS_TYPE, 'low'], flushall: [TIPS_TYPE, 'low'],
  time: [TIPS_TYPE, 'low'], dump: [TIPS_TYPE, 'low'], spop: [TIPS_TYPE, 'low'], srandmember: [TIPS_TYPE, 'low'],
  hrandfield: [TIPS_TYPE, 'low'], zrandmember: [TIPS_TYPE, 'low'], sinter: [TIPS_TYPE, 'low'], xclaim: [TIPS_TYPE, 'low'],
  unlink: [TIPS_TYPE, 'low'], touch: [TIPS_TYPE, 'low'], msetnx: [TIPS_TYPE, 'low'], hscan: [TIPS_TYPE, 'low'],
  sscan: [TIPS_TYPE, 'low'], zscan: [TIPS_TYPE, 'low'], xtrim: [TIPS_TYPE, 'low'], xpending: [TIPS_TYPE, 'low'],
};

function infoScenario(cmd: string): Scenario {
  const known = INFO[cmd];
  if (known === null || known === KEY_SPEC_NOTES) return s(`COMMAND INFO ${cmd}`, [`COMMAND INFO ${cmd}`], { proto: 2, norm: commandInfo });
  const [why, confidence] = Array.isArray(known) ? known : [known, 'low' as const];
  return s(`COMMAND INFO ${cmd}`, [`COMMAND INFO ${cmd}`], { proto: 2, norm: commandInfo, ...v(why, confidence) });
}

/** Commands whose COMMAND DOCS since / group / argument tree are compared by hand (summaries were rewritten in 7.2). */
/** DOCS commands whose argument names were renamed in 7.2 (data, id-selector, count-block, …). */
const RENAMED = new Set(['hset', 'zadd', 'zrange', 'xadd', 'sort', 'bitfield', 'geosearch']);

const DOCS = ['get', 'set', 'del', 'expire', 'lpush', 'lpos', 'hset', 'sadd', 'zadd', 'zrange', 'xadd', 'xread', 'eval',
  'publish', 'ping', 'select', 'client', 'config', 'scan', 'sort', 'bitfield', 'geosearch', 'lmpop', 'getex', 'copy'];

differential('command', [
  // COMMAND INFO per command
  ...Object.keys(INFO).map(infoScenario),
  s('COMMAND INFO of container commands (subcommands sorted)', [
    { cmd: 'COMMAND INFO config', norm: commandInfo }, { cmd: 'COMMAND INFO xinfo', norm: commandInfo },
  ], { proto: 2, ...v('CONFIG and XINFO subcommands gained request/response policy tips or flags after 7.0 (e.g. CONFIG GET/SET policies)', 'low') }),
  s('COMMAND INFO legacy key positions of sharded pub/sub', ['COMMAND INFO ssubscribe', 'COMMAND INFO spublish'], { proto: 2 }),
  s('COMMAND INFO lpos key-spec flags', ['COMMAND INFO lpos'], { proto: 2 }),
  s('COMMAND INFO smove key-spec flags', ['COMMAND INFO smove'], { proto: 2 }),
  s('COMMAND INFO move key-spec flags', ['COMMAND INFO move'], { proto: 2 }),
  s('COMMAND INFO xautoclaim key-spec flags', ['COMMAND INFO xautoclaim'], { proto: 2, ...v(`${TIPS_TYPE} (key-spec flags match)`, 'low') }),
  s('COMMAND INFO xreadgroup key-spec flags', ['COMMAND INFO xreadgroup'], { proto: 2 }),
  s('COMMAND INFO blocking commands flags', ['COMMAND INFO blpop', 'COMMAND INFO bzpopmin', 'COMMAND INFO brpoplpush'],
    { proto: 2, ...v('blocking commands lost the noscript flag after 7.0 (unverified)', 'low') }),
  s('COMMAND INFO scan and randomkey tips', ['COMMAND INFO scan', 'COMMAND INFO randomkey'],
    { proto: 2, ...v('response_policy:special tip added to SCAN / RANDOMKEY after 7.0 (unverified)', 'low') }),
  s('COMMAND INFO of an unknown command', ['COMMAND INFO nosuch']),
  s('COMMAND INFO mixes known and unknown commands', [{ cmd: 'COMMAND INFO get nosuch echo', norm: commandInfo }], { proto: 2 }),
  s('COMMAND INFO of a subcommand', ['COMMAND INFO config|get', 'COMMAND INFO client|id'], { proto: 2 }),
  s('COMMAND INFO of an unknown subcommand', ['COMMAND INFO config|nosuch', 'COMMAND INFO get|x']),
  s('COMMAND INFO is case-insensitive', ['COMMAND INFO GET'], { proto: 2 }),
  s('COMMAND INFO key specs and subcommands in RESP3', ['COMMAND INFO get'],
    { proto: 3, ...v('RESP3 COMMAND INFO sends key specs / subcommands as arrays in newer Redis (7.0: sets); no confirmed version', 'low') }),
  s('COMMAND INFO keyless command in RESP3', ['COMMAND INFO echo'],
    { proto: 3, ...v('RESP3 COMMAND INFO sends key specs / subcommands as arrays in newer Redis (7.0: sets); no confirmed version', 'low') }),
  s('COMMAND INFO tips in RESP3', ['COMMAND INFO dbsize'], { proto: 3, ...v(TIPS_TYPE, 'low') }),

  // COMMAND COUNT / LIST / DOCS / HELP
  s('COMMAND COUNT', ['COMMAND COUNT'], v('Redis 8.x has more commands than 7.0 (hash field expiration, vector sets, …)')),
  s('COMMAND COUNT arity', ['COMMAND COUNT x']),
  s('COMMAND LIST FILTERBY pattern', [{ cmd: 'COMMAND LIST FILTERBY pattern xa*', norm: sorted }]),
  s('COMMAND LIST FILTERBY pattern with a class', [{ cmd: 'COMMAND LIST FILTERBY pattern [bl]pop', norm: sorted }]),
  s('COMMAND LIST FILTERBY pattern matching subcommands', [{ cmd: 'COMMAND LIST FILTERBY pattern config*', norm: sorted }]),
  s('COMMAND LIST FILTERBY pattern matching nothing', ['COMMAND LIST FILTERBY pattern zzz*']),
  s('COMMAND LIST FILTERBY aclcat hyperloglog', [{ cmd: 'COMMAND LIST FILTERBY aclcat hyperloglog', norm: sorted }]),
  s('COMMAND LIST FILTERBY aclcat geo', [{ cmd: 'COMMAND LIST FILTERBY aclcat geo', norm: sorted }]),
  s('COMMAND LIST FILTERBY aclcat bitmap', [{ cmd: 'COMMAND LIST FILTERBY aclcat bitmap', norm: sorted }]),
  s('COMMAND LIST FILTERBY aclcat unknown', ['COMMAND LIST FILTERBY aclcat nosuch']),
  s('COMMAND LIST FILTERBY module', ['COMMAND LIST FILTERBY module x']),
  s('COMMAND LIST FILTERBY errors', ['COMMAND LIST FILTERBY bogus x', 'COMMAND LIST bogus', 'COMMAND LIST FILTERBY pattern', 'COMMAND LIST FILTERBY']),
  s('COMMAND DOCS of an unknown command', ['COMMAND DOCS nosuch']),
  s('COMMAND DOCS of get', ['COMMAND DOCS get'], v('command summaries were rewritten and display_text was added to arguments in 7.2')),
  s('COMMAND HELP', ['COMMAND HELP'], v('the HELP footer reads "Print this help." in newer Redis (7.0: "Prints this help.")', 'medium')),
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
  s('COMMAND GETKEYS with a wrong arity for the target', ['COMMAND GETKEYS get'],
    v('7.2 replies "Invalid number of arguments specified for command" (7.0: the COMMAND|GETKEYS arity error)', 'medium')),
  s('COMMAND GETKEYS of a keyless command', ['COMMAND GETKEYS ping'],
    v('7.2 replies "The command has no key arguments" (7.0: the COMMAND|GETKEYS arity error)', 'medium')),
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
  // COMMAND DOCS: since, group and the argument tree (names, types, flags) must match; summaries changed in 7.2
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
    const known = RENAMED.has(cmd);
    const title = `COMMAND DOCS ${cmd}: since, group and arguments${known ? ' (version: argument names renamed in 7.2)' : ''}`;
    (known ? it.fails : it)(title, async () => {
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
