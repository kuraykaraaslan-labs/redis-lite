import { expect, it } from 'vitest';

import { differential, s, v } from './differential.harness';
import { all, commandStats, infoKeys, keyspaceInfo, sortedInfoLines } from './differential.normalizers';
import { parseResp, payload } from './differential.resp';

/**
 * Fields Redis 7.0 reports that were removed or renamed after 7.0 (allowed to be absent from redis-lite), per section.
 * Empty today: every 7.0 field of these sections is expected in redis-lite.
 */
const REMOVED_AFTER_7_0: Record<string, string[]> = {};

/** INFO commandstats with times masked and lines sorted. */
const cmdstats = all(commandStats, sortedInfoLines);

const SECTIONS = ['server', 'clients', 'memory', 'persistence', 'stats', 'replication', 'cpu', 'modules', 'errorstats', 'cluster',
  'keyspace', 'commandstats', 'latencystats'];

/** Field names of an INFO reply, grouped by section header. */
function fieldsOf(reply: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = '';
  for (const line of payload(parseResp(reply).node).split('\r\n')) {
    if (line.startsWith('# ')) {
      current = line.slice(2).toLowerCase();
      out.set(current, []);
    } else if (line.includes(':')) {
      out.get(current)?.push(line.slice(0, line.indexOf(':')));
    }
  }
  return out;
}

// INFO sections, keyspace / commandstats / errorstats line formats
differential('info', [
  // section headers and field sets (values masked)
  s('INFO cluster', ['INFO cluster']),
  s('INFO modules', ['INFO modules']),
  s('INFO replication field names', [{ cmd: 'INFO replication', norm: infoKeys }]),
  s('INFO persistence field names', [{ cmd: 'INFO persistence', norm: infoKeys }]),
  s('INFO cpu field names', [{ cmd: 'INFO cpu', norm: infoKeys }]),
  s('INFO unknown section is empty', ['INFO bogus']),
  s('INFO section names are case-insensitive', [{ cmd: 'INFO CLUSTER' }, { cmd: 'INFO Keyspace' }]),
  s('INFO several sections', [{ cmd: 'INFO cluster keyspace', norm: infoKeys }]),
  s('INFO repeated section', ['INFO cluster cluster']),
  s('INFO default header order', [{ cmd: 'INFO', norm: (r) => headers(r) }],
    v('INFO gained the Threads section in 8.0 (io-threads rework)', 'medium')),
  s('INFO all header order', [{ cmd: 'INFO all', norm: (r) => headers(r) }],
    v('INFO gained the Threads section in 8.0 (io-threads rework)', 'medium')),
  s('INFO everything header order', [{ cmd: 'INFO everything', norm: (r) => headers(r) }],
    v('INFO gained the Threads section in 8.0 (io-threads rework)', 'medium')),
  s('INFO default plus a section', [{ cmd: 'INFO default cluster', norm: (r) => headers(r) }],
    v('INFO gained the Threads section in 8.0 (io-threads rework)', 'medium')),
  s('INFO arity in MULTI', ['MULTI', 'INFO cluster', 'EXEC']),

  // keyspace lines
  s('INFO keyspace when empty', ['INFO keyspace']),
  s('INFO keyspace with keys and no expires', ['MSET a 1 b 2', 'INFO keyspace'],
    v('INFO keyspace lines gained subexpiry= in 7.4 (hash field expiration)')),
  s('INFO keyspace with expires', ['MSET a 1 b 2', 'EXPIRE a 100', { cmd: 'INFO keyspace', norm: keyspaceInfo }],
    v('INFO keyspace lines gained subexpiry= in 7.4 (hash field expiration)')),
  s('INFO keyspace with several dbs', ['SET a 1', 'SELECT 3', 'SET b 1', 'SET c 1', 'INFO keyspace'],
    v('INFO keyspace lines gained subexpiry= in 7.4 (hash field expiration)')),
  s('INFO keyspace after FLUSHALL', ['SET a 1', 'FLUSHALL', 'INFO keyspace']),
  s('INFO keyspace after deleting the last key', ['SET a 1', 'DEL a', 'INFO keyspace']),

  // commandstats
  s('INFO commandstats after RESETSTAT', ['CONFIG RESETSTAT', { cmd: 'INFO commandstats', norm: cmdstats }]),
  s('INFO commandstats counts calls', ['CONFIG RESETSTAT', 'SET k v', 'GET k', 'GET k', { cmd: 'INFO commandstats', norm: cmdstats }]),
  s('INFO commandstats counts rejected calls', ['CONFIG RESETSTAT', 'GET', 'GET a b', { cmd: 'INFO commandstats', norm: cmdstats }]),
  s('INFO commandstats counts failed calls', ['CONFIG RESETSTAT', 'SET k v', 'INCR k', 'LPUSH k x', { cmd: 'INFO commandstats', norm: cmdstats }]),
  s('INFO commandstats names subcommands with a pipe', ['CONFIG RESETSTAT', 'CLIENT GETNAME', 'OBJECT ENCODING nokey',
    { cmd: 'INFO commandstats', norm: cmdstats }]),
  s('INFO commandstats of an unknown command', ['CONFIG RESETSTAT', 'NOSUCHCMD', { cmd: 'INFO commandstats', norm: cmdstats }]),
  s('INFO commandstats inside MULTI', ['CONFIG RESETSTAT', 'MULTI', 'SET k v', 'EXEC', { cmd: 'INFO commandstats', norm: cmdstats }]),

  // errorstats
  s('INFO errorstats after RESETSTAT', ['CONFIG RESETSTAT', 'INFO errorstats']),
  s('INFO errorstats counts ERR', ['CONFIG RESETSTAT', 'GET', 'NOSUCHCMD', 'INFO errorstats']),
  s('INFO errorstats counts WRONGTYPE', ['CONFIG RESETSTAT', 'SET k v', 'LPUSH k x', 'HGET k f', 'INFO errorstats']),
  s('INFO errorstats counts several prefixes', ['CONFIG RESETSTAT', 'SET k v', 'LPUSH k x', 'INCR k', 'HELLO 4', 'EXEC', 'INFO errorstats']),
  s('INFO errorstats of NOSCRIPT', ['CONFIG RESETSTAT', 'EVALSHA ffffffffffffffffffffffffffffffffffffffff 0', 'INFO errorstats']),
  s('INFO errorstats of an EXECABORT', ['CONFIG RESETSTAT', 'MULTI', 'NOSUCHCMD', 'EXEC', 'INFO errorstats']),
  s('INFO stats error counters', ['CONFIG RESETSTAT', 'GET', 'INFO errorstats', { cmd: 'INFO stats', norm: (r) => pick(r, ['total_error_replies', 'unexpected_error_replies']) }]),
  s('INFO stats keyspace hits and misses', ['CONFIG RESETSTAT', 'SET k v', 'GET k', 'GET nokey', 'GET nokey2',
    { cmd: 'INFO stats', norm: (r) => pick(r, ['keyspace_hits', 'keyspace_misses']) }]),
  s('INFO stats expired keys', ['CONFIG RESETSTAT', 'SET k v PX 1', { sleep: 20 }, 'GET k',
    { cmd: 'INFO stats', norm: (r) => pick(r, ['expired_keys', 'evicted_keys']) }]),
  s('INFO clients counters (connected_clients differs: the harness keeps a control connection to the oracle)', [{ c: 1, cmd: 'PING' }, { cmd: 'INFO clients', norm: (r) => pick(r, ['blocked_clients', 'tracking_clients']) }]),
  s('INFO memory policy fields', [{ cmd: 'INFO memory', norm: (r) => pick(r, ['maxmemory', 'maxmemory_human', 'maxmemory_policy']) }]),
  s('INFO server fixed fields', [{ cmd: 'INFO server', norm: (r) => pick(r, ['redis_mode', 'hz', 'configured_hz', 'arch_bits']) }]),
  s('INFO persistence fixed fields', [{ cmd: 'INFO persistence', norm: (r) => pick(r, ['loading', 'aof_enabled', 'rdb_bgsave_in_progress']) }]),
  s('INFO replication role', [{ cmd: 'INFO replication', norm: (r) => pick(r, ['role', 'connected_slaves', 'repl_backlog_active']) }]),
], ({ env }) => {
  // every field 7.0 reports in a section must exist in redis-lite (extra fields are fine)
  for (const section of SECTIONS) {
    it(`INFO ${section}: redis-lite has every field Redis 7.0 reports`, async () => {
      const p = await env().pair(2);
      try {
        for (const c of [p.oracle, p.lite]) {
          for (const cmd of [['CONFIG', 'RESETSTAT'], ['SET', 'k', 'v'], ['EXPIRE', 'k', '100'], ['GET', 'k'], ['INCR']]) await c.call(cmd);
        }
        const o = fieldsOf(await p.oracle.call(['INFO', section]));
        const l = fieldsOf(await p.lite.call(['INFO', section]));
        const allowed = new Set(REMOVED_AFTER_7_0[section] ?? []);
        expect([...l.keys()]).toEqual([...o.keys()]);
        for (const [name, fields] of o) {
          const have = new Set(l.get(name) ?? []);
          expect(fields.filter((f) => !have.has(f) && !allowed.has(f)), `section ${name}`).toEqual([]);
        }
      } finally {
        await p.close();
      }
    });
  }

  // MEMORY STATS keys: every key 7.0 reports must exist in redis-lite
  it('MEMORY STATS: redis-lite has every key Redis 7.0 reports', async () => {
    const p = await env().pair(2);
    try {
      const keys = (reply: string): string[] => {
        const n = parseResp(reply).node.children;
        return n.filter((_, i) => i % 2 === 0).map((k) => payload(k));
      };
      const o = keys(await p.oracle.call(['MEMORY', 'STATS']));
      const l = new Set(keys(await p.lite.call(['MEMORY', 'STATS'])));
      expect(o.filter((k) => !l.has(k))).toEqual([]);
    } finally {
      await p.close();
    }
  });
});

/** INFO: keeps only the section header lines (`# Server`…). Why: the content is process figures (see infoKeys). */
function headers(reply: string): string {
  return payload(parseResp(reply).node).split('\r\n').filter((l) => l.startsWith('#')).join('\n');
}

/** INFO: keeps only the given `field:value` lines, values included (they are deterministic for these fields). */
function pick(reply: string, fields: string[]): string {
  const lines = payload(parseResp(reply).node).split('\r\n');
  return fields.map((f) => lines.find((l) => l.startsWith(`${f}:`)) ?? `${f}: MISSING`).join('\n');
}
