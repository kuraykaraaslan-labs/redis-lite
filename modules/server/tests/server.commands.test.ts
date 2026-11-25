import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';

/**
 * Server commands.
 * Expected values follow Redis Open Source 8.x behaviour (redis.io docs and the Redis source error strings).
 */
const t = useServer();

/** Returns the error message a promise rejects with. */
async function errOf(p: Promise<unknown>): Promise<string> {
  let res: unknown;
  try {
    res = await p;
  } catch (e) {
    return (e as Error).message;
  }
  return `<no error, got ${JSON.stringify(res)}>`;
}

/** Resolves to the reply, or to the error message if the command fails. */
function errOrValue(p: Promise<unknown>): Promise<unknown> {
  return p.catch((e: Error) => e.message);
}

/** Converts a flat [k, v, k, v] RESP2 array into an object. */
function pairs(arr: unknown): Record<string, unknown> {
  const a = arr as unknown[];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < a.length; i += 2) out[String(a[i])] = a[i + 1];
  return out;
}

describe('INFO', () => {
  it('default INFO contains the standard sections', async () => {
    const info = String(await t.call('INFO'));
    for (const s of ['# Server', '# Clients', '# Memory', '# Persistence', '# Stats', '# Replication', '# CPU', '# Keyspace']) {
      expect.soft(info).toContain(s);
    }
    expect.soft(info).not.toContain('# Commandstats');
    expect.soft(info).toContain('\r\n');
  });

  it('INFO server', async () => {
    const info = String(await t.call('INFO', 'server'));
    expect.soft(info.startsWith('# Server\r\n')).toBe(true);
    expect.soft(info).toMatch(/\r\nredis_version:8\.\d+\.\d+\r\n/);
    expect.soft(info).toContain('redis_mode:standalone\r\n');
    expect.soft(info).toContain(`tcp_port:${t.server.port}\r\n`);
    expect.soft(info).toMatch(/uptime_in_seconds:\d+\r\n/);
    expect.soft(info).not.toContain('# Clients');
  });

  it('INFO with several sections and case-insensitive names', async () => {
    const info = String(await t.call('INFO', 'SERVER', 'clients'));
    expect.soft(info).toContain('# Server');
    expect.soft(info).toContain('# Clients');
    expect.soft(info).toMatch(/connected_clients:\d+/);
    expect.soft(info).not.toContain('# Memory');
  });

  it('INFO replication / persistence / stats fields', async () => {
    expect.soft(String(await t.call('INFO', 'replication'))).toContain('role:master\r\n');
    expect.soft(String(await t.call('INFO', 'replication'))).toContain('connected_slaves:0\r\n');
    expect.soft(String(await t.call('INFO', 'persistence'))).toMatch(/rdb_last_save_time:\d+/);
    expect.soft(String(await t.call('INFO', 'stats'))).toMatch(/total_commands_processed:\d+/);
    expect.soft(String(await t.call('INFO', 'memory'))).toMatch(/used_memory:\d+/);
  });

  it('INFO all / everything include commandstats', async () => {
    expect.soft(String(await t.call('INFO', 'all'))).toContain('# Commandstats');
    expect.soft(String(await t.call('INFO', 'everything'))).toContain('# Commandstats');
    const cs = String(await t.call('INFO', 'commandstats'));
    expect.soft(cs).toMatch(/cmdstat_info:calls=\d+,usec=\d+,usec_per_call=[\d.]+,rejected_calls=\d+,failed_calls=\d+/);
  });

  it('INFO errorstats counts errors by prefix', async () => {
    await t.call('CONFIG', 'RESETSTAT');
    await errOf(t.call('SELECT', 'notanumber'));
    expect.soft(String(await t.call('INFO', 'errorstats'))).toContain('errorstat_ERR:count=1');
  });

  it('INFO for an unknown section is empty', async () => {
    const r = await t.raw();
    expect.soft(await r.send('INFO', 'nosuchsection')).toBe('$0\r\n\r\n');
  });

  it('INFO keyspace reports keys, expires and avg_ttl per db', async () => {
    const r = await t.raw();
    await r.send('SELECT', '5');
    await r.send('FLUSHDB');
    await r.send('SET', 'ks:a', '1');
    await r.send('SET', 'ks:b', '1', 'EX', '1000');
    const info = String(await t.call('INFO', 'keyspace'));
    expect.soft(info.startsWith('# Keyspace\r\n')).toBe(true);
    expect.soft(info).toMatch(/\r\ndb5:keys=2,expires=1,avg_ttl=\d+,subexpiry=0\r\n/);
    await r.send('FLUSHDB');
    expect.soft(String(await t.call('INFO', 'keyspace'))).not.toContain('db5:');
  });

  it('INFO is a verbatim string in RESP3', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('INFO', 'server')).toMatch(/^=\d+\r\ntxt:# Server\r\n/);
  });
});

describe('CONFIG', () => {
  it('GET returns name/value pairs', async () => {
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory')).toEqual(['maxmemory', '0']);
    expect.soft(await t.call('CONFIG', 'GET', 'nosuchoption')).toEqual([]);
    expect.soft(await t.call('CONFIG', 'GET', 'databases')).toEqual(['databases', '16']);
  });

  it('GET with globs', async () => {
    const res = pairs(await t.call('CONFIG', 'GET', 'maxmemory*'));
    expect.soft(res.maxmemory).toBe('0');
    expect.soft(res['maxmemory-policy']).toBe('noeviction');
    expect.soft(res['maxmemory-samples']).toBe('5');
    const q = pairs(await t.call('CONFIG', 'GET', 'maxmemor?'));
    expect.soft(Object.keys(q)).toEqual(['maxmemory']);
  });

  it('GET with several parameters', async () => {
    const res = pairs(await t.call('CONFIG', 'GET', 'maxmemory', 'databases'));
    expect.soft(res).toEqual({ maxmemory: '0', databases: '16' });
    // the same option asked twice is reported once
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory', 'maxmemory')).toEqual(['maxmemory', '0']);
  });

  it('GET of an alias returns the alias name', async () => {
    expect.soft(await t.call('CONFIG', 'GET', 'hash-max-ziplist-entries')).toEqual(['hash-max-ziplist-entries', '128']);
    expect.soft(await t.call('CONFIG', 'GET', 'hash-max-listpack-entries')).toEqual(['hash-max-listpack-entries', '128']);
  });

  it('SET through an alias changes the real option', async () => {
    expect.soft(await t.call('CONFIG', 'SET', 'hash-max-ziplist-entries', '64')).toBe('OK');
    expect.soft(await t.call('CONFIG', 'GET', 'hash-max-listpack-entries')).toEqual(['hash-max-listpack-entries', '64']);
    await t.call('CONFIG', 'SET', 'hash-max-listpack-entries', '128');
  });

  it('SET with memory units and several pairs', async () => {
    expect.soft(await t.call('CONFIG', 'SET', 'maxmemory', '1mb', 'maxmemory-samples', '7')).toBe('OK');
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory')).toEqual(['maxmemory', '1048576']);
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory-samples')).toEqual(['maxmemory-samples', '7']);
    await t.call('CONFIG', 'SET', 'maxmemory', '0', 'maxmemory-samples', '5');
  });

  it('SET errors', async () => {
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'nosuchoption', 'x'))).toBe(
      "ERR Unknown option or number of arguments for CONFIG SET - 'nosuchoption'",
    );
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory', 'abc'))).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'maxmemory') - argument must be a memory value",
    );
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory'))).toBe("ERR wrong number of arguments for 'config|set' command");
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory', '1', 'maxmemory-samples'))).toBe(
      "ERR wrong number of arguments for 'config|set' command",
    );
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory-policy', 'bogus'))).toMatch(
      /^ERR CONFIG SET failed \(possibly related to argument 'maxmemory-policy'\) - argument\(s\) must be one of the following: /,
    );
  });

  it('SET is atomic: a bad pair leaves the others unchanged', async () => {
    await errOf(t.call('CONFIG', 'SET', 'maxmemory-samples', '9', 'maxmemory', 'abc'));
    expect.soft(await t.call('CONFIG', 'GET', 'maxmemory-samples')).toEqual(['maxmemory-samples', '5']);
  });

  it('SET of the same parameter twice is rejected', async () => {
    // Redis configSetCommand(): errstr "duplicate parameter", reported as "CONFIG SET failed (possibly related to argument '%s') - %s"
    expect.soft(await errOf(t.call('CONFIG', 'SET', 'maxmemory', '1', 'maxmemory', '2'))).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'maxmemory') - duplicate parameter",
    );
  });

  it('RESETSTAT resets the stats', async () => {
    expect.soft(await t.call('CONFIG', 'RESETSTAT')).toBe('OK');
    expect.soft(String(await t.call('INFO', 'stats'))).toContain('total_error_replies:0');
    expect.soft(await errOf(t.call('CONFIG', 'RESETSTAT', 'x'))).toBe("ERR wrong number of arguments for 'config|resetstat' command");
  });

  it('GET in RESP3 is a map', async () => {
    await t.call('CONFIG', 'SET', 'maxmemory', '0');
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('CONFIG', 'GET', 'maxmemory')).toBe('%1\r\n$9\r\nmaxmemory\r\n$1\r\n0\r\n');
    expect.soft(await r.send('CONFIG', 'GET', 'nosuchoption')).toBe('%0\r\n');
  });

  it('unknown subcommand and arity', async () => {
    expect.soft(await errOf(t.call('CONFIG', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try CONFIG HELP.");
    expect.soft(await errOf(t.call('CONFIG', 'GET'))).toBe("ERR wrong number of arguments for 'config|get' command");
    expect.soft(await errOf(t.call('CONFIG'))).toBe("ERR wrong number of arguments for 'config' command");
  });
});

describe('TIME / LASTSAVE / SAVE / BGSAVE / ROLE / DEBUG / LOLWUT', () => {
  it('TIME returns seconds and microseconds as bulk strings', async () => {
    const r = await t.raw();
    const reply = await r.send('TIME');
    const m = /^\*2\r\n\$\d+\r\n(\d+)\r\n\$\d+\r\n(\d+)\r\n$/.exec(reply);
    expect.soft(m).not.toBeNull();
    expect.soft(Math.abs(Number(m![1]) - Date.now() / 1000)).toBeLessThan(5);
    expect.soft(Number(m![2])).toBeLessThan(1_000_000);
    expect.soft(await r.send('TIME', 'x')).toBe("-ERR wrong number of arguments for 'time' command\r\n");
    await r.send('HELLO', '3');
    expect.soft(await r.send('TIME')).toMatch(/^\*2\r\n\$\d+\r\n\d+\r\n\$\d+\r\n\d+\r\n$/);
  });

  it('SAVE / BGSAVE / LASTSAVE', async () => {
    const r = await t.raw();
    expect.soft(await r.send('SAVE')).toBe('+OK\r\n');
    const last = await r.send('LASTSAVE');
    expect.soft(last).toMatch(/^:\d+\r\n$/);
    expect.soft(Math.abs(Number(last.slice(1, -2)) - Date.now() / 1000)).toBeLessThan(5);
    await sleep(200);
    expect.soft(await r.send('BGSAVE')).toBe('+Background saving started\r\n');
    await sleep(200);
    expect.soft(await r.send('BGSAVE', 'FOO')).toBe('-ERR syntax error\r\n');
    expect.soft(await r.send('SAVE', 'x')).toBe("-ERR wrong number of arguments for 'save' command\r\n");
    expect.soft(await r.send('LASTSAVE', 'x')).toBe("-ERR wrong number of arguments for 'lastsave' command\r\n");
  });

  it('ROLE on a master', async () => {
    expect.soft(await t.call('ROLE')).toEqual(['master', 0, []]);
    const r = await t.raw();
    expect.soft(await r.send('ROLE')).toBe('*3\r\n$6\r\nmaster\r\n:0\r\n*0\r\n');
  });

  it('DEBUG SLEEP', async () => {
    expect.soft(await t.call('DEBUG', 'SLEEP', '0')).toBe('OK');
    const start = Date.now();
    expect.soft(await t.call('DEBUG', 'SLEEP', '0.1')).toBe('OK');
    expect.soft(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  it('LOLWUT ends with the Redis version', async () => {
    const out = String(await t.call('LOLWUT'));
    expect.soft(out).toMatch(/Redis ver\. 8\.\d+\.\d+/);
    expect.soft(String(await t.call('LOLWUT', 'VERSION', '5'))).toContain('Redis ver.');
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('LOLWUT')).toMatch(/^=\d+\r\ntxt:/);
  });
});

describe('COMMAND', () => {
  it('COUNT matches the length of COMMAND', async () => {
    const count = (await t.call('COMMAND', 'COUNT')) as number;
    expect.soft(count).toBeGreaterThan(200);
    const all = (await t.call('COMMAND')) as unknown[];
    expect.soft(all).toHaveLength(count);
  });

  it('LIST and FILTERBY', async () => {
    const list = (await t.call('COMMAND', 'LIST')) as string[];
    expect.soft(list).toContain('get');
    expect.soft(list).toContain('client');
    const xa = (await t.call('COMMAND', 'LIST', 'FILTERBY', 'PATTERN', 'xa*')) as string[];
    expect.soft(xa).toEqual(expect.arrayContaining(['xack', 'xadd', 'xautoclaim']));
    expect.soft(xa.every((n) => n.startsWith('xa'))).toBe(true);
    const hll = (await t.call('COMMAND', 'LIST', 'FILTERBY', 'ACLCAT', 'hyperloglog')) as string[];
    expect.soft(hll).toEqual(expect.arrayContaining(['pfadd', 'pfcount', 'pfmerge']));
    expect.soft(await t.call('COMMAND', 'LIST', 'FILTERBY', 'MODULE', 'nosuchmodule')).toEqual([]);
    expect.soft(await errOf(t.call('COMMAND', 'LIST', 'FILTERBY', 'FOO', 'x'))).toBe('ERR syntax error');
  });

  it('INFO for GET', async () => {
    const [info] = (await t.call('COMMAND', 'INFO', 'get')) as unknown[][];
    expect.soft(info.slice(0, 7)).toEqual(['get', 2, ['readonly', 'fast'], 1, 1, 1, ['@read', '@string', '@fast']]);
    expect.soft(info[7]).toEqual([]);
    expect.soft(info[8]).toEqual([
      ['flags', ['RO', 'access'], 'begin_search', ['type', 'index', 'spec', ['index', 1]], 'find_keys', ['type', 'range', 'spec', ['lastkey', 0, 'keystep', 1, 'limit', 0]]],
    ]);
    expect.soft(info[9]).toEqual([]);
  });

  it('INFO uses status replies for flags and categories', async () => {
    const r = await t.raw();
    const reply = await r.send('COMMAND', 'INFO', 'get');
    expect.soft(reply.startsWith('*1\r\n*10\r\n$3\r\nget\r\n:2\r\n*2\r\n+readonly\r\n+fast\r\n:1\r\n:1\r\n:1\r\n*3\r\n+@read\r\n+@string\r\n+@fast\r\n')).toBe(true);
  });

  it('INFO for several commands, unknown ones are null, case-insensitive', async () => {
    const res = (await t.call('COMMAND', 'INFO', 'GET', 'nosuchcmd', 'set')) as unknown[];
    expect.soft(res).toHaveLength(3);
    expect.soft((res[0] as unknown[])[0]).toBe('get');
    expect.soft(res[1]).toBeNull();
    expect.soft((res[2] as unknown[]).slice(0, 2)).toEqual(['set', -3]);
  });

  it('INFO for a container command lists subcommands', async () => {
    const [info] = (await t.call('COMMAND', 'INFO', 'config')) as unknown[][];
    expect.soft(info[0]).toBe('config');
    expect.soft(info[1]).toBe(-2);
    const subs = (info[9] as unknown[][]).map((s) => s[0]);
    expect.soft(subs).toEqual(expect.arrayContaining(['config|get', 'config|set', 'config|resetstat']));
    const [sub] = (await t.call('COMMAND', 'INFO', 'config|get')) as unknown[][];
    expect.soft(sub.slice(0, 2)).toEqual(['config|get', -3]);
  });

  it('GETKEYS and GETKEYSANDFLAGS', async () => {
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'SET', 'a', 'b'))).toEqual(['a']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'MSET', 'a', '1', 'b', '2'))).toEqual(['a', 'b']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'EVAL', 'return 1', '2', 'k1', 'k2', 'arg'))).toEqual(['k1', 'k2']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYS', 'ZUNIONSTORE', 'dst', '2', 's1', 's2'))).toEqual(['dst', 's1', 's2']);
    expect.soft(await errOrValue(t.call('COMMAND', 'GETKEYSANDFLAGS', 'GET', 'k'))).toEqual([['k', ['RO', 'access']]]);
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS', 'PING'))).toBe('ERR The command has no key arguments');
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS', 'NOSUCH', 'a'))).toBe('ERR Invalid command specified');
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS', 'GET'))).toBe('ERR Invalid number of arguments specified for command');
    expect.soft(await errOf(t.call('COMMAND', 'GETKEYS'))).toBe("ERR wrong number of arguments for 'command|getkeys' command");
  });

  it('DOCS for GET', async () => {
    const res = (await t.call('COMMAND', 'DOCS', 'get')) as unknown[];
    expect.soft(res[0]).toBe('get');
    const doc = pairs(res[1]);
    expect.soft(doc.summary).toBe('Returns the string value of a key.');
    expect.soft(doc.since).toBe('1.0.0');
    expect.soft(doc.group).toBe('string');
    expect.soft(doc.complexity).toBe('O(1)');
    const args = (doc.arguments as unknown[][]).map(pairs);
    expect.soft(args[0]).toMatchObject({ name: 'key', type: 'key', display_text: 'key', key_spec_index: 0 });
    expect.soft(await t.call('COMMAND', 'DOCS', 'nosuchcmd')).toEqual([]);
  });

  it('DOCS in RESP3 is a map', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft((await r.send('COMMAND', 'DOCS', 'get')).startsWith('%1\r\n$3\r\nget\r\n%')).toBe(true);
  });

  it('unknown subcommand', async () => {
    expect.soft(await errOf(t.call('COMMAND', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try COMMAND HELP.");
  });
});

describe('ACL', () => {
  it('WHOAMI / USERS / LIST', async () => {
    expect.soft(await t.call('ACL', 'WHOAMI')).toBe('default');
    expect.soft(await t.call('ACL', 'USERS')).toEqual(['default']);
    expect.soft(await t.call('ACL', 'LIST')).toEqual(['user default on nopass sanitize-payload ~* &* +@all']);
  });

  it('CAT lists categories and the commands in a category', async () => {
    const cats = (await t.call('ACL', 'CAT')) as string[];
    expect.soft(cats).toEqual(
      expect.arrayContaining([
        'keyspace', 'read', 'write', 'set', 'sortedset', 'list', 'hash', 'string', 'bitmap', 'hyperloglog', 'geo',
        'stream', 'pubsub', 'admin', 'fast', 'slow', 'blocking', 'dangerous', 'connection', 'transaction', 'scripting',
      ]),
    );
    const str = (await t.call('ACL', 'CAT', 'string')) as string[];
    expect.soft(str).toEqual(expect.arrayContaining(['get', 'set', 'incr', 'append']));
    expect.soft(str).not.toContain('lpush');
    expect.soft(await errOf(t.call('ACL', 'CAT', 'nosuchcat'))).toBe("ERR Unknown category 'nosuchcat'");
  });

  it('GETUSER default', async () => {
    const u = pairs(await t.call('ACL', 'GETUSER', 'default'));
    expect.soft(u.flags).toEqual(['on', 'nopass', 'sanitize-payload']);
    expect.soft(u.passwords).toEqual([]);
    expect.soft(u.commands).toBe('+@all');
    expect.soft(u.keys).toBe('~*');
    expect.soft(u.channels).toBe('&*');
    expect.soft(u.selectors).toEqual([]);
    expect.soft(await t.call('ACL', 'GETUSER', 'nosuchuser')).toBeNull();
  });

  it('GETUSER in RESP3 is a map', async () => {
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft((await r.send('ACL', 'GETUSER', 'default')).startsWith('%6\r\n$5\r\nflags\r\n')).toBe(true);
    expect.soft(await r.send('ACL', 'GETUSER', 'nosuchuser')).toBe('_\r\n');
  });

  it('GENPASS', async () => {
    expect.soft(await t.call('ACL', 'GENPASS')).toMatch(/^[0-9a-f]{64}$/);
    expect.soft(await t.call('ACL', 'GENPASS', '32')).toMatch(/^[0-9a-f]{8}$/);
    expect.soft(await t.call('ACL', 'GENPASS', '5')).toMatch(/^[0-9a-f]{2}$/);
    expect.soft(await t.call('ACL', 'GENPASS')).not.toBe(await t.call('ACL', 'GENPASS'));
    const msg = 'ERR ACL GENPASS argument must be the number of bits for the output password, a positive number up to 4096';
    expect.soft(await errOf(t.call('ACL', 'GENPASS', '0'))).toBe(msg);
    expect.soft(await errOf(t.call('ACL', 'GENPASS', '5000'))).toBe(msg);
  });

  it('DRYRUN', async () => {
    expect.soft(await t.call('ACL', 'DRYRUN', 'default', 'GET', 'k')).toBe('OK');
    expect.soft(await errOf(t.call('ACL', 'DRYRUN', 'nosuchuser', 'GET', 'k'))).toBe("ERR User 'nosuchuser' not found");
    // unverified: exact wording for an unknown command
    expect.soft(await errOf(t.call('ACL', 'DRYRUN', 'default', 'NOSUCHCMD'))).toBe("ERR Command 'NOSUCHCMD' not found");
  });

  it('LOG is empty and can be reset', async () => {
    // earlier tests in this file fail AUTH / HELLO AUTH, which Redis records in the ACL LOG
    expect.soft(await t.call('ACL', 'LOG', 'RESET')).toBe('OK');
    expect.soft(await t.call('ACL', 'LOG')).toEqual([]);
    expect.soft(await t.call('ACL', 'LOG', '5')).toEqual([]);
    expect.soft(await t.call('ACL', 'LOG', 'RESET')).toBe('OK');
  });

  it('unknown subcommand and arity', async () => {
    expect.soft(await errOf(t.call('ACL', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try ACL HELP.");
    expect.soft(await errOf(t.call('ACL', 'WHOAMI', 'x'))).toBe("ERR wrong number of arguments for 'acl|whoami' command");
    expect.soft(await errOf(t.call('ACL'))).toBe("ERR wrong number of arguments for 'acl' command");
  });
});

describe('MONITOR / SLOWLOG / LATENCY / MEMORY', () => {
  it('MONITOR streams executed commands', async () => {
    const m = await t.raw();
    expect.soft(await m.send('MONITOR')).toBe('+OK\r\n');
    const r = await t.raw();
    await r.send('SET', 'mon:k', 'v a');
    const line = await m.read();
    expect.soft(line).toMatch(/^\+\d+\.\d{6} \[0 127\.0\.0\.1:\d+\] "SET" "mon:k" "v a"\r\n$/);
  });

  it('SLOWLOG GET / LEN / RESET', async () => {
    expect.soft(await t.call('SLOWLOG', 'RESET')).toBe('OK');
    expect.soft(await t.call('SLOWLOG', 'LEN')).toBe(0);
    expect.soft(await t.call('SLOWLOG', 'GET')).toEqual([]);
    await t.call('DEBUG', 'SLEEP', '0.05');
    const entries = (await t.call('SLOWLOG', 'GET')) as unknown[][];
    expect.soft(entries).toHaveLength(1);
    const [id, ts, dur, argv, , name] = entries[0];
    expect.soft(typeof id).toBe('number');
    expect.soft(typeof ts).toBe('number');
    expect.soft(dur as number).toBeGreaterThanOrEqual(10000);
    expect.soft(argv).toEqual(['DEBUG', 'SLEEP', '0.05']);
    expect.soft(name).toBe('');
    expect.soft(await t.call('SLOWLOG', 'LEN')).toBe(1);
    expect.soft(await t.call('SLOWLOG', 'GET', '-1')).toHaveLength(1);
    expect.soft(await t.call('SLOWLOG', 'GET', '0')).toEqual([]);
    expect.soft(await t.call('SLOWLOG', 'RESET')).toBe('OK');
    expect.soft(await t.call('SLOWLOG', 'LEN')).toBe(0);
    expect.soft(await errOf(t.call('SLOWLOG', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try SLOWLOG HELP.");
  });

  it('LATENCY', async () => {
    expect.soft(await t.call('LATENCY', 'LATEST')).toEqual([]);
    expect.soft(await t.call('LATENCY', 'HISTORY', 'command')).toEqual([]);
    expect.soft(await t.call('LATENCY', 'RESET')).toBe(0);
    expect.soft(typeof (await t.call('LATENCY', 'DOCTOR'))).toBe('string');
    expect.soft(await errOf(t.call('LATENCY', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try LATENCY HELP.");
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('LATENCY', 'DOCTOR')).toMatch(/^=\d+\r\ntxt:/);
  });

  it('MEMORY USAGE', async () => {
    await t.call('SET', 'mem:k', 'hello');
    const used = (await t.call('MEMORY', 'USAGE', 'mem:k')) as number;
    expect.soft(used).toBeGreaterThan(0);
    expect.soft(await t.call('MEMORY', 'USAGE', 'mem:k', 'SAMPLES', '0')).toBeGreaterThan(0);
    expect.soft(await t.call('MEMORY', 'USAGE', 'mem:missing')).toBeNull();
    await t.call('RPUSH', 'mem:list', 'a', 'b');
    expect.soft(await t.call('MEMORY', 'USAGE', 'mem:list')).toBeGreaterThan(0);
    expect.soft(await errOf(t.call('MEMORY', 'USAGE', 'mem:k', 'FOO'))).toBe('ERR syntax error');
    expect.soft(await errOf(t.call('MEMORY', 'USAGE', 'mem:k', 'SAMPLES', 'x'))).toBe('ERR value is not an integer or out of range');
    expect.soft(await errOf(t.call('MEMORY', 'USAGE'))).toBe("ERR wrong number of arguments for 'memory|usage' command");
    const r = await t.raw();
    await r.send('HELLO', '3');
    expect.soft(await r.send('MEMORY', 'USAGE', 'mem:missing')).toBe('_\r\n');
  });

  it('MEMORY DOCTOR', async () => {
    expect.soft(typeof (await t.call('MEMORY', 'DOCTOR'))).toBe('string');
    expect.soft(await errOf(t.call('MEMORY', 'FOO'))).toBe("ERR unknown subcommand 'FOO'. Try MEMORY HELP.");
  });
});

describe('WAIT / WAITAOF', () => {
  it('WAIT with no replicas returns 0', async () => {
    expect.soft(await t.call('WAIT', '0', '0')).toBe(0);
    expect.soft(await t.call('WAIT', '1', '10')).toBe(0);
    expect.soft(await errOf(t.call('WAIT', '0', '-1'))).toBe('ERR timeout is negative');
    expect.soft(await errOf(t.call('WAIT', 'abc', '0'))).toBe('ERR value is not an integer or out of range');
    expect.soft(await errOf(t.call('WAIT', '0'))).toBe("ERR wrong number of arguments for 'wait' command");
  });

  it('WAITAOF', async () => {
    expect.soft(await t.call('WAITAOF', '0', '0', '0')).toEqual([0, 0]);
    expect.soft(await errOf(t.call('WAITAOF', '1', '0', '0'))).toBe(
      'ERR WAITAOF cannot be used when numlocal is set but appendonly is disabled.',
    );
    expect.soft(await errOf(t.call('WAITAOF', '0', '0'))).toBe("ERR wrong number of arguments for 'waitaof' command");
  });
});
