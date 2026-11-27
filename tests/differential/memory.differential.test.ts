import { expect, it } from 'vitest';

import type { DiffConnection } from './differential.connection';
import { differential, s } from './differential.harness';
import type { Scenario } from './differential.harness';
import { text } from './differential.normalizers';
import type { Normalizer } from './differential.normalizers';
import { isAggregate, parseResp, payload, tokenize } from './differential.resp';
import type { RespNode } from './differential.resp';

/**
 * Memory accounting as Redis 7.0.15 computes it.
 *
 * - Exact: MEMORY USAGE (string allocations grown in place, value dicts while they rehash), the table sizes of DEBUG
 *   HTSTATS / HTSTATS-KEY, the MEMORY STATS per-db hash-table overhead, lua.caches / functions.caches, and the
 *   memory fields of CLIENT INFO.
 * - By delta (the hand-written tests at the end): used_memory / total.allocated and dataset.bytes after adding or
 *   removing keys of a given shape. Their absolute values depend on the process (startup allocations, command
 *   histograms, the harness's own control connection) and are never compared.
 */

// ============================================================================
// Normalisers
// ============================================================================

/** A RESP leaf as text; aggregates as `[a,b]`. */
function flat(node: RespNode): string {
  return isAggregate(node) ? `[${node.children.map(flat).join(',')}]` : payload(node);
}

/**
 * MEMORY STATS reduced to the named fields and every db.N block. Why: the other fields are process figures (startup
 * allocations, peak, allocator and RSS statistics, the control connection's client memory) the two servers cannot share.
 */
function statsPick(fields: string[]): Normalizer {
  return (reply) => {
    if (reply.startsWith('-') || reply.startsWith('<')) return reply;
    const node = parseResp(reply).node;
    const out: string[] = [];
    for (let i = 0; i + 1 < node.children.length; i += 2) {
      const key = payload(node.children[i]);
      if (fields.includes(key) || key.startsWith('db.')) out.push(`${key}=${flat(node.children[i + 1])}`);
    }
    return `+${out.join(' ')}\r\n`;
  };
}

/**
 * DEBUG HTSTATS / HTSTATS-KEY reduced to the table sizes (and which tables exist). Why: the element counts per table
 * while rehashing and the chain lengths depend on Redis's random hash seed.
 */
const tableSizes: Normalizer = text((s) =>
  s
    .split('\n')
    .filter((l) => /^\[|stats \(|table size:|No stats/.test(l))
    .join('\n'),
);

/** DEBUG HTSTATS / HTSTATS-KEY with the element counts too (exact when no rehash is running). */
const tableCounts: Normalizer = text((s) =>
  s
    .split('\n')
    .filter((l) => /^\[|stats \(|table size:|number of elements:|No stats/.test(l))
    .join('\n'),
);

/**
 * CLIENT INFO reduced to its memory fields. Why: ids, addresses, ages and fds differ by construction; rbp (the reply
 * buffer peak) is reset by serverCron at a time of its own.
 */
const clientMemory: Normalizer = text((s) =>
  s
    .trim()
    .split(' ')
    .filter((f) => /^(qbuf|qbuf-free|argv-mem|multi|multi-mem|rbs|obl|oll|omem|tot-mem|sub|psub)=/.test(f))
    .join(' '),
);

const OVERHEAD = statsPick(['keys.count', 'replication.backlog', 'clients.slaves', 'aof.buffer', 'lua.caches', 'functions.caches', 'cluster.links']);

// ============================================================================
// Scenarios
// ============================================================================

/** DEBUG RELOAD leaves a dump.rdb in the shared dir, which the next redis-lite would load: leave an empty one. */
const EMPTY_DUMP = ['FLUSHALL', 'SAVE'];

const members = (n: number, p = 'm'): string => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ');
const pairs = (n: number, v = 'v'): string => Array.from({ length: n }, (_, i) => `f${i} ${v}`).join(' ');
const scored = (n: number): string => Array.from({ length: n }, (_, i) => `${i} m${i}`).join(' ');
const ints = (n: number): string => Array.from({ length: n }, (_, i) => String(i)).join(' ');
const repeat = (cmd: string, n: number): string[] => Array.from({ length: n }, () => cmd);
const lib = (name: string, fns: string[], pad = 0): string[] => [
  'FUNCTION',
  'LOAD',
  `#!lua name=${name}\n${fns.map((f) => `redis.register_function('${f}', function() return 1 end)\n`).join('')}${pad ? `--${'x'.repeat(pad)}` : ''}`,
];

const strings: Scenario[] = [
  s('APPEND grows a raw string greedily', [
    'SET k v', 'MEMORY USAGE k', 'APPEND k x', 'MEMORY USAGE k', `APPEND k ${'x'.repeat(42)}`, 'MEMORY USAGE k', 'APPEND k y', 'MEMORY USAGE k',
    'OBJECT ENCODING k', 'DEBUG RELOAD', 'MEMORY USAGE k', ...EMPTY_DUMP,
  ]),
  s('APPEND to a missing key stores the argument', [
    'APPEND a abc', 'OBJECT ENCODING a', 'MEMORY USAGE a', 'APPEND a d', 'MEMORY USAGE a', 'APPEND n 123', 'OBJECT ENCODING n', 'MEMORY USAGE n',
    `APPEND b ${'x'.repeat(50)}`, 'MEMORY USAGE b', 'APPEND b y', 'MEMORY USAGE b', "APPEND z ''", 'MEMORY USAGE z',
  ]),
  s('APPEND to an integer or float value', ['SET i 10', 'INCR i', 'APPEND i 5', 'MEMORY USAGE i', 'SET f 1.5', 'INCRBYFLOAT f 1', 'APPEND f x', 'MEMORY USAGE f']),
  s('a SET value is trimmed, a copy is not', [
    `SET v ${'x'.repeat(50)}`, 'APPEND v y', 'MEMORY USAGE v', `SET w ${'x'.repeat(50)}`, 'COPY w w2', 'APPEND w2 y', 'MEMORY USAGE w2',
    `SET u ${'x'.repeat(60)}`, 'APPEND u y', 'MEMORY USAGE u', `SET e ${'x'.repeat(45)}`, 'APPEND e y', 'MEMORY USAGE e',
    `GETSET g ${'x'.repeat(50)}`, 'APPEND g y', 'MEMORY USAGE g', `MSET m ${'x'.repeat(50)}`, 'APPEND m y', 'MEMORY USAGE m',
  ]),
  s('loaded strings are trimmed', [
    `SET v ${'x'.repeat(50)}`, `SET w ${'x'.repeat(45)}`, 'DEBUG RELOAD', 'APPEND v y', 'MEMORY USAGE v', 'APPEND w y', 'MEMORY USAGE w', ...EMPTY_DUMP,
  ]),
  s('SETRANGE creates exactly and grows greedily', [
    'SETRANGE s 0 abc', 'MEMORY USAGE s', 'SETRANGE s 10 abc', 'MEMORY USAGE s', 'SETRANGE s 100 abc', 'MEMORY USAGE s',
    'SETRANGE y 100 a', 'MEMORY USAGE y', 'SET p 12345', 'SETRANGE p 1 a', 'MEMORY USAGE p',
    `SET q ${'y'.repeat(40)}`, 'SETRANGE q 2 a', 'MEMORY USAGE q', 'SETRANGE q 60 a', 'MEMORY USAGE q',
  ]),
  s('SETRANGE past 1 MB preallocates 1 MB more', ['SETRANGE big 2000000 a', 'MEMORY USAGE big', 'APPEND big b', 'MEMORY USAGE big']),
  s('SETBIT and BITFIELD grow the bitmap', [
    'SETBIT b 0 1', 'MEMORY USAGE b', 'SETBIT b 100 1', 'MEMORY USAGE b', 'SETBIT b 1000 1', 'MEMORY USAGE b', 'SETBIT b 10000 1', 'MEMORY USAGE b',
    'SETBIT x 100 1', 'MEMORY USAGE x', 'SETBIT n 7 1', 'SETBIT n 15 1', 'MEMORY USAGE n', 'SETBIT n 255 1', 'MEMORY USAGE n',
    'BITFIELD f SET u8 0 1', 'MEMORY USAGE f', 'BITFIELD f SET u8 800 1', 'MEMORY USAGE f',
    'BITFIELD g SET u8 0 1 SET u8 800 1', 'MEMORY USAGE g',
  ]),
  s('BITOP stores an exact string', ['SET a abc', 'SET b abcdefgh', 'BITOP OR d a b', 'MEMORY USAGE d', `SET big ${'z'.repeat(100)}`, 'BITOP NOT e big', 'MEMORY USAGE e']),
  s('a sparse HyperLogLog grows 3 bytes at a time', [
    'PFADD h', 'MEMORY USAGE h', 'STRLEN h',
    ...Array.from({ length: 40 }, (_, i) => [`PFADD h e${i}`, 'MEMORY USAGE h']).flat(),
    'STRLEN h',
  ]),
  s('PFMERGE into a sparse HyperLogLog', ['PFADD q a b', 'PFADD r c d', 'PFMERGE q r', 'MEMORY USAGE q', 'PFMERGE n q', 'MEMORY USAGE n', 'PFCOUNT q', 'MEMORY USAGE q']),
  s('a dense HyperLogLog', [`PFADD h ${members(2000, 'e')}`, 'STRLEN h', 'MEMORY USAGE h', 'PFADD s a', 'PFDEBUG TODENSE s', 'MEMORY USAGE s']),
];

const dicts: Scenario[] = [
  s('a set dict rehashing right after it grew', [
    `SADD a ${members(5)}`, 'MEMORY USAGE a', { cmd: 'DEBUG HTSTATS-KEY a', norm: tableCounts },
    `SADD b ${members(9)}`, 'MEMORY USAGE b', `SADD c ${members(17)}`, 'MEMORY USAGE c', `SADD d ${members(129)}`, 'MEMORY USAGE d',
  ]),
  s('a 300-member set rehashing, then settled', [
    `SADD s ${members(300)}`, 'MEMORY USAGE s', { cmd: 'DEBUG HTSTATS-KEY s', norm: tableSizes },
    ...repeat('SISMEMBER s x', 40), 'MEMORY USAGE s',
    ...repeat('SISMEMBER s x', 400), 'MEMORY USAGE s', { cmd: 'DEBUG HTSTATS-KEY s', norm: tableCounts },
  ]),
  s('an intset converted to a hashtable', [
    'SADD s1 1 2 3 4', 'SADD s1 a', 'MEMORY USAGE s1', { cmd: 'DEBUG HTSTATS-KEY s1', norm: tableCounts },
    `SADD s2 ${ints(512)}`, 'SADD s2 9999', 'MEMORY USAGE s2', { cmd: 'DEBUG HTSTATS-KEY s2', norm: tableCounts },
    `SADD s3 ${ints(600)}`, 'MEMORY USAGE s3', `SADD s4 ${ints(1100)}`, { cmd: 'DEBUG HTSTATS-KEY s4', norm: tableSizes },
  ]),
  s('a hash converted by a long value', [
    `HSET h ${pairs(64)}`, `HSET h big ${'x'.repeat(70)}`, 'MEMORY USAGE h', { cmd: 'DEBUG HTSTATS-KEY h', norm: tableCounts },
    `HSET g big ${'x'.repeat(70)}`, { cmd: 'DEBUG HTSTATS-KEY g', norm: tableCounts }, 'MEMORY USAGE g',
    ...Array.from({ length: 60 }, (_, i) => `HSET h n${i} v`), 'MEMORY USAGE h', { cmd: 'DEBUG HTSTATS-KEY h', norm: tableCounts },
  ]),
  s('a sorted set converted to a skiplist', [
    `ZADD z1 ${scored(128)}`, 'ZADD z1 1 x', { cmd: 'DEBUG HTSTATS-KEY z1', norm: tableCounts },
    `ZADD z2 ${scored(129)}`, { cmd: 'DEBUG HTSTATS-KEY z2', norm: tableCounts },
    `ZADD z3 ${scored(200)}`, { cmd: 'DEBUG HTSTATS-KEY z3', norm: tableCounts },
    `ZADD z4 1 ${'x'.repeat(70)}`, { cmd: 'DEBUG HTSTATS-KEY z4', norm: tableCounts },
  ]),
  s('sets built by SUNIONSTORE and COPY', [
    `SADD a ${members(300)}`, 'SUNIONSTORE u a', { cmd: 'DEBUG HTSTATS-KEY u', norm: tableSizes }, 'MEMORY USAGE u',
    'COPY a c', { cmd: 'DEBUG HTSTATS-KEY c', norm: tableCounts }, 'MEMORY USAGE c',
  ]),
  s('a set shrinks after SREM empties it below 10 %', [
    `SADD s ${members(300)}`, ...repeat('SISMEMBER s x', 400), `SREM s ${members(240)}`, { cmd: 'DEBUG HTSTATS-KEY s', norm: tableCounts },
    // shrinking (512 + 64 slots); whether the new table got an entry yet depends on the hash seed
    `SREM s ${Array.from({ length: 10 }, (_, i) => `m${240 + i}`).join(' ')}`, 'MEMORY USAGE s',
  ]),
  s('DEBUG HTSTATS-KEY errors', ['DEBUG HTSTATS-KEY nokey', 'SET s v', 'DEBUG HTSTATS-KEY s', 'SADD i 1 2', 'DEBUG HTSTATS-KEY i', 'DEBUG HTSTATS-KEY', 'DEBUG HTSTATS-KEY s x']),
  s('DEBUG HTSTATS of the keyspace', [
    'CONFIG SET activerehashing no', { cmd: 'DEBUG HTSTATS 0', norm: tableCounts }, 'SET a 1', 'SET b 2', 'SET c 3', 'SET d 4',
    { cmd: 'DEBUG HTSTATS 0', norm: tableCounts }, 'SET e 5', { cmd: 'DEBUG HTSTATS 0', norm: tableSizes },
    'DEBUG HTSTATS 99', 'DEBUG HTSTATS -1', 'DEBUG HTSTATS abc', 'DEBUG HTSTATS', 'DEBUG HTSTATS 0 1',
  ]),
  s('the keyspace dict finishes rehashing in serverCron', [
    'SET a 1', 'SET b 2', 'SET c 3', 'SET d 4', 'SET e 5', { sleep: 300 }, { cmd: 'DEBUG HTSTATS 0', norm: tableCounts },
  ]),
];

const stats: Scenario[] = [
  s('MEMORY STATS per-db overhead', [
    'CONFIG SET activerehashing no', { cmd: 'MEMORY STATS', norm: OVERHEAD }, 'SET a 1', { cmd: 'MEMORY STATS', norm: OVERHEAD },
    'EXPIRE a 100', { cmd: 'MEMORY STATS', norm: OVERHEAD }, 'MSET b 2 c 3 d 4 e 5', { cmd: 'MEMORY STATS', norm: OVERHEAD },
    'SELECT 1', 'SET x y', { cmd: 'MEMORY STATS', norm: OVERHEAD }, 'DEL x', { cmd: 'MEMORY STATS', norm: OVERHEAD },
  ]),
  s('MEMORY STATS with 100 keys and TTLs', [
    'CONFIG SET activerehashing no', ...Array.from({ length: 100 }, (_, i) => `SET key:${i} v${i}${i % 3 ? '' : ' EX 1000'}`),
    { cmd: 'MEMORY STATS', norm: OVERHEAD },
  ]),
  s('lua.caches follows the cached scripts', [
    { cmd: 'MEMORY STATS', norm: OVERHEAD }, 'SCRIPT LOAD "return 1"', { cmd: 'MEMORY STATS', norm: OVERHEAD },
    `SCRIPT LOAD "return '${'a'.repeat(113)}'"`, 'EVAL "return 2" 0', { cmd: 'MEMORY STATS', norm: OVERHEAD },
    { cmd: 'INFO memory', norm: text((r) => r.split('\r\n').filter((l) => /^(used_memory_scripts_eval|number_of_cached_scripts):/.test(l)).join('\n')) },
    'SCRIPT FLUSH', { cmd: 'MEMORY STATS', norm: OVERHEAD },
  ]),
  s('functions.caches follows the libraries', [
    { cmd: 'MEMORY STATS', norm: OVERHEAD }, { cmd: lib('a', ['f']) }, { cmd: 'MEMORY STATS', norm: OVERHEAD },
    { cmd: lib('b'.repeat(36), ['g']) }, { cmd: lib('c', ['h'.repeat(36)]) }, { cmd: lib('d', ['i'], 200) }, { cmd: 'MEMORY STATS', norm: OVERHEAD },
    { cmd: lib('e', ['j', 'k', 'l', 'm', 'n']) }, { cmd: 'MEMORY STATS', norm: OVERHEAD },
    'FUNCTION FLUSH', { cmd: 'MEMORY STATS', norm: OVERHEAD },
  ]),
  s('INFO memory script and function figures', [
    { cmd: 'INFO memory', norm: text((r) => r.split('\r\n').filter((l) => /^(used_memory_(lua|vm_eval|lua_human|functions|scripts|scripts_human|scripts_eval)|number_of_(cached_scripts|functions|libraries)):/.test(l)).join('\n')) },
  ]),
];

const clients: Scenario[] = [
  s('CLIENT INFO memory fields', [
    { cmd: 'CLIENT INFO', norm: clientMemory }, { cmd: 'CLIENT INFO', norm: clientMemory }, `SET big ${'z'.repeat(40000)}`, { cmd: 'CLIENT INFO', norm: clientMemory },
    'SUBSCRIBE ch1 ch2', 'PSUBSCRIBE p*', { cmd: 'CLIENT INFO', c: 1, norm: clientMemory },
  ], { proto: 2 }),
  s('CLIENT LIST memory of other clients', [
    'CLIENT SETNAME main', { cmd: 'CLIENT SETNAME queued', c: 1 }, { cmd: 'MULTI', c: 1 }, { cmd: 'SET a b', c: 1 }, { cmd: `SET c ${'y'.repeat(50)}`, c: 1 },
    { cmd: 'CLIENT SETNAME pubsub', c: 2 }, { cmd: 'SUBSCRIBE ch1 ch2', c: 2 }, { cmd: 'PSUBSCRIBE p*', c: 2 },
    { cmd: 'CLIENT LIST', norm: text((r) => r.split('\n').filter((l) => / name=\S/.test(l)).map((l) => `${/ name=(\S+)/.exec(l)?.[1]} ${clientMemory(`+${l}\r\n`).slice(1, -2)}`).sort().join('\n')) },
  ], { proto: 2 }),
];

differential('memory', [...strings, ...dicts, ...stats, ...clients], ({ env }) => {
  // ==========================================================================
  // used_memory deltas: what adding / removing keys of a given shape costs
  // ==========================================================================

  const used = async (c: DiffConnection): Promise<number> => Number(/used_memory:(\d+)/.exec(await c.call(['INFO', 'memory']))?.[1]);
  // each shape in a database of its own, sized so that no keyspace dict is left half rehashed at a measure
  const shapes: Array<[string, string[]]> = [
    ['100 small keys', ['SELECT 1', ...Array.from({ length: 100 }, (_, i) => `SET key:${i} v${i}`)]],
    ['100 keys with 100-byte values', ['SELECT 2', ...Array.from({ length: 100 }, (_, i) => `SET big:${i} ${'x'.repeat(100)}`)]],
    ['50 keys with a TTL', ['SELECT 3', ...Array.from({ length: 50 }, (_, i) => `SET t${i} v EX 1000`)]],
    ['shared and unshared integers', ['SELECT 4', ...Array.from({ length: 24 }, (_, i) => `SET int:${i} ${i * 1000}`)]],
    ['a 300-member set', ['SELECT 5', `SADD s ${members(300)}`]],
    ['a 10-field hash', ['SELECT 6', `HSET h ${pairs(10)}`]],
    ['a 200-field hashtable hash', ['SELECT 7', `HSET hh big ${'x'.repeat(70)} ${pairs(199)}`]],
    ['a 1000-element list', ['SELECT 8', `RPUSH l ${Array.from({ length: 1000 }, (_, i) => `item-${i}`).join(' ')}`]],
    ['an appended string', ['SELECT 9', 'SET ap a', ...Array.from({ length: 20 }, () => `APPEND ap ${'b'.repeat(30)}`)]],
    ['deleting 50 keys', ['SELECT 1', ...Array.from({ length: 50 }, (_, i) => `DEL key:${i}`)]],
    ['FLUSHALL', ['FLUSHALL']],
  ];

  /**
   * The oracle's serverCron (clientsCron) may shrink a client's query or reply buffer in the middle of a measure, which
   * shows as a delta of a few tens of KB unrelated to the keys: the whole sequence is retried (from FLUSHALL) a few
   * times before the deltas are compared.
   */
  const ATTEMPTS = 3;

  it('used_memory deltas match per data shape [RESP2]', async () => {
    const p = await env().pair(2);
    try {
      const measure = async (c: DiffConnection): Promise<string[]> => {
        const call = (l: string): Promise<string> => c.call(tokenize(l));
        const out: string[] = [];
        // no per-command latency histograms, no rehashing behind the test's back; every command run once before
        await call('CONFIG SET latency-tracking no');
        await call('CONFIG SET activerehashing no');
        for (const w of ['SELECT 0', 'SET w 1', 'SET w 1 EX 10', 'APPEND w x', 'DEL w', 'SADD w a', 'DEL w', 'HSET w a b', 'DEL w', 'RPUSH w a', 'DEL w', 'FLUSHALL', 'INFO memory']) await call(w);
        for (const [name, cmds] of shapes) {
          const before = await used(c);
          for (const cmd of cmds) await call(cmd);
          out.push(`${name}: ${(await used(c)) - before}`);
        }
        await call('FLUSHALL');
        return out;
      };
      const lite = await measure(p.lite);
      let oracle: string[] = [];
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        oracle = await measure(p.oracle);
        if (JSON.stringify(oracle) === JSON.stringify(lite)) break;
      }
      expect(lite).toEqual(oracle);
    } finally {
      await p.close();
    }
  });
});
