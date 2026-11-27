import { expect, it } from 'vitest';

import type { DiffConnection } from './differential.connection';
import { differential, s, v } from './differential.harness';
import { debugObject, pttlSeconds, sorted, sortedPairs } from './differential.normalizers';
import type { Normalizer } from './differential.normalizers';
import { intProbes } from './differential.probes';
import { parseResp, payload as respPayload, show } from './differential.resp';

const FAR_MS = '4102444800000';

// CRC-64/Jones (reflected, init 0, no final xor): the checksum Redis appends to a DUMP payload
const POLY = 0x95ac9329ac4bc9b5n;
const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = BigInt(n);
  for (let k = 0; k < 8; k++) c = c & 1n ? (c >> 1n) ^ POLY : c >> 1n;
  return c;
});

function crc64(bytes: string): bigint {
  let crc = 0n;
  for (let i = 0; i < bytes.length; i++) crc = TABLE[Number((crc ^ BigInt(bytes.charCodeAt(i))) & 0xffn)] ^ (crc >> 8n);
  return crc;
}

function le(value: bigint, size: number): string {
  let out = '';
  for (let i = 0; i < size; i++) out += String.fromCharCode(Number((value >> BigInt(8 * i)) & 0xffn));
  return out;
}

/** A DUMP payload: object bytes + RDB version (2 bytes LE) + CRC-64 (8 bytes LE) of everything before it. */
function dumpOf(body: string, version = 10): string {
  const head = body + le(BigInt(version), 2);
  return head + le(crc64(head), 8);
}

/** The same payload re-stamped with another RDB version (and a fresh checksum). */
function restamp(p: string, version: number): string {
  return dumpOf(p.slice(0, -10), version);
}

const STR_V = dumpOf('\x00\x01v'); // the string "v"
const STR_INT = dumpOf('\x00\xc0\x7b'); // the string "123" as an 8-bit integer
const BAD_CRC = STR_V.slice(0, -1) + String.fromCharCode(STR_V.charCodeAt(STR_V.length - 1) ^ 1);
const BAD_DATA = dumpOf('\x00\x40\x64v'); // claims 100 bytes, holds 1 (and 10 of footer)
const OVERRUN = dumpOf('\x00\x05v'); // claims 5 bytes: Redis reads the version and 2 CRC bytes as the value
const BAD_TYPE = dumpOf('\xc8\x01v'); // object type 200

/** A listpack of short strings (each at most 63 bytes). */
function listpack(items: string[]): string {
  const body = items.map((x) => String.fromCharCode(0x80 | x.length) + x + String.fromCharCode(x.length + 1)).join('');
  return le(BigInt(6 + body.length + 1), 4) + le(BigInt(items.length), 2) + body + '\xff';
}
const lenByte = (s: string): string => String.fromCharCode(s.length);
const SET_LISTPACK = dumpOf('\x14' + lenByte(listpack(['a', 'b', 'c'])) + listpack(['a', 'b', 'c'])); // RDB type 20 (7.2+)
const STREAM_3 = dumpOf('\x15\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'); // RDB type 21 (7.2+), empty stream
const QUICKLIST_3 = dumpOf('\x12\x03' + ['a', 'b', 'c'].map((x) => '\x02' + lenByte(listpack([x])) + listpack([x])).join('')); // three 1-element nodes
const PLAIN_LIST = dumpOf('\x01\x05\x01a\x01b\x01c\x01d\x01e'); // RDB type 1: laid out by the server's fill

differential('keys dump', [
  // DUMP
  s('DUMP missing key', ['DUMP missing', 'DUMP', 'DUMP a b']),
  s('DUMP payload of a string', ['SET k v', 'DUMP k']),
  s('DUMP payloads of strings', ['SET i 12345', 'DUMP i', 'SET big 123456789012', 'DUMP big', 'SET e ""', 'DUMP e', 'SET neg -7', 'DUMP neg']),
  s('DUMP payloads of lists (quicklist nodes)', [
    'RPUSH a x 1 -200 yy', 'DUMP a', 'LPUSH b 1 2 3', 'DUMP b',
    'CONFIG SET list-max-listpack-size 3', 'RPUSH c 0 1 2 3 4 5 6 7', 'DUMP c', 'LPUSH d 0 1 2 3 4 5 6 7', 'DUMP d',
    'LINSERT c BEFORE 4 x', 'DUMP c', 'LINSERT c AFTER 1 y', 'DUMP c', 'LREM c 0 6', 'DUMP c', 'LTRIM c 1 -2', 'DUMP c', 'LSET c 0 zzz', 'DUMP c',
  ]),
  s('DUMP payloads of intsets, listpack hashes and zsets', [
    'SADD s 5 -3 1000000 7', 'DUMP s', 'SADD w 1 70000', 'DUMP w', 'HSET h f v n 12', 'DUMP h',
    'ZADD z 1 a 2.5 b 0.1 c -0.0 d 1e17 e 4611686018427387904 f 4611686018427387905 g inf h', 'DUMP z',
  ]),
  // a hash table's member order is its own: compare the length and the RDB type byte only
  s('DUMP of a set keeps its encoding', ['SADD s 1 2 3 x', 'SREM s x', 'OBJECT ENCODING s', { cmd: 'DUMP s', norm: (r) => r.slice(0, r.indexOf('\r\n') + 3) }]),
  s('DUMP of a hash or zset keeps its encoding', [
    'CONFIG SET hash-max-listpack-entries 1', 'HSET h a 1 b 2', 'HDEL h b', 'CONFIG SET hash-max-listpack-entries 128', 'OBJECT ENCODING h', 'DUMP h',
    'CONFIG SET zset-max-listpack-entries 1', 'ZADD z 1 a 2 b', 'ZREM z b', 'CONFIG SET zset-max-listpack-entries 128', 'OBJECT ENCODING z', 'DUMP z',
  ]),

  // RESTORE of hand-built payloads
  s('RESTORE a string payload', [{ cmd: ['RESTORE', 'k', '0', STR_V] }, 'GET k', 'TTL k', 'OBJECT ENCODING k', { cmd: ['RESTORE', 'n', '0', STR_INT] }, 'GET n', 'OBJECT ENCODING n']),
  s('RESTORE onto an existing key', ['SET k old', { cmd: ['RESTORE', 'k', '0', STR_V] }, 'GET k', { cmd: ['RESTORE', 'k', '0', STR_V, 'REPLACE'] }, 'GET k']),
  s('RESTORE REPLACE onto other type', ['RPUSH k a', { cmd: ['RESTORE', 'k', '0', STR_V, 'REPLACE'] }, 'TYPE k']),
  s('RESTORE with TTL', [{ cmd: ['RESTORE', 'k', '100000', STR_V] }, 'TTL k', { cmd: ['RESTORE', 'a', FAR_MS, STR_V, 'ABSTTL'] }, 'PEXPIRETIME a']),
  s('RESTORE ABSTTL in the past', [{ cmd: ['RESTORE', 'k', '1', STR_V, 'ABSTTL'] }, 'EXISTS k', 'SET e x', { cmd: ['RESTORE', 'e', '1', STR_V, 'ABSTTL', 'REPLACE'] }, 'EXISTS e']),
  s('RESTORE invalid TTL', [{ cmd: ['RESTORE', 'k', '-1', STR_V] }, { cmd: ['RESTORE', 'k', 'x', STR_V] }, { cmd: ['RESTORE', 'k', '1.5', STR_V] }, 'EXISTS k']),
  s('RESTORE IDLETIME and FREQ', [
    { cmd: ['RESTORE', 'a', '0', STR_V, 'IDLETIME', '1000'] }, 'OBJECT IDLETIME a', { cmd: ['RESTORE', 'b', '0', STR_V, 'FREQ', '5'] }, 'GET b',
    { cmd: ['RESTORE', 'c', '0', STR_V, 'IDLETIME', '-1'] }, { cmd: ['RESTORE', 'c', '0', STR_V, 'FREQ', '256'] }, { cmd: ['RESTORE', 'c', '0', STR_V, 'FREQ', '-1'] },
    { cmd: ['RESTORE', 'c', '0', STR_V, 'IDLETIME', 'x'] }, { cmd: ['RESTORE', 'c', '0', STR_V, 'FREQ', 'x'] }, 'EXISTS c',
  ]),
  s('RESTORE IDLETIME with FREQ', [{ cmd: ['RESTORE', 'a', '0', STR_V, 'IDLETIME', '10', 'FREQ', '5'] }, { cmd: ['RESTORE', 'a', '0', STR_V, 'FREQ', '5', 'IDLETIME', '10'] }, 'EXISTS a']),
  s('RESTORE FREQ under LFU', ['CONFIG SET maxmemory-policy allkeys-lfu', { cmd: ['RESTORE', 'a', '0', STR_V, 'FREQ', '100'] }, 'OBJECT FREQ a']),
  s('RESTORE syntax errors', [
    { cmd: ['RESTORE', 'k', '0', STR_V, 'FOO'] }, { cmd: ['RESTORE', 'k', '0', STR_V, 'IDLETIME'] }, { cmd: ['RESTORE', 'k', '0', STR_V, 'FREQ'] },
    { cmd: ['RESTORE', 'k', '0'] }, { cmd: ['RESTORE', 'k'] }, { cmd: ['RESTORE', 'k', '0', STR_V, 'REPLACE', 'REPLACE'] }, 'EXISTS k',
  ]),
  s('RESTORE bad payloads', [
    { cmd: ['RESTORE', 'k', '0', BAD_CRC] }, { cmd: ['RESTORE', 'k', '0', 'garbage'] }, { cmd: ['RESTORE', 'k', '0', ''] }, { cmd: ['RESTORE', 'k', '0', BAD_DATA] },
    { cmd: ['RESTORE', 'k', '0', BAD_TYPE] }, 'EXISTS k',
  ]),
  s('RESTORE payload whose string overruns into the footer', [{ cmd: ['RESTORE', 'k', '0', OVERRUN] }, 'STRLEN k']),
  s('RESTORE bad payload onto existing key', ['SET k v', { cmd: ['RESTORE', 'k', '0', BAD_CRC] }, { cmd: ['RESTORE', 'k', '0', BAD_CRC, 'REPLACE'] }, 'GET k']),
  s('RESTORE payload with a newer RDB version', [{ cmd: ['RESTORE', 'k', '0', restamp(STR_V, 12)] }, 'GET k']),
  s('RESTORE payload with RDB version 11', [{ cmd: ['RESTORE', 'k', '0', restamp(STR_V, 11)] }, 'EXISTS k']),
  s('RESTORE of types added after 7.0', [{ cmd: ['RESTORE', 's', '0', SET_LISTPACK] }, { cmd: ['RESTORE', 'x', '0', STREAM_3] }, 'EXISTS s x']),
  s('RESTORE keeps the quicklist nodes of the payload', [
    { cmd: ['RESTORE', 'l', '0', QUICKLIST_3] }, { cmd: 'DEBUG OBJECT l', norm: debugObject }, 'RPUSH l d', 'DUMP l',
    'CONFIG SET list-max-listpack-size 2', { cmd: ['RESTORE', 'p', '0', PLAIN_LIST] }, 'DUMP p',
  ]),
  s('RESTORE payload with an unknown future RDB version', [{ cmd: ['RESTORE', 'k', '0', restamp(STR_V, 99)] }, 'EXISTS k']),
  s('RESTORE payload with an old RDB version', [{ cmd: ['RESTORE', 'k', '0', restamp(STR_V, 6)] }, 'GET k']),

  // integer arguments at the int64 and int32 edges
  ...intProbes('RESTORE ttl', [{ cmd: ['RESTORE', 'k', '$N', STR_V] }, 'EXISTS k', 'TTL k', { cmd: 'PTTL k', norm: pttlSeconds }]),
  ...intProbes('RESTORE ABSTTL', [{ cmd: ['RESTORE', 'k', '$N', STR_V, 'ABSTTL'] }, 'EXISTS k', 'PEXPIRETIME k']),
  ...intProbes('RESTORE IDLETIME and FREQ', [{ cmd: ['RESTORE', 'a', '0', STR_V, 'IDLETIME', '$N'] }, 'EXISTS a', { cmd: ['RESTORE', 'b', '0', STR_V, 'FREQ', '$N'] }, 'EXISTS b']),
]);

/** Sends one command; the raw reply. */
async function call(c: DiffConnection, args: string[]): Promise<string> {
  return c.call(args);
}

/** The bulk payload of a DUMP reply. */
async function dump(c: DiffConnection, key: string): Promise<string> {
  const raw = await call(c, ['DUMP', key]);
  expect(raw.startsWith('$'), `DUMP ${key} -> ${show(raw)}`).toBe(true);
  return respPayload(parseResp(raw).node);
}

interface Kind {
  name: string;
  setup: string[][];
  read: [string[], Normalizer?][];
  /** redis-lite's object bytes use an encoding 7.0 cannot load (added after 7.0): why. */
  newEncoding?: string;
  /** false: no byte comparison (hash-table iteration order); a string: bytes expected to differ, why. */
  body?: false | string;
}

const range = (n: number, f: (i: number) => string[]): string[] => Array.from({ length: n }, (_, i) => f(i)).flat();

const KINDS: Kind[] = [
  { name: 'embstr string', setup: [['SET', 'k', 'hello']], read: [[['GET', 'k']], [['OBJECT', 'ENCODING', 'k']]] },
  { name: 'int string', setup: [['SET', 'k', '-123456']], read: [[['GET', 'k']], [['OBJECT', 'ENCODING', 'k']]] },
  { name: 'large int string', setup: [['SET', 'k', '9223372036854775807']], read: [[['GET', 'k']], [['OBJECT', 'ENCODING', 'k']]] },
  { name: 'raw string', setup: [['SET', 'k', 'r'.repeat(300)]], read: [[['GET', 'k']], [['STRLEN', 'k']]] },
  { name: 'binary string', setup: [['SET', 'k', '\x00\x01\xff\r\n']], read: [[['GET', 'k']]] },
  { name: 'compressible string', setup: [['SET', 'k', 'ab'.repeat(500)]], read: [[['GET', 'k']]] },
  { name: 'small list', setup: [['RPUSH', 'k', 'a', '1', 'bcd', '-5']], read: [[['LRANGE', 'k', '0', '-1']]] },
  {
    name: 'large list',
    setup: [['RPUSH', 'k', ...range(1000, (i) => [`item-${i}`])]], read: [[['LRANGE', 'k', '0', '-1']], [['OBJECT', 'ENCODING', 'k']]],
  },
  { name: 'intset', setup: [['SADD', 'k', '5', '-3', '1000000', '7']], read: [[['SMEMBERS', 'k']], [['OBJECT', 'ENCODING', 'k']]] },
  { name: 'small string set', setup: [['SADD', 'k', 'a', 'b', 'c']], read: [[['SMEMBERS', 'k'], sorted], [['OBJECT', 'ENCODING', 'k']]], body: false },
  { name: 'hashtable set', setup: [['SADD', 'k', ...range(600, (i) => [`m${i}`])]], read: [[['SMEMBERS', 'k'], sorted], [['SCARD', 'k']], [['OBJECT', 'ENCODING', 'k']]], body: false },
  { name: 'listpack hash', setup: [['HSET', 'k', 'f1', 'v1', 'f2', '2', 'f3', 'v3']], read: [[['HGETALL', 'k']], [['OBJECT', 'ENCODING', 'k']]] },
  { name: 'hashtable hash', setup: [['HSET', 'k', ...range(600, (i) => [`f${i}`, `v${i}`])]], read: [[['HGETALL', 'k'], sortedPairs], [['OBJECT', 'ENCODING', 'k']]], body: false },
  { name: 'listpack zset', setup: [['ZADD', 'k', '1', 'a', '2.5', 'b', '-inf', 'c', '1e10', 'd']], read: [[['ZRANGE', 'k', '0', '-1', 'WITHSCORES']], [['OBJECT', 'ENCODING', 'k']]] },
  { name: 'skiplist zset', setup: [['ZADD', 'k', ...range(200, (i) => [String(i / 4), `m${i}`])]], read: [[['ZRANGE', 'k', '0', '-1', 'WITHSCORES']], [['OBJECT', 'ENCODING', 'k']]] },
  {
    name: 'stream with groups',
    setup: [
      ['XADD', 'k', '1-1', 'f', 'v'], ['XADD', 'k', '2-1', 'a', '1', 'b', '2'], ['XADD', 'k', '3-0', 'f', 'x'], ['XDEL', 'k', '2-1'],
      ['XGROUP', 'CREATE', 'k', 'g', '0'], ['XREADGROUP', 'GROUP', 'g', 'alice', 'COUNT', '1', 'STREAMS', 'k', '>'], ['XGROUP', 'CREATE', 'k', 'g2', '$'],
    ],
    read: [[['XRANGE', 'k', '-', '+']], [['XLEN', 'k']], [['XINFO', 'GROUPS', 'k']], [['XPENDING', 'k', 'g']]],
    // the bytes hold the consumer's seen-time (wall clock), so only the restored content is compared
    body: false,
  },
  { name: 'sparse hll', setup: [['PFADD', 'k', 'a', 'b', 'c']], read: [[['PFCOUNT', 'k']], [['GET', 'k']]] },
  { name: 'dense hll', setup: [['PFADD', 'k', ...range(3000, (i) => [`e${i}`])]], read: [[['PFCOUNT', 'k']], [['GET', 'k']]] },
];

async function readAll(c: DiffConnection, kind: Kind): Promise<string> {
  const out: string[] = [];
  for (const [args, norm] of kind.read) out.push(`${args.join(' ')} -> ${show((norm ?? ((r: string) => r))(await call(c, args)))}`);
  return out.join('\n');
}

differential('keys dump cross-server', [], ({ env }) => {
  it('the CRC-64 used by hand-built payloads matches Redis', async () => {
    const p = await env().pair(2);
    try {
      await call(p.oracle, ['SET', 'k', 'v']);
      const d = await dump(p.oracle, 'k');
      expect(show(restamp(d, d.charCodeAt(d.length - 10)))).toBe(show(d));
    } finally {
      await p.close();
    }
  });

  for (const kind of KINDS) {
    for (const proto of [2, 3] as const) {
      it(`${kind.name}: Redis DUMP restored into redis-lite reads back the same [RESP${proto}]`, async () => {
        const p = await env().pair(proto);
        try {
          for (const cmd of kind.setup) await call(p.oracle, cmd);
          const d = await dump(p.oracle, 'k');
          expect(await call(p.lite, ['RESTORE', 'k', '0', d])).toBe('+OK\r\n');
          expect(await readAll(p.lite, kind)).toBe(await readAll(p.oracle, kind));
        } finally {
          await p.close();
        }
      });
    }

    // re-stamped to the oracle's RDB version, so a version mismatch does not hide the object bytes check
    const restoreTest = kind.newEncoding ? it.fails : it;
    restoreTest(`${kind.name}: redis-lite DUMP (re-stamped to the oracle's RDB version) restores into Redis${kind.newEncoding ? ` (version: ${kind.newEncoding})` : ''}`, async () => {
      const p = await env().pair(2);
      try {
        for (const cmd of kind.setup) await call(p.lite, cmd);
        await call(p.oracle, ['SET', 'probe', 'v']);
        const ref = await dump(p.oracle, 'probe');
        const d = restamp(await dump(p.lite, 'k'), ref.charCodeAt(ref.length - 10));
        expect(await call(p.oracle, ['RESTORE', 'k', '0', d])).toBe('+OK\r\n');
        expect(await readAll(p.oracle, kind)).toBe(await readAll(p.lite, kind));
      } finally {
        await p.close();
      }
    });

    if (kind.body === false) continue;
    const why = kind.newEncoding ?? kind.body;
    (why ? it.fails : it)(`${kind.name}: DUMP object bytes match Redis${why ? ` (version: ${why})` : ''}`, async () => {
      const p = await env().pair(2);
      try {
        for (const cmd of kind.setup) {
          await call(p.oracle, cmd);
          await call(p.lite, cmd);
        }
        const a = await dump(p.oracle, 'k');
        const b = await dump(p.lite, 'k');
        expect(show(b.slice(0, -10))).toBe(show(a.slice(0, -10)));
      } finally {
        await p.close();
      }
    });
  }

  it('unmodified redis-lite DUMP restores into Redis 7.0 (both write RDB version 10)', async () => {
    const p = await env().pair(2);
    try {
      await call(p.lite, ['SET', 'k', 'v']);
      expect(await call(p.oracle, ['RESTORE', 'k', '0', await dump(p.lite, 'k')])).toBe('+OK\r\n');
    } finally {
      await p.close();
    }
  });
});
