import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '@/tests/helpers';

/**
 * Generic key commands.
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

/** Resolves to the error message of a rejected call (fails if the call succeeds). */
async function err(p: Promise<unknown>): Promise<string> {
  try {
    const v = await p;
    return `NO ERROR, got ${JSON.stringify(v)}`;
  } catch (e) {
    return (e as Error).message;
  }
}

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const SYNTAX = 'ERR syntax error';

const NOT_INT = 'ERR value is not an integer or out of range';

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

/* ------------------------------------------------------------------ */
/* DEL / UNLINK / EXISTS / TYPE / TOUCH                                */
/* ------------------------------------------------------------------ */
describe('DEL / UNLINK', () => {
  it('DEL removes keys and counts only existing ones', async () => {
    await t.call('MSET', 'del:a', '1', 'del:b', '2');
    await t.call('RPUSH', 'del:l', 'x');
    expect(await t.call('DEL', 'del:a', 'del:b', 'del:l', 'del:missing')).toBe(3);
    expect(await t.call('EXISTS', 'del:a', 'del:b', 'del:l')).toBe(0);
    expect(await t.call('DEL', 'del:a')).toBe(0);
  });

  it('DEL counts a duplicated key once', async () => {
    await t.call('SET', 'del:dup', 'v');
    expect(await t.call('DEL', 'del:dup', 'del:dup')).toBe(1);
  });

  it('UNLINK behaves like DEL', async () => {
    await t.call('MSET', 'unl:a', '1', 'unl:b', '2');
    await t.call('SADD', 'unl:s', 'm');
    expect(await t.call('UNLINK', 'unl:a', 'unl:s', 'unl:none')).toBe(2);
    expect(await t.call('GET', 'unl:b')).toBe('2');
    expect(await t.call('EXISTS', 'unl:a', 'unl:s')).toBe(0);
  });

  it('arity errors', async () => {
    expect(await err(t.call('DEL'))).toBe(arity('del'));
    expect(await err(t.call('UNLINK'))).toBe(arity('unlink'));
  });
});

describe('EXISTS', () => {
  it('counts each argument, duplicates included', async () => {
    await t.call('SET', 'ex:a', 'v');
    await t.call('HSET', 'ex:h', 'f', 'v');
    expect(await t.call('EXISTS', 'ex:a')).toBe(1);
    expect(await t.call('EXISTS', 'ex:none')).toBe(0);
    expect(await t.call('EXISTS', 'ex:a', 'ex:a', 'ex:a')).toBe(3);
    expect(await t.call('EXISTS', 'ex:a', 'ex:h', 'ex:none')).toBe(2);
  });

  it('expired keys do not exist', async () => {
    await t.call('SET', 'ex:tmp', 'v', 'PX', 30);
    await sleep(80);
    expect(await t.call('EXISTS', 'ex:tmp')).toBe(0);
  });

  it('arity error', async () => {
    expect(await err(t.call('EXISTS'))).toBe(arity('exists'));
  });
});

describe('TYPE', () => {
  it('reports every type and none', async () => {
    await t.call('SET', 'ty:s', 'v');
    await t.call('RPUSH', 'ty:l', 'v');
    await t.call('SADD', 'ty:set', 'v');
    await t.call('ZADD', 'ty:z', 1, 'v');
    await t.call('HSET', 'ty:h', 'f', 'v');
    await t.call('XADD', 'ty:x', '*', 'f', 'v');
    expect(await t.call('TYPE', 'ty:s')).toBe('string');
    expect(await t.call('TYPE', 'ty:l')).toBe('list');
    expect(await t.call('TYPE', 'ty:set')).toBe('set');
    expect(await t.call('TYPE', 'ty:z')).toBe('zset');
    expect(await t.call('TYPE', 'ty:h')).toBe('hash');
    expect(await t.call('TYPE', 'ty:x')).toBe('stream');
    expect(await t.call('TYPE', 'ty:none')).toBe('none');
  });

  it('is a simple string in RESP2 and RESP3', async () => {
    await t.call('SET', 'ty:raw', 'v');
    const r2 = await t.raw();
    expect(await r2.send('TYPE', 'ty:raw')).toBe('+string\r\n');
    expect(await r2.send('TYPE', 'ty:nothing')).toBe('+none\r\n');
    const r3 = await resp3();
    expect(await r3.send('TYPE', 'ty:raw')).toBe('+string\r\n');
  });

  it('arity error', async () => {
    expect(await err(t.call('TYPE'))).toBe(arity('type'));
    expect(await err(t.call('TYPE', 'a', 'b'))).toBe(arity('type'));
  });
});

describe('TOUCH', () => {
  it('returns the number of existing keys touched', async () => {
    await t.call('MSET', 'to:a', '1', 'to:b', '2');
    expect(await t.call('TOUCH', 'to:a', 'to:b', 'to:c')).toBe(2);
    expect(await t.call('TOUCH', 'to:none')).toBe(0);
  });

  it('arity error', async () => {
    expect(await err(t.call('TOUCH'))).toBe(arity('touch'));
  });
});

/* ------------------------------------------------------------------ */
/* RENAME / RENAMENX / COPY / MOVE                                     */
/* ------------------------------------------------------------------ */
describe('RENAME', () => {
  it('renames and overwrites the destination of any type', async () => {
    await t.call('SET', 'rn:src', 'hello');
    await t.call('RPUSH', 'rn:dst', 'x');
    expect(await t.call('RENAME', 'rn:src', 'rn:dst')).toBe('OK');
    expect(await t.call('GET', 'rn:dst')).toBe('hello');
    expect(await t.call('EXISTS', 'rn:src')).toBe(0);
  });

  it('carries the TTL over', async () => {
    await t.call('SET', 'rn:ttl', 'v', 'EX', 100);
    await t.call('RENAME', 'rn:ttl', 'rn:ttl2');
    const ttl = (await t.call('TTL', 'rn:ttl2')) as number;
    expect(ttl).toBeGreaterThan(95);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it('destination TTL is replaced by the source (no TTL)', async () => {
    await t.call('SET', 'rn:a', 'a');
    await t.call('SET', 'rn:b', 'b', 'EX', 100);
    await t.call('RENAME', 'rn:a', 'rn:b');
    expect(await t.call('TTL', 'rn:b')).toBe(-1);
  });

  it('same name: OK when the key exists, TTL kept', async () => {
    await t.call('SET', 'rn:same', 'v', 'EX', 100);
    expect(await t.call('RENAME', 'rn:same', 'rn:same')).toBe('OK');
    expect(await t.call('GET', 'rn:same')).toBe('v');
    expect(await t.call('TTL', 'rn:same')).toBeGreaterThan(95);
  });

  it('missing source', async () => {
    expect(await err(t.call('RENAME', 'rn:missing', 'rn:x'))).toBe('ERR no such key');
    expect(await err(t.call('RENAME', 'rn:missing', 'rn:missing'))).toBe('ERR no such key');
  });

  it('arity error', async () => {
    expect(await err(t.call('RENAME', 'a'))).toBe(arity('rename'));
  });
});

describe('RENAMENX', () => {
  it('renames only when the destination is missing', async () => {
    await t.call('MSET', 'rnx:a', 'A', 'rnx:b', 'B');
    expect(await t.call('RENAMENX', 'rnx:a', 'rnx:b')).toBe(0);
    expect(await t.call('GET', 'rnx:a')).toBe('A');
    expect(await t.call('RENAMENX', 'rnx:a', 'rnx:c')).toBe(1);
    expect(await t.call('GET', 'rnx:c')).toBe('A');
    expect(await t.call('EXISTS', 'rnx:a')).toBe(0);
  });

  it('carries the TTL over', async () => {
    await t.call('SET', 'rnx:ttl', 'v', 'PX', 100000);
    expect(await t.call('RENAMENX', 'rnx:ttl', 'rnx:ttl2')).toBe(1);
    expect(await t.call('PTTL', 'rnx:ttl2')).toBeGreaterThan(95000);
  });

  it('same name returns 0', async () => {
    await t.call('SET', 'rnx:same', 'v');
    expect(await t.call('RENAMENX', 'rnx:same', 'rnx:same')).toBe(0);
    expect(await t.call('GET', 'rnx:same')).toBe('v');
  });

  it('missing source and arity', async () => {
    expect(await err(t.call('RENAMENX', 'rnx:missing', 'rnx:z'))).toBe('ERR no such key');
    expect(await err(t.call('RENAMENX', 'a'))).toBe(arity('renamenx'));
  });
});

describe('COPY', () => {
  it('copies a string and keeps the source', async () => {
    await t.call('SET', 'cp:s', 'sheep');
    expect(await t.call('COPY', 'cp:s', 'cp:d')).toBe(1);
    expect(await t.call('GET', 'cp:d')).toBe('sheep');
    expect(await t.call('GET', 'cp:s')).toBe('sheep');
  });

  it('does not overwrite without REPLACE, does with REPLACE', async () => {
    await t.call('SET', 'cp:s2', 'new');
    await t.call('SET', 'cp:d2', 'old');
    expect(await t.call('COPY', 'cp:s2', 'cp:d2')).toBe(0);
    expect(await t.call('GET', 'cp:d2')).toBe('old');
    expect(await t.call('COPY', 'cp:s2', 'cp:d2', 'REPLACE')).toBe(1);
    expect(await t.call('GET', 'cp:d2')).toBe('new');
  });

  it('copies collections deeply (independent copies)', async () => {
    await t.call('RPUSH', 'cp:l', 'a', 'b');
    expect(await t.call('COPY', 'cp:l', 'cp:l2')).toBe(1);
    await t.call('RPUSH', 'cp:l', 'c');
    expect(await t.call('LRANGE', 'cp:l2', 0, -1)).toEqual(['a', 'b']);
    await t.call('HSET', 'cp:h', 'f', '1');
    await t.call('COPY', 'cp:h', 'cp:h2');
    expect(await t.call('HGETALL', 'cp:h2')).toEqual(['f', '1']);
    await t.call('ZADD', 'cp:z', 1, 'm');
    await t.call('COPY', 'cp:z', 'cp:z2');
    expect(await t.call('ZRANGE', 'cp:z2', 0, -1, 'WITHSCORES')).toEqual(['m', '1']);
  });

  it('copies the TTL', async () => {
    await t.call('SET', 'cp:ttl', 'v', 'EX', 100);
    await t.call('COPY', 'cp:ttl', 'cp:ttl2');
    expect(await t.call('TTL', 'cp:ttl2')).toBeGreaterThan(95);
  });

  it('missing source returns 0', async () => {
    expect(await t.call('COPY', 'cp:missing', 'cp:x')).toBe(0);
    expect(await t.call('EXISTS', 'cp:x')).toBe(0);
  });

  it('DB option copies into another database', async () => {
    await t.call('SET', 'cp:db', 'dbval');
    expect(await t.call('COPY', 'cp:db', 'cp:db', 'DB', 2)).toBe(1);
    const c = t.client();
    await c.select(2);
    expect(await c.get('cp:db')).toBe('dbval');
    await c.set('cp:db2', 'x');
    await t.call('SET', 'cp:db2', 'y');
    expect(await t.call('COPY', 'cp:db2', 'cp:db2', 'DB', 2)).toBe(0);
    expect(await t.call('COPY', 'cp:db2', 'cp:db2', 'DB', 2, 'REPLACE')).toBe(1);
    expect(await c.get('cp:db2')).toBe('y');
  });

  it('errors', async () => {
    await t.call('SET', 'cp:e', 'v');
    expect(await err(t.call('COPY', 'cp:e', 'cp:e'))).toBe('ERR source and destination objects are the same');
    expect(await err(t.call('COPY', 'cp:e', 'cp:e2', 'DB', 99999))).toBe('ERR DB index is out of range');
    expect(await err(t.call('COPY', 'cp:e', 'cp:e2', 'DB', 'abc'))).toBe(NOT_INT);
    expect(await err(t.call('COPY', 'cp:e', 'cp:e2', 'FOO'))).toBe(SYNTAX);
    expect(await err(t.call('COPY', 'cp:e'))).toBe(arity('copy'));
  });
});

/* ------------------------------------------------------------------ */
/* KEYS / SCAN / RANDOMKEY                                             */
/* ------------------------------------------------------------------ */
describe('KEYS', () => {
  const sorted = async (pattern: string) => ((await t.call('KEYS', pattern)) as string[]).sort();

  it('glob patterns from the KEYS docs', async () => {
    await t.call('MSET', 'kp:hello', '1', 'kp:hallo', '1', 'kp:hxllo', '1', 'kp:hllo', '1', 'kp:heeeello', '1', 'kp:hbllo', '1');
    expect(await sorted('kp:h?llo')).toEqual(['kp:hallo', 'kp:hbllo', 'kp:hello', 'kp:hxllo']);
    expect(await sorted('kp:h*llo')).toEqual(['kp:hallo', 'kp:hbllo', 'kp:heeeello', 'kp:hello', 'kp:hllo', 'kp:hxllo']);
    expect(await sorted('kp:h[ae]llo')).toEqual(['kp:hallo', 'kp:hello']);
    expect(await sorted('kp:h[^e]llo')).toEqual(['kp:hallo', 'kp:hbllo', 'kp:hxllo']);
    expect(await sorted('kp:h[a-b]llo')).toEqual(['kp:hallo', 'kp:hbllo']);
    expect(await sorted('kp:*')).toHaveLength(6);
    expect(await sorted('kp:nothing*')).toEqual([]);
  });

  it('backslash escapes special characters', async () => {
    await t.call('MSET', 'ke:a*b', '1', 'ke:axb', '1', 'ke:a?b', '1', 'ke:[x]', '1', 'ke:x', '1');
    expect(await sorted('ke:a\\*b')).toEqual(['ke:a*b']);
    expect(await sorted('ke:a\\?b')).toEqual(['ke:a?b']);
    expect(await sorted('ke:a*b')).toEqual(['ke:a*b', 'ke:a?b', 'ke:axb']);
    expect(await sorted('ke:\\[x\\]')).toEqual(['ke:[x]']);
    expect(await sorted('ke:[x]')).toEqual(['ke:x']);
  });

  it('includes keys of all types and skips expired keys', async () => {
    await t.call('RPUSH', 'kt:l', 'a');
    await t.call('SET', 'kt:s', 'v');
    await t.call('SET', 'kt:gone', 'v', 'PX', 20);
    await sleep(60);
    expect(await sorted('kt:*')).toEqual(['kt:l', 'kt:s']);
  });

  it('arity error', async () => {
    expect(await err(t.call('KEYS'))).toBe(arity('keys'));
  });
});

describe('SCAN', () => {
  async function scanAll(...opts: Array<string | number>): Promise<string[]> {
    const seen: string[] = [];
    let cursor = '0';
    let rounds = 0;
    do {
      const [next, keys] = (await t.call('SCAN', cursor, ...opts)) as [string, string[]];
      expect(typeof next).toBe('string');
      seen.push(...keys);
      cursor = next;
      rounds++;
    } while (cursor !== '0' && rounds < 10000);
    return seen;
  }

  it('full iteration returns every key at least once', async () => {
    const args: string[] = [];
    for (let i = 0; i < 300; i++) args.push(`sc:${i}`, 'v');
    await t.call('MSET', ...args);
    const seen = new Set(await scanAll('MATCH', 'sc:*', 'COUNT', 7));
    expect(seen.size).toBe(300);
    for (let i = 0; i < 300; i++) expect(seen.has(`sc:${i}`)).toBe(true);
  });

  it('MATCH filters, COUNT is a hint', async () => {
    await t.call('MSET', 'scm:a1', 'v', 'scm:a2', 'v', 'scm:b1', 'v');
    const seen = new Set(await scanAll('MATCH', 'scm:a*', 'COUNT', 1000));
    expect([...seen].sort()).toEqual(['scm:a1', 'scm:a2']);
  });

  it('TYPE filters by type', async () => {
    await t.call('SET', 'sct:s', 'v');
    await t.call('RPUSH', 'sct:l', 'v');
    await t.call('HSET', 'sct:h', 'f', 'v');
    expect((await scanAll('MATCH', 'sct:*', 'TYPE', 'list')).sort()).toEqual(['sct:l']);
    expect((await scanAll('MATCH', 'sct:*', 'TYPE', 'string')).sort()).toEqual(['sct:s']);
    expect((await scanAll('MATCH', 'sct:*', 'TYPE', 'hash')).sort()).toEqual(['sct:h']);
    expect(await scanAll('MATCH', 'sct:*', 'TYPE', 'zset')).toEqual([]);
  });

  it('reply shape: cursor is a bulk string', async () => {
    const r = await t.raw();
    const out = await r.send('SCAN', '0', 'MATCH', 'definitely-no-such-key-*', 'COUNT', '100000');
    expect(out.startsWith('*2\r\n$1\r\n0\r\n*')).toBe(true);
  });

  it('errors', async () => {
    expect(await err(t.call('SCAN', 'abc'))).toBe('ERR invalid cursor');
    expect(await err(t.call('SCAN', '0', 'COUNT', 0))).toBe(SYNTAX);
    expect(await err(t.call('SCAN', '0', 'COUNT', 'x'))).toBe(NOT_INT);
    expect(await err(t.call('SCAN', '0', 'FOO', 'bar'))).toBe(SYNTAX);
    expect(await err(t.call('SCAN', '0', 'MATCH'))).toBe(SYNTAX);
    expect(await err(t.call('SCAN'))).toBe(arity('scan'));
  });
});

describe('RANDOMKEY', () => {
  it('returns nil on an empty db and a key otherwise', async () => {
    const c = t.client();
    await c.select(14);
    await c.flushdb();
    expect(await c.randomkey()).toBeNull();
    await c.set('rk:only', 'v');
    expect(await c.randomkey()).toBe('rk:only');
    await c.set('rk:two', 'v');
    expect(['rk:only', 'rk:two']).toContain(await c.randomkey());
  });

  it('RESP3 null on empty db', async () => {
    const r = await resp3();
    await r.send('SELECT', '13');
    await r.send('FLUSHDB');
    expect(await r.send('RANDOMKEY')).toBe('_\r\n');
  });

  it('arity error', async () => {
    expect(await err(t.call('RANDOMKEY', 'x'))).toBe(arity('randomkey'));
  });
});

/* ------------------------------------------------------------------ */
/* OBJECT                                                              */
/* ------------------------------------------------------------------ */
describe('OBJECT', () => {
  const enc = (k: string) => t.call('OBJECT', 'ENCODING', k);

  it('ENCODING int / embstr / raw', async () => {
    await t.call('SET', 'ob:i', '12345');
    expect(await enc('ob:i')).toBe('int');
    await t.call('SET', 'ob:neg', '-42');
    expect(await enc('ob:neg')).toBe('int');
    await t.call('SET', 'ob:max', '9223372036854775807');
    expect(await enc('ob:max')).toBe('int');
    await t.call('SET', 'ob:big', '92233720368547758070');
    expect(await enc('ob:big')).toBe('embstr');
    await t.call('SET', 'ob:lead0', '0123');
    expect(await enc('ob:lead0')).toBe('embstr');
    await t.call('SET', 'ob:plus', '+1');
    expect(await enc('ob:plus')).toBe('embstr');
    await t.call('SET', 'ob:float', '1.5');
    expect(await enc('ob:float')).toBe('embstr');
    await t.call('SET', 'ob:44', 'x'.repeat(44));
    expect(await enc('ob:44')).toBe('embstr');
    await t.call('SET', 'ob:45', 'x'.repeat(45));
    expect(await enc('ob:45')).toBe('raw');
    await t.call('SET', 'ob:empty', '');
    expect(await enc('ob:empty')).toBe('embstr');
  });

  it('ENCODING becomes raw after APPEND / SETRANGE / SETBIT', async () => {
    await t.call('SET', 'ob:ap', 'ab');
    await t.call('APPEND', 'ob:ap', 'c');
    expect(await enc('ob:ap')).toBe('raw');
    await t.call('SET', 'ob:apint', '12');
    await t.call('APPEND', 'ob:apint', '3');
    expect(await enc('ob:apint')).toBe('raw');
    await t.call('SET', 'ob:sr', 'hello');
    await t.call('SETRANGE', 'ob:sr', 0, 'j');
    expect(await enc('ob:sr')).toBe('raw');
    await t.call('SET', 'ob:sb', 'hello');
    await t.call('SETBIT', 'ob:sb', 1, 1);
    expect(await enc('ob:sb')).toBe('raw');
    await t.call('SETBIT', 'ob:sbnew', 1, 1);
    expect(await enc('ob:sbnew')).toBe('raw');
    await t.call('APPEND', 'ob:apnew', 'x');
    expect(await enc('ob:apnew')).toBe('raw');
  });

  it('ENCODING after INCR is int', async () => {
    await t.call('SET', 'ob:inc', '10');
    await t.call('INCR', 'ob:inc');
    expect(await enc('ob:inc')).toBe('int');
    await t.call('INCR', 'ob:incnew');
    expect(await enc('ob:incnew')).toBe('int');
  });

  it('ENCODING of other types', async () => {
    await t.call('RPUSH', 'ob:l', 'a');
    expect(await enc('ob:l')).toBe('listpack');
    await t.call('SADD', 'ob:si', '1', '2');
    expect(await enc('ob:si')).toBe('intset');
    await t.call('SADD', 'ob:ss', 'a');
    expect(await enc('ob:ss')).toBe('listpack');
    await t.call('HSET', 'ob:h', 'f', 'v');
    expect(await enc('ob:h')).toBe('listpack');
    await t.call('ZADD', 'ob:z', 1, 'a');
    expect(await enc('ob:z')).toBe('listpack');
    await t.call('XADD', 'ob:x', '*', 'f', 'v');
    expect(await enc('ob:x')).toBe('stream');
  });

  it('missing key returns nil (RESP3 null)', async () => {
    expect(await enc('ob:missing')).toBeNull();
    expect(await t.call('OBJECT', 'REFCOUNT', 'ob:missing')).toBeNull();
    expect(await t.call('OBJECT', 'IDLETIME', 'ob:missing')).toBeNull();
    const r = await resp3();
    expect(await r.send('OBJECT', 'ENCODING', 'ob:missing')).toBe('_\r\n');
    await r.send('SET', 'ob:r3', 'hello');
    expect(await r.send('OBJECT', 'ENCODING', 'ob:r3')).toBe('$6\r\nembstr\r\n');
  });

  it('REFCOUNT: 1 for normal values, INT_MAX for shared integers', async () => {
    await t.call('SET', 'ob:rc', 'hello');
    expect(await t.call('OBJECT', 'REFCOUNT', 'ob:rc')).toBe(1);
    // values 0..9999 use the shared integer pool under the default noeviction policy
    await t.call('SET', 'ob:rcint', '100');
    expect(await t.call('OBJECT', 'REFCOUNT', 'ob:rcint')).toBe(2147483647);
  });

  it('IDLETIME is ~0 right after access', async () => {
    await t.call('SET', 'ob:idle', 'v');
    const idle = (await t.call('OBJECT', 'IDLETIME', 'ob:idle')) as number;
    expect(idle).toBeGreaterThanOrEqual(0);
    expect(idle).toBeLessThanOrEqual(1);
  });

  it('FREQ errors when no LFU policy is selected', async () => {
    await t.call('SET', 'ob:freq', 'v');
    const msg = await err(t.call('OBJECT', 'FREQ', 'ob:freq'));
    expect(msg.startsWith('ERR An LFU maxmemory policy is not selected, access frequency not tracked.')).toBe(true);
  });

  it('HELP is an array of status lines', async () => {
    const help = (await t.call('OBJECT', 'HELP')) as string[];
    expect(Array.isArray(help)).toBe(true);
    expect(help[0]).toBe('OBJECT <subcommand> [<arg> [value] [opt] ...]. Subcommands are:');
    expect(help.some((l) => l.startsWith('ENCODING'))).toBe(true);
    expect(help.some((l) => l.startsWith('FREQ'))).toBe(true);
    expect(help.some((l) => l.startsWith('IDLETIME'))).toBe(true);
    expect(help.some((l) => l.startsWith('REFCOUNT'))).toBe(true);
    const r = await t.raw();
    const out = await r.send('OBJECT', 'HELP');
    expect(out.startsWith('*')).toBe(true);
    expect(out.split('\r\n')[1]).toBe('+OBJECT <subcommand> [<arg> [value] [opt] ...]. Subcommands are:');
  });

  it('errors', async () => {
    expect(await err(t.call('OBJECT', 'FOO', 'k'))).toBe("ERR unknown subcommand 'FOO'. Try OBJECT HELP.");
    expect(await err(t.call('OBJECT', 'ENCODING'))).toBe(arity('object|encoding'));
    expect(await err(t.call('OBJECT'))).toBe(arity('object'));
  });
});

/* ------------------------------------------------------------------ */
/* EXPIRE family / TTL family / PERSIST                                */
/* ------------------------------------------------------------------ */
describe('EXPIRE / PEXPIRE / EXPIREAT / PEXPIREAT', () => {
  it('EXPIRE sets a TTL (docs example)', async () => {
    await t.call('SET', 'exp:a', 'Hello');
    expect(await t.call('EXPIRE', 'exp:a', 10)).toBe(1);
    expect(await t.call('TTL', 'exp:a')).toBe(10);
    await t.call('SET', 'exp:a', 'Hello World');
    expect(await t.call('TTL', 'exp:a')).toBe(-1);
    expect(await t.call('EXPIRE', 'exp:missing', 10)).toBe(0);
  });

  it('NX / XX / GT / LT (docs example)', async () => {
    await t.call('SET', 'exp:o', 'v');
    expect(await t.call('EXPIRE', 'exp:o', 10, 'XX')).toBe(0);
    expect(await t.call('TTL', 'exp:o')).toBe(-1);
    expect(await t.call('EXPIRE', 'exp:o', 10, 'NX')).toBe(1);
    expect(await t.call('TTL', 'exp:o')).toBe(10);
    expect(await t.call('EXPIRE', 'exp:o', 20, 'NX')).toBe(0);
    expect(await t.call('EXPIRE', 'exp:o', 20, 'XX')).toBe(1);
    expect(await t.call('EXPIRE', 'exp:o', 5, 'GT')).toBe(0);
    expect(await t.call('EXPIRE', 'exp:o', 30, 'GT')).toBe(1);
    expect(await t.call('EXPIRE', 'exp:o', 40, 'LT')).toBe(0);
    expect(await t.call('EXPIRE', 'exp:o', 15, 'LT')).toBe(1);
    expect(await t.call('TTL', 'exp:o')).toBe(15);
  });

  it('GT / LT on a key without TTL (treated as infinite)', async () => {
    await t.call('SET', 'exp:inf', 'v');
    expect(await t.call('EXPIRE', 'exp:inf', 100, 'GT')).toBe(0);
    expect(await t.call('TTL', 'exp:inf')).toBe(-1);
    expect(await t.call('EXPIRE', 'exp:inf', 100, 'LT')).toBe(1);
    expect(await t.call('TTL', 'exp:inf')).toBe(100);
  });

  it('options are case-insensitive and combinable (NX GT is not allowed, XX GT is)', async () => {
    await t.call('SET', 'exp:c', 'v', 'EX', 10);
    expect(await t.call('EXPIRE', 'exp:c', 50, 'xx', 'gt')).toBe(1);
    expect(await t.call('TTL', 'exp:c')).toBe(50);
  });

  it('zero / negative / past times delete the key', async () => {
    await t.call('SET', 'exp:z', 'v');
    expect(await t.call('EXPIRE', 'exp:z', 0)).toBe(1);
    expect(await t.call('EXISTS', 'exp:z')).toBe(0);
    await t.call('SET', 'exp:n', 'v');
    expect(await t.call('PEXPIRE', 'exp:n', -100)).toBe(1);
    expect(await t.call('EXISTS', 'exp:n')).toBe(0);
    await t.call('SET', 'exp:p', 'v');
    expect(await t.call('EXPIREAT', 'exp:p', 1000)).toBe(1);
    expect(await t.call('EXISTS', 'exp:p')).toBe(0);
    await t.call('SET', 'exp:pp', 'v');
    expect(await t.call('PEXPIREAT', 'exp:pp', 1000)).toBe(1);
    expect(await t.call('GET', 'exp:pp')).toBeNull();
  });

  it('PEXPIRE / EXPIREAT / PEXPIREAT set the expected deadlines', async () => {
    await t.call('SET', 'exp:pe', 'v');
    expect(await t.call('PEXPIRE', 'exp:pe', 100000)).toBe(1);
    const pttl = (await t.call('PTTL', 'exp:pe')) as number;
    expect(pttl).toBeGreaterThan(99000);
    expect(pttl).toBeLessThanOrEqual(100000);
    const at = Math.floor(Date.now() / 1000) + 1000;
    await t.call('SET', 'exp:at', 'v');
    expect(await t.call('EXPIREAT', 'exp:at', at)).toBe(1);
    expect(await t.call('EXPIRETIME', 'exp:at')).toBe(at);
    expect(await t.call('PEXPIRETIME', 'exp:at')).toBe(at * 1000);
    const pat = Date.now() + 500000;
    await t.call('SET', 'exp:pat', 'v');
    expect(await t.call('PEXPIREAT', 'exp:pat', pat)).toBe(1);
    expect(await t.call('PEXPIRETIME', 'exp:pat')).toBe(pat);
    expect(await t.call('EXPIRETIME', 'exp:pat')).toBe(Math.floor((pat + 500) / 1000));
    expect(await t.call('EXPIREAT', 'exp:missing', at)).toBe(0);
    expect(await t.call('PEXPIREAT', 'exp:missing', pat)).toBe(0);
  });

  it('key actually expires', async () => {
    await t.call('SET', 'exp:real', 'v');
    await t.call('PEXPIRE', 'exp:real', 40);
    await sleep(100);
    expect(await t.call('GET', 'exp:real')).toBeNull();
    expect(await t.call('TTL', 'exp:real')).toBe(-2);
  });

  it('errors', async () => {
    await t.call('SET', 'exp:e', 'v');
    expect(await err(t.call('EXPIRE', 'exp:e', 'abc'))).toBe(NOT_INT);
    expect(await err(t.call('EXPIRE', 'exp:e', '1.5'))).toBe(NOT_INT);
    expect(await err(t.call('EXPIRE', 'exp:e', 10, 'NX', 'XX'))).toBe('ERR NX and XX, GT or LT options at the same time are not compatible');
    expect(await err(t.call('EXPIRE', 'exp:e', 10, 'NX', 'GT'))).toBe('ERR NX and XX, GT or LT options at the same time are not compatible');
    expect(await err(t.call('EXPIRE', 'exp:e', 10, 'GT', 'LT'))).toBe('ERR GT and LT options at the same time are not compatible');
    expect(await err(t.call('EXPIRE', 'exp:e', 10, 'FOO'))).toBe('ERR Unsupported option FOO');
    expect(await err(t.call('EXPIRE', 'exp:e', '9223372036854775807'))).toBe("ERR invalid expire time in 'expire' command");
    expect(await err(t.call('PEXPIRE', 'exp:e', '9223372036854775807'))).toBe("ERR invalid expire time in 'pexpire' command");
    expect(await err(t.call('EXPIREAT', 'exp:e', '9223372036854775807'))).toBe("ERR invalid expire time in 'expireat' command");
    expect(await err(t.call('EXPIRE', 'exp:e'))).toBe(arity('expire'));
    expect(await err(t.call('PEXPIRE', 'exp:e'))).toBe(arity('pexpire'));
    expect(await err(t.call('EXPIREAT', 'exp:e'))).toBe(arity('expireat'));
    expect(await err(t.call('PEXPIREAT', 'exp:e'))).toBe(arity('pexpireat'));
    expect(await t.call('EXISTS', 'exp:e')).toBe(1);
  });
});

describe('TTL / PTTL / EXPIRETIME / PEXPIRETIME / PERSIST', () => {
  it('-2 for missing, -1 for no TTL', async () => {
    await t.call('SET', 'ttl:p', 'v');
    for (const cmd of ['TTL', 'PTTL', 'EXPIRETIME', 'PEXPIRETIME']) {
      expect(await t.call(cmd, 'ttl:missing')).toBe(-2);
      expect(await t.call(cmd, 'ttl:p')).toBe(-1);
    }
  });

  it('TTL rounds to the nearest second', async () => {
    await t.call('SET', 'ttl:r', 'v', 'PX', 10400);
    expect(await t.call('TTL', 'ttl:r')).toBe(10);
    await t.call('SET', 'ttl:r2', 'v', 'PX', 10900);
    expect(await t.call('TTL', 'ttl:r2')).toBe(11);
  });

  it('EXPIRETIME docs example', async () => {
    await t.call('SET', 'ttl:et', 'Hello');
    expect(await t.call('EXPIREAT', 'ttl:et', 33177117420)).toBe(1);
    expect(await t.call('EXPIRETIME', 'ttl:et')).toBe(33177117420);
    expect(await t.call('PEXPIRETIME', 'ttl:et')).toBe(33177117420000);
  });

  it('PERSIST removes the TTL', async () => {
    await t.call('SET', 'ttl:ps', 'v', 'EX', 10);
    expect(await t.call('PERSIST', 'ttl:ps')).toBe(1);
    expect(await t.call('TTL', 'ttl:ps')).toBe(-1);
    expect(await t.call('PERSIST', 'ttl:ps')).toBe(0);
    expect(await t.call('PERSIST', 'ttl:none')).toBe(0);
  });

  it('works on non-string types', async () => {
    await t.call('RPUSH', 'ttl:l', 'a');
    expect(await t.call('EXPIRE', 'ttl:l', 50)).toBe(1);
    expect(await t.call('TTL', 'ttl:l')).toBe(50);
  });

  it('arity errors', async () => {
    expect(await err(t.call('TTL'))).toBe(arity('ttl'));
    expect(await err(t.call('PTTL', 'a', 'b'))).toBe(arity('pttl'));
    expect(await err(t.call('EXPIRETIME'))).toBe(arity('expiretime'));
    expect(await err(t.call('PEXPIRETIME'))).toBe(arity('pexpiretime'));
    expect(await err(t.call('PERSIST'))).toBe(arity('persist'));
  });
});
