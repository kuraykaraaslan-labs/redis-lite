import { describe, expect, it } from 'vitest';

import { eventually, RawClient, sleep, useServer } from '@/tests/helpers';

/**
 * MEMORY USAGE / MEMORY STATS / INFO memory / DEBUG OBJECT end to end. Byte counts are derived from the Redis 8 layouts
 * (object.c objectComputeSize, kvobj with embedded key, jemalloc size classes); the rest checks Redis's reply shapes and
 * the invariants Redis guarantees between them.
 */

const t = useServer();

async function errOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'NO ERROR';
}

/** Flat RESP2 map → entries. */
function pairs(flat: unknown[]): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (let i = 0; i < flat.length; i += 2) out.push([String(flat[i]), flat[i + 1]]);
  return out;
}

async function memoryStats(): Promise<Map<string, unknown>> {
  return new Map(pairs((await t.call('MEMORY', 'STATS')) as unknown[]));
}

async function infoMemory(): Promise<Map<string, string>> {
  const text = String(await t.call('INFO', 'memory'));
  const out = new Map<string, string>();
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0 && !line.startsWith('#')) out.set(line.slice(0, i), line.slice(i + 1));
  }
  return out;
}

describe('MEMORY USAGE', () => {
  it('strings: int and embstr (Redis 7.0: robj + key sds + dict entry; a TTL costs nothing here)', async () => {
    // int: robj 16 + key sds (hdr5 1 + 6 + NUL → 8) + sizeof(dictEntry) 24
    await t.call('SET', 'mk:int', '12345');
    expect(await t.call('OBJECT', 'ENCODING', 'mk:int')).toBe('int');
    expect(await t.call('MEMORY', 'USAGE', 'mk:int')).toBe(48);
    // embstr: robj 16 + sdshdr8 value (3 + 16 + 1) = 36 → 48, + key 8 + 24
    await t.call('SET', 'mk:e', 'abcdefghijklmnop');
    expect(await t.call('OBJECT', 'ENCODING', 'mk:e')).toBe('embstr');
    expect(await t.call('MEMORY', 'USAGE', 'mk:e')).toBe(80);
    await t.call('SET', 'mk:e', 'abcdefghijklmnop', 'PX', '100000');
    expect(await t.call('MEMORY', 'USAGE', 'mk:e')).toBe(80);
  });

  it('missing keys, SAMPLES and errors', async () => {
    expect(await t.call('MEMORY', 'USAGE', 'mk:none')).toBeNull();
    await t.call('SADD', 'mk:set', ...Array.from({ length: 300 }, (_, i) => `member-${i}`));
    expect(await t.call('OBJECT', 'ENCODING', 'mk:set')).toBe('hashtable');
    const all = (await t.call('MEMORY', 'USAGE', 'mk:set', 'SAMPLES', '0')) as number;
    const five = (await t.call('MEMORY', 'USAGE', 'mk:set')) as number;
    expect(all).toBeGreaterThan(300 * 16);
    // every member has the same size class here, so sampling 5 or all gives the same estimate
    expect(five).toBe(all);
    expect(await errOf(t.call('MEMORY', 'USAGE', 'mk:set', 'SAMPLES', '-1'))).toBe('ERR syntax error');
    expect(await errOf(t.call('MEMORY', 'USAGE', 'mk:set', 'SAMPLES'))).toBe('ERR syntax error');
    expect(await errOf(t.call('MEMORY', 'USAGE', 'mk:set', 'SAMPLES', 'x'))).toBe('ERR value is not an integer or out of range');
  });

  it('grows with the value and follows the encoding change', async () => {
    await t.call('RPUSH', 'mk:list', 'a');
    const small = (await t.call('MEMORY', 'USAGE', 'mk:list')) as number;
    await t.call('RPUSH', 'mk:list', ...Array.from({ length: 50 }, (_, i) => `element-${i}`));
    const bigger = (await t.call('MEMORY', 'USAGE', 'mk:list')) as number;
    expect(bigger).toBeGreaterThan(small);
    await t.call('HSET', 'mk:h', 'f', 'v');
    const lp = (await t.call('MEMORY', 'USAGE', 'mk:h')) as number;
    await t.call('HSET', 'mk:h', 'long', 'x'.repeat(100));
    expect(await t.call('OBJECT', 'ENCODING', 'mk:h')).toBe('hashtable');
    expect(await t.call('MEMORY', 'USAGE', 'mk:h')).toBeGreaterThan(lp);
  });
});

describe('MEMORY STATS', () => {
  it('has the Redis fields in order and adds up', async () => {
    await t.call('SET', 'ms:a', 'value');
    await t.call('SET', 'ms:b', 'value', 'EX', '1000');
    const stats = await memoryStats();
    const keys = [...stats.keys()];
    const head = [
      'peak.allocated', 'total.allocated', 'startup.allocated', 'replication.backlog', 'clients.slaves', 'clients.normal',
      'cluster.links', 'aof.buffer', 'lua.caches', 'functions.caches',
    ];
    expect(keys.slice(0, head.length)).toEqual(head);
    expect(keys[head.length]).toBe('db.0');
    expect(keys.slice(head.length + 1)).toEqual([
      'overhead.total', 'keys.count', 'keys.bytes-per-key', 'dataset.bytes', 'dataset.percentage', 'peak.percentage',
      'allocator.allocated', 'allocator.active', 'allocator.resident', 'allocator-fragmentation.ratio', 'allocator-fragmentation.bytes',
      'allocator-rss.ratio', 'allocator-rss.bytes', 'rss-overhead.ratio', 'rss-overhead.bytes', 'fragmentation',
      'fragmentation.bytes',
    ]);
    expect(stats.get('db.0')).toEqual([
      'overhead.hashtable.main', expect.any(Number), 'overhead.hashtable.expires', expect.any(Number), 'overhead.hashtable.slot-to-keys', 0,
    ]);
    const n = (k: string): number => Number(stats.get(k));
    // getMemoryOverheadData(): total = overhead + dataset; keys.count = every key of every db
    expect(n('overhead.total') + n('dataset.bytes')).toBe(n('total.allocated'));
    expect(n('keys.count')).toBe(await t.call('DBSIZE'));
    expect(n('peak.allocated')).toBeGreaterThanOrEqual(n('total.allocated'));
    expect(n('keys.bytes-per-key')).toBe(Math.floor((n('total.allocated') - n('startup.allocated')) / n('keys.count')));
    // doubles are bulk strings in RESP2
    expect(typeof stats.get('fragmentation')).toBe('string');
    expect(Number(stats.get('dataset.percentage'))).toBeGreaterThan(0);
  });

  it('is a map with nested db maps and doubles in RESP3', async () => {
    const r = await RawClient.open(t.server.port);
    await r.send('HELLO', '3');
    const reply = await r.send('MEMORY', 'STATS');
    expect(reply).toMatch(/^%\d+\r\n\$14\r\npeak\.allocated\r\n:\d+\r\n/);
    expect(reply).toMatch(/\$4\r\ndb\.0\r\n%3\r\n\$23\r\noverhead\.hashtable\.main\r\n:\d+\r\n/);
    expect(reply).toMatch(/\$13\r\nfragmentation\r\n,[\d.e+-]+\r\n/);
    r.close();
  });

  it('a key with a TTL counts in the expires overhead', async () => {
    const before = (await memoryStats()).get('db.0') as unknown[];
    await t.call('SET', 'ms:ttl', 'x', 'EX', '1000');
    const after = (await memoryStats()).get('db.0') as unknown[];
    expect(Number(after[3])).toBeGreaterThan(Number(before[3]));
  });
});

describe('INFO memory', () => {
  it('agrees with MEMORY STATS and prints Redis fields', async () => {
    const info = await infoMemory();
    const stats = await memoryStats();
    // the two commands differ only by the caller's own arguments (argv-mem), counted in clients.normal
    const near = (a: unknown, b: unknown): void => expect(Math.abs(Number(a) - Number(b))).toBeLessThan(64);
    near(info.get('used_memory'), stats.get('total.allocated'));
    expect(Number(info.get('used_memory_dataset'))).toBe(Number(stats.get('dataset.bytes')));
    near(info.get('used_memory_overhead'), stats.get('overhead.total'));
    expect(Number(info.get('used_memory_startup'))).toBe(Number(stats.get('startup.allocated')));
    expect(info.get('used_memory_human')).toMatch(/^\d+(\.\d\d[KMGTPE])?B?$|^\d+\.\d\d[KMGTPE]$/);
    expect(info.get('used_memory_peak_perc')).toMatch(/^\d+\.\d\d%$/);
    expect(info.get('mem_fragmentation_ratio')).toMatch(/^\d+\.\d\d$/);
    expect(info.get('mem_allocator')).toMatch(/^jemalloc-/);
    expect(info.get('maxmemory_policy')).toBe('noeviction');
    for (const f of ['used_memory_rss', 'used_memory_lua', 'used_memory_scripts', 'total_system_memory', 'lazyfree_pending_objects']) {
      expect(info.has(f)).toBe(true);
    }
  });

  it('used_memory_peak keeps the high-water mark after a big delete', async () => {
    await t.call('SET', 'peak:big', 'x'.repeat(200_000));
    const high = Number((await infoMemory()).get('used_memory'));
    await t.call('DEL', 'peak:big');
    const info = await infoMemory();
    expect(Number(info.get('used_memory'))).toBeLessThan(high - 190_000);
    expect(Number(info.get('used_memory_peak'))).toBeGreaterThanOrEqual(high);
    expect(info.has('used_memory_peak_time')).toBe(false);
  });

  it('the peak survives FLUSHDB even when nobody looked at INFO before', async () => {
    await t.call('SELECT', '3');
    await t.call('SET', 'peak:big2', 'y'.repeat(400_000));
    await t.call('FLUSHDB');
    await t.call('SELECT', '0');
    const info = await infoMemory();
    expect(Number(info.get('used_memory_peak')) - Number(info.get('used_memory'))).toBeGreaterThan(390_000);
  });
});

describe('MEMORY DOCTOR / MALLOC-STATS / PURGE / HELP', () => {
  it('replies like Redis on a small instance', async () => {
    expect(await t.call('MEMORY', 'DOCTOR')).toBe(
      "Hi Sam, this instance is empty or is using very little memory, my issues detector can't be used in these conditions. Please, leave for your mission on Earth and fill it with some data. The new Sam and I will be back to our programming as soon as I finished rebooting.\n",
    );
    expect(await t.call('MEMORY', 'PURGE')).toBe('OK');
    expect(typeof (await t.call('MEMORY', 'MALLOC-STATS'))).toBe('string');
    const help = (await t.call('MEMORY', 'HELP')) as string[];
    expect(help[0]).toBe('MEMORY <subcommand> [<arg> [value] [opt] ...]. Subcommands are:');
    expect(await errOf(t.call('MEMORY', 'DOCTOR', 'x'))).toBe("ERR wrong number of arguments for 'memory|doctor' command");
  });
});

describe('DEBUG OBJECT', () => {
  const FORMAT = /^Value at:0x[0-9a-f]+ refcount:(\d+) encoding:(\S+) serializedlength:(\d+) lru:(\d+) lru_seconds_idle:(\d+)(.*)$/;

  it('prints the Redis fields', async () => {
    await t.call('SET', 'do:s', 'hello');
    const m = FORMAT.exec(String(await t.call('DEBUG', 'OBJECT', 'do:s')));
    expect(m).not.toBeNull();
    const [, refcount, enc, serialized, lru, idle, extra] = m as RegExpExecArray;
    expect(refcount).toBe('1');
    expect(enc).toBe('embstr');
    // RDB string: 1 length byte + 5 bytes
    expect(serialized).toBe('6');
    expect(Number(lru)).toBeLessThan(2 ** 24);
    expect(idle).toBe('0');
    expect(extra).toBe('');
    expect(await errOf(t.call('DEBUG', 'OBJECT', 'do:none'))).toBe('ERR no such key');
  });

  it('shared integers have the shared refcount and serialize as RDB integers', async () => {
    await t.call('SET', 'do:i', '123');
    const m = FORMAT.exec(String(await t.call('DEBUG', 'OBJECT', 'do:i'))) as RegExpExecArray;
    expect(m[1]).toBe('2147483647');
    expect(m[2]).toBe('int');
    expect(m[3]).toBe('2'); // RDB_ENC_INT8: 1 + 1
  });

  it('serializedlength is the DUMP payload minus its type byte and 10-byte footer', async () => {
    await t.call('HSET', 'do:h', 'a', '1', 'b', '2');
    await t.call('ZADD', 'do:z', '1', 'x', '2.5', 'y');
    await t.call('RPUSH', 'do:l', ...Array.from({ length: 300 }, (_, i) => `v${i}`));
    for (const key of ['do:h', 'do:z', 'do:l', 'do:s']) {
      const dump = (await t.redis.dumpBuffer(key)) as Buffer;
      const m = FORMAT.exec(String(await t.call('DEBUG', 'OBJECT', key))) as RegExpExecArray;
      expect(Number(m[3])).toBe(dump.length - 11);
      expect(m[2]).toBe(await t.call('OBJECT', 'ENCODING', key));
    }
  });

  it('quicklists add the ql_* fields', async () => {
    await t.call('CONFIG', 'SET', 'list-max-listpack-size', '4');
    await t.call('RPUSH', 'do:ql', ...Array.from({ length: 10 }, (_, i) => `a${i}`));
    expect(await t.call('OBJECT', 'ENCODING', 'do:ql')).toBe('quicklist');
    const m = FORMAT.exec(String(await t.call('DEBUG', 'OBJECT', 'do:ql'))) as RegExpExecArray;
    // nodes of 4, 4 and 2 'aN' entries: listpack = 7 bytes + 4 per entry
    expect(m[6]).toBe(' ql_nodes:3 ql_avg_node:3.33 ql_listpack_max:4 ql_compressed:0 ql_uncompressed_size:61');
    await t.call('CONFIG', 'SET', 'list-max-listpack-size', '-2');
  });

  it('FAST omits serializedlength', async () => {
    expect(String(await t.call('DEBUG', 'OBJECT', 'do:s', 'fast'))).toMatch(
      /^Value at:0x[0-9a-f]+ refcount:1 encoding:embstr lru:\d+ lru_seconds_idle:\d+$/,
    );
  });
});

describe('DEBUG subcommands', () => {
  it('POPULATE creates key:N = value:N, skipping existing keys', async () => {
    await t.call('SELECT', '5');
    await t.call('SET', 'key:1', 'mine');
    expect(await t.call('DEBUG', 'POPULATE', '3')).toBe('OK');
    expect(await t.call('MGET', 'key:0', 'key:1', 'key:2')).toEqual(['value:0', 'mine', 'value:2']);
    expect(await t.call('DEBUG', 'POPULATE', '2', 'p', '10')).toBe('OK');
    expect(await t.call('GET', 'p:1')).toBe('value:1\0\0\0');
    expect(await t.call('DEBUG', 'POPULATE', '1', 'q', '3')).toBe('OK');
    expect(await t.call('GET', 'q:0')).toBe('val');
    expect(await t.call('DBSIZE')).toBe(6);
    expect(await errOf(t.call('DEBUG', 'POPULATE', '-1'))).toBe('ERR value is out of range, must be positive');
    await t.call('FLUSHDB');
    await t.call('SELECT', '0');
  });

  it('SET-ACTIVE-EXPIRE stops the background expire cycle', async () => {
    const expired = async (): Promise<number> => Number(/expired_keys:(\d+)/.exec(String(await t.call('INFO', 'stats')))?.[1]);
    expect(await t.call('DEBUG', 'SET-ACTIVE-EXPIRE', '0')).toBe('OK');
    const before = await expired();
    await t.call('SET', 'ae:k', 'v', 'PX', '20');
    // an absence can only be checked over a window: several cycles would have run in it (fewer under load, which
    // can only make this pass more easily, never fail spuriously)
    await sleep(250);
    expect(await expired()).toBe(before);
    expect(await t.call('DEBUG', 'SET-ACTIVE-EXPIRE', '1')).toBe('OK');
    await eventually(async () => expect(await expired()).toBe(before + 1));
  });

  it('CHANGE-REPL-ID changes master_replid', async () => {
    const replid = async (): Promise<string> => /master_replid:(\w+)/.exec(String(await t.call('INFO', 'replication')))?.[1] ?? '';
    const before = await replid();
    expect(await t.call('DEBUG', 'CHANGE-REPL-ID')).toBe('OK');
    const after = await replid();
    expect(after).toMatch(/^[0-9a-f]{40}$/);
    expect(after).not.toBe(before);
  });

  it('LISTPACK / QUICKLIST / STRINGMATCH-LEN / QUICKLIST-PACKED-THRESHOLD', async () => {
    await t.call('RPUSH', 'dbg:lp', 'a');
    await t.call('HSET', 'dbg:h', 'f', 'v');
    expect(await t.call('DEBUG', 'LISTPACK', 'dbg:h')).toBe('Listpack structure printed on stdout');
    expect(await t.call('DEBUG', 'QUICKLIST', 'dbg:lp')).toBe('Quicklist structure printed on stdout');
    expect(await errOf(t.call('DEBUG', 'LISTPACK', 'dbg:lp'))).toBe('ERR Not a listpack encoded object.');
    expect(await errOf(t.call('DEBUG', 'QUICKLIST', 'dbg:h'))).toBe('ERR Not a quicklist encoded object.');
    expect(await errOf(t.call('DEBUG', 'LISTPACK', 'mk:int'))).toBe('ERR Not a listpack encoded object.');
    expect(await errOf(t.call('DEBUG', 'LISTPACK', 'dbg:none'))).toBe('ERR no such key');
    expect(await t.call('DEBUG', 'STRINGMATCH-LEN')).toBe('Apparently Redis did not crash: test passed');
    expect(await t.call('DEBUG', 'QUICKLIST-PACKED-THRESHOLD', '1mb')).toBe('OK');
    expect(await errOf(t.call('DEBUG', 'QUICKLIST-PACKED-THRESHOLD', 'abc'))).toBe(
      'ERR argument must be a memory value bigger than 1 and smaller than 4gb',
    );
  });

  it('HELP and unknown subcommands', async () => {
    const help = (await t.call('DEBUG', 'HELP')) as string[];
    expect(help[0]).toBe('DEBUG <subcommand> [<arg> [value] [opt] ...]. Subcommands are:');
    expect(help.at(-2)).toBe('HELP');
    expect(await errOf(t.call('DEBUG', 'NOSUCH'))).toBe("ERR unknown subcommand or wrong number of arguments for 'NOSUCH'. Try DEBUG HELP.");
    expect(await errOf(t.call('DEBUG', 'SLEEP'))).toBe("ERR unknown subcommand or wrong number of arguments for 'SLEEP'. Try DEBUG HELP.");
  });
});
