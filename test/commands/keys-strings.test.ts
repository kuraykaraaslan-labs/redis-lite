import { describe, expect, it } from 'vitest';

import { sleep, useServer } from '../helpers';

/**
 * Generic key commands, strings and bitmaps.
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
const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';
const SYNTAX = 'ERR syntax error';
const NOT_INT = 'ERR value is not an integer or out of range';
const NOT_FLOAT = 'ERR value is not a valid float';

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

describe('MOVE', () => {
  it('moves a key to another db', async () => {
    await t.call('SET', 'mv:a', 'v', 'EX', 100);
    expect(await t.call('MOVE', 'mv:a', 1)).toBe(1);
    expect(await t.call('EXISTS', 'mv:a')).toBe(0);
    const c = t.client();
    await c.select(1);
    expect(await c.get('mv:a')).toBe('v');
    expect(await c.ttl('mv:a')).toBeGreaterThan(95);
  });

  it('returns 0 when the destination exists or the source is missing', async () => {
    const c = t.client();
    await c.select(1);
    await c.set('mv:b', 'there');
    await t.call('SET', 'mv:b', 'here');
    expect(await t.call('MOVE', 'mv:b', 1)).toBe(0);
    expect(await t.call('GET', 'mv:b')).toBe('here');
    expect(await c.get('mv:b')).toBe('there');
    expect(await t.call('MOVE', 'mv:missing', 1)).toBe(0);
  });

  it('errors', async () => {
    await t.call('SET', 'mv:e', 'v');
    expect(await err(t.call('MOVE', 'mv:e', 0))).toBe('ERR source and destination objects are the same');
    expect(await err(t.call('MOVE', 'mv:e', 99999))).toBe('ERR DB index is out of range');
    expect(await err(t.call('MOVE', 'mv:e', 'abc'))).toBe(NOT_INT);
    expect(await err(t.call('MOVE', 'mv:e'))).toBe(arity('move'));
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
/* SORT / SORT_RO                                                      */
/* ------------------------------------------------------------------ */

describe('SORT / SORT_RO', () => {
  it('numeric sort by default, ASC/DESC, LIMIT', async () => {
    await t.call('RPUSH', 'so:l', '3', '1', '10', '-2', '1.5');
    expect(await t.call('SORT', 'so:l')).toEqual(['-2', '1', '1.5', '3', '10']);
    expect(await t.call('SORT', 'so:l', 'ASC')).toEqual(['-2', '1', '1.5', '3', '10']);
    expect(await t.call('SORT', 'so:l', 'DESC')).toEqual(['10', '3', '1.5', '1', '-2']);
    expect(await t.call('SORT', 'so:l', 'LIMIT', 1, 2)).toEqual(['1', '1.5']);
    expect(await t.call('SORT', 'so:l', 'DESC', 'LIMIT', 0, 2)).toEqual(['10', '3']);
    expect(await t.call('SORT', 'so:l', 'LIMIT', 10, 5)).toEqual([]);
  });

  it('ALPHA sorts lexicographically', async () => {
    await t.call('RPUSH', 'so:a', 'banana', 'apple', 'cherry', '10', '9');
    expect(await t.call('SORT', 'so:a', 'ALPHA')).toEqual(['10', '9', 'apple', 'banana', 'cherry']);
    expect(await t.call('SORT', 'so:a', 'ALPHA', 'DESC')).toEqual(['cherry', 'banana', 'apple', '9', '10']);
  });

  it('non-numeric element without ALPHA is an error', async () => {
    await t.call('RPUSH', 'so:bad', '1', 'abc');
    expect(await err(t.call('SORT', 'so:bad'))).toBe("ERR One or more scores can't be converted into double");
  });

  it('sorts sets and sorted sets', async () => {
    await t.call('SADD', 'so:set', '5', '2', '8');
    expect(await t.call('SORT', 'so:set')).toEqual(['2', '5', '8']);
    await t.call('ZADD', 'so:z', 1, 'c', 2, 'a', 3, 'b');
    expect(await t.call('SORT', 'so:z', 'ALPHA')).toEqual(['a', 'b', 'c']);
  });

  it('BY external key pattern and GET patterns', async () => {
    await t.call('RPUSH', 'so:ids', '1', '2', '3');
    await t.call('MSET', 'so:w_1', '30', 'so:w_2', '10', 'so:w_3', '20', 'so:o_1', 'one', 'so:o_2', 'two');
    expect(await t.call('SORT', 'so:ids', 'BY', 'so:w_*')).toEqual(['2', '3', '1']);
    expect(await t.call('SORT', 'so:ids', 'BY', 'so:w_*', 'GET', 'so:o_*', 'GET', '#')).toEqual(['two', '2', null, '3', 'one', '1']);
    expect(await t.call('SORT', 'so:ids', 'BY', 'so:w_*', 'DESC', 'GET', '#')).toEqual(['1', '3', '2']);
  });

  it('BY and GET with hash fields (->)', async () => {
    await t.call('RPUSH', 'so:hids', '1', '2', '3');
    await t.call('HSET', 'so:obj_1', 'w', '3', 'name', 'n1');
    await t.call('HSET', 'so:obj_2', 'w', '1', 'name', 'n2');
    await t.call('HSET', 'so:obj_3', 'w', '2', 'name', 'n3');
    expect(await t.call('SORT', 'so:hids', 'BY', 'so:obj_*->w', 'GET', 'so:obj_*->name')).toEqual(['n2', 'n3', 'n1']);
    expect(await t.call('SORT', 'so:hids', 'BY', 'so:obj_*->w', 'GET', 'so:obj_*->missing')).toEqual([null, null, null]);
  });

  it('BY with missing weights ties sort by element', async () => {
    await t.call('RPUSH', 'so:ties', 'c', 'a', 'b');
    expect(await t.call('SORT', 'so:ties', 'BY', 'so:noweight_*')).toEqual(['a', 'b', 'c']);
  });

  it('BY nosort skips sorting (list keeps order)', async () => {
    await t.call('RPUSH', 'so:ns', '3', '1', '2');
    expect(await t.call('SORT', 'so:ns', 'BY', 'nosort')).toEqual(['3', '1', '2']);
    expect(await t.call('SORT', 'so:ns', 'BY', 'nosort', 'GET', '#', 'LIMIT', 1, 1)).toEqual(['1']);
    // zset with nosort keeps zset (score) order
    await t.call('ZADD', 'so:zns', 1, 'z', 2, 'y', 3, 'x');
    expect(await t.call('SORT', 'so:zns', 'BY', 'nosort')).toEqual(['z', 'y', 'x']);
    expect(await t.call('SORT', 'so:zns', 'BY', 'nosort', 'DESC')).toEqual(['x', 'y', 'z']);
  });

  it('STORE writes a list and returns its length', async () => {
    await t.call('RPUSH', 'so:st', '3', '1', '2');
    expect(await t.call('SORT', 'so:st', 'STORE', 'so:st:out')).toBe(3);
    expect(await t.call('TYPE', 'so:st:out')).toBe('list');
    expect(await t.call('LRANGE', 'so:st:out', 0, -1)).toEqual(['1', '2', '3']);
    await t.call('SET', 'so:st:out2', 'old');
    expect(await t.call('SORT', 'so:missing', 'STORE', 'so:st:out2')).toBe(0);
    expect(await t.call('EXISTS', 'so:st:out2')).toBe(0);
  });

  it('missing key sorts to an empty array', async () => {
    expect(await t.call('SORT', 'so:nokey')).toEqual([]);
    expect(await t.call('SORT_RO', 'so:nokey')).toEqual([]);
  });

  it('SORT_RO supports the read options but not STORE', async () => {
    await t.call('RPUSH', 'so:ro', '2', '1');
    expect(await t.call('SORT_RO', 'so:ro')).toEqual(['1', '2']);
    expect(await t.call('SORT_RO', 'so:ro', 'DESC', 'LIMIT', 0, 1)).toEqual(['2']);
    expect(await err(t.call('SORT_RO', 'so:ro', 'STORE', 'x'))).toBe(SYNTAX);
  });

  it('errors', async () => {
    await t.call('SET', 'so:str', 'v');
    await t.call('HSET', 'so:hash', 'f', 'v');
    await t.call('RPUSH', 'so:e', '1');
    expect(await err(t.call('SORT', 'so:str'))).toBe(WRONGTYPE);
    expect(await err(t.call('SORT', 'so:hash'))).toBe(WRONGTYPE);
    expect(await err(t.call('SORT', 'so:e', 'LIMIT', 0))).toBe(SYNTAX);
    expect(await err(t.call('SORT', 'so:e', 'LIMIT', 'a', 1))).toBe(NOT_INT);
    expect(await err(t.call('SORT', 'so:e', 'FOO'))).toBe(SYNTAX);
    expect(await err(t.call('SORT'))).toBe(arity('sort'));
    expect(await err(t.call('SORT_RO'))).toBe(arity('sort_ro'));
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

/* ------------------------------------------------------------------ */
/* GET / SET and variants                                              */
/* ------------------------------------------------------------------ */

describe('GET / SET', () => {
  it('basic set and get', async () => {
    expect(await t.call('GET', 'st:nonexisting')).toBeNull();
    expect(await t.call('SET', 'st:k', 'Hello')).toBe('OK');
    expect(await t.call('GET', 'st:k')).toBe('Hello');
    await t.call('RPUSH', 'st:list', 'a');
    expect(await err(t.call('GET', 'st:list'))).toBe(WRONGTYPE);
  });

  it('SET overwrites any type and clears the TTL', async () => {
    await t.call('RPUSH', 'st:ow', 'a');
    expect(await t.call('SET', 'st:ow', 'v')).toBe('OK');
    expect(await t.call('TYPE', 'st:ow')).toBe('string');
    await t.call('SET', 'st:ttl', 'v', 'EX', 100);
    await t.call('SET', 'st:ttl', 'v2');
    expect(await t.call('TTL', 'st:ttl')).toBe(-1);
  });

  it('EX / PX / EXAT / PXAT', async () => {
    await t.call('SET', 'st:ex', 'v', 'EX', 100);
    expect(await t.call('TTL', 'st:ex')).toBe(100);
    await t.call('SET', 'st:px', 'v', 'PX', 100000);
    expect(await t.call('PTTL', 'st:px')).toBeGreaterThan(99000);
    const at = Math.floor(Date.now() / 1000) + 200;
    await t.call('SET', 'st:exat', 'v', 'EXAT', at);
    expect(await t.call('EXPIRETIME', 'st:exat')).toBe(at);
    const pat = Date.now() + 300000;
    await t.call('SET', 'st:pxat', 'v', 'PXAT', pat);
    expect(await t.call('PEXPIRETIME', 'st:pxat')).toBe(pat);
  });

  it('EXAT / PXAT in the past: OK but the key does not survive', async () => {
    await t.call('SET', 'st:past', 'old');
    expect(await t.call('SET', 'st:past', 'v', 'EXAT', 1000)).toBe('OK');
    expect(await t.call('GET', 'st:past')).toBeNull();
    expect(await t.call('SET', 'st:past2', 'v', 'PXAT', 1000)).toBe('OK');
    expect(await t.call('EXISTS', 'st:past2')).toBe(0);
  });

  it('NX / XX', async () => {
    expect(await t.call('SET', 'st:nx', 'a', 'NX')).toBe('OK');
    expect(await t.call('SET', 'st:nx', 'b', 'NX')).toBeNull();
    expect(await t.call('GET', 'st:nx')).toBe('a');
    expect(await t.call('SET', 'st:xx', 'a', 'XX')).toBeNull();
    expect(await t.call('EXISTS', 'st:xx')).toBe(0);
    expect(await t.call('SET', 'st:nx', 'c', 'XX')).toBe('OK');
    expect(await t.call('GET', 'st:nx')).toBe('c');
  });

  it('GET option returns the old value', async () => {
    expect(await t.call('SET', 'st:g', 'v1', 'GET')).toBeNull();
    expect(await t.call('SET', 'st:g', 'v2', 'GET')).toBe('v1');
    expect(await t.call('GET', 'st:g')).toBe('v2');
    expect(await t.call('SET', 'st:g', 'v3', 'NX', 'GET')).toBe('v2');
    expect(await t.call('GET', 'st:g')).toBe('v2');
    expect(await t.call('SET', 'st:gxx', 'v', 'XX', 'GET')).toBeNull();
    expect(await t.call('EXISTS', 'st:gxx')).toBe(0);
    await t.call('RPUSH', 'st:glist', 'a');
    expect(await err(t.call('SET', 'st:glist', 'v', 'GET'))).toBe(WRONGTYPE);
    expect(await t.call('TYPE', 'st:glist')).toBe('list');
  });

  it('KEEPTTL keeps the TTL', async () => {
    await t.call('SET', 'st:kt', 'v', 'EX', 100);
    expect(await t.call('SET', 'st:kt', 'v2', 'KEEPTTL')).toBe('OK');
    expect(await t.call('GET', 'st:kt')).toBe('v2');
    expect(await t.call('TTL', 'st:kt')).toBeGreaterThan(95);
    expect(await t.call('SET', 'st:kt', 'v3', 'KEEPTTL', 'GET')).toBe('v2');
  });

  it('options are case-insensitive', async () => {
    expect(await t.call('SET', 'st:ci', 'v', 'ex', 50, 'nx')).toBe('OK');
    expect(await t.call('TTL', 'st:ci')).toBe(50);
  });

  it('invalid combinations are syntax errors', async () => {
    expect(await err(t.call('SET', 'st:c', 'v', 'NX', 'XX'))).toBe(SYNTAX);
    expect(await err(t.call('SET', 'st:c', 'v', 'EX', 10, 'PX', 100))).toBe(SYNTAX);
    expect(await err(t.call('SET', 'st:c', 'v', 'EX', 10, 'KEEPTTL'))).toBe(SYNTAX);
    expect(await err(t.call('SET', 'st:c', 'v', 'KEEPTTL', 'PX', 10))).toBe(SYNTAX);
    expect(await err(t.call('SET', 'st:c', 'v', 'EXAT', 10, 'PXAT', 10))).toBe(SYNTAX);
    expect(await err(t.call('SET', 'st:c', 'v', 'EX'))).toBe(SYNTAX);
    expect(await err(t.call('SET', 'st:c', 'v', 'FOO'))).toBe(SYNTAX);
    expect(await t.call('EXISTS', 'st:c')).toBe(0);
  });

  it('invalid expire times', async () => {
    expect(await err(t.call('SET', 'st:i', 'v', 'EX', 0))).toBe("ERR invalid expire time in 'set' command");
    expect(await err(t.call('SET', 'st:i', 'v', 'EX', -1))).toBe("ERR invalid expire time in 'set' command");
    expect(await err(t.call('SET', 'st:i', 'v', 'PX', 0))).toBe("ERR invalid expire time in 'set' command");
    expect(await err(t.call('SET', 'st:i', 'v', 'EXAT', 0))).toBe("ERR invalid expire time in 'set' command");
    expect(await err(t.call('SET', 'st:i', 'v', 'PXAT', -5))).toBe("ERR invalid expire time in 'set' command");
    expect(await err(t.call('SET', 'st:i', 'v', 'EX', '9223372036854775807'))).toBe("ERR invalid expire time in 'set' command");
    expect(await err(t.call('SET', 'st:i', 'v', 'PX', '9223372036854775807'))).toBe("ERR invalid expire time in 'set' command");
    expect(await err(t.call('SET', 'st:i', 'v', 'EX', 'abc'))).toBe(NOT_INT);
    expect(await err(t.call('SET', 'st:i', 'v', 'EX', '1.5'))).toBe(NOT_INT);
    expect(await t.call('EXISTS', 'st:i')).toBe(0);
  });

  it('arity errors', async () => {
    expect(await err(t.call('GET'))).toBe(arity('get'));
    expect(await err(t.call('GET', 'a', 'b'))).toBe(arity('get'));
    expect(await err(t.call('SET', 'a'))).toBe(arity('set'));
    const r = await t.raw();
    expect(await r.send('GET')).toBe("-ERR wrong number of arguments for 'get' command\r\n");
  });

  it('RESP3: nil replies are null, values bulk strings', async () => {
    const r = await resp3();
    expect(await r.send('GET', 'st:r3missing')).toBe('_\r\n');
    expect(await r.send('SET', 'st:r3', 'v', 'GET')).toBe('_\r\n');
    expect(await r.send('SET', 'st:r3', 'w', 'NX')).toBe('_\r\n');
    expect(await r.send('SET', 'st:r3', 'w', 'GET')).toBe('$1\r\nv\r\n');
    expect(await r.send('SET', 'st:r3', 'x')).toBe('+OK\r\n');
    const r2 = await t.raw();
    expect(await r2.send('SET', 'st:r3', 'w', 'NX')).toBe('$-1\r\n');
  });
});

describe('SETEX / PSETEX / SETNX', () => {
  it('SETEX', async () => {
    expect(await t.call('SETEX', 'sx:a', 10, 'Hello')).toBe('OK');
    expect(await t.call('TTL', 'sx:a')).toBe(10);
    expect(await t.call('GET', 'sx:a')).toBe('Hello');
    expect(await err(t.call('SETEX', 'sx:a', 0, 'v'))).toBe("ERR invalid expire time in 'setex' command");
    expect(await err(t.call('SETEX', 'sx:a', -10, 'v'))).toBe("ERR invalid expire time in 'setex' command");
    expect(await err(t.call('SETEX', 'sx:a', 'x', 'v'))).toBe(NOT_INT);
    expect(await err(t.call('SETEX', 'sx:a', 10))).toBe(arity('setex'));
  });

  it('PSETEX', async () => {
    expect(await t.call('PSETEX', 'sx:p', 1000, 'Hello')).toBe('OK');
    const pttl = (await t.call('PTTL', 'sx:p')) as number;
    expect(pttl).toBeGreaterThan(900);
    expect(pttl).toBeLessThanOrEqual(1000);
    expect(await err(t.call('PSETEX', 'sx:p', 0, 'v'))).toBe("ERR invalid expire time in 'psetex' command");
    expect(await err(t.call('PSETEX', 'sx:p', 'x', 'v'))).toBe(NOT_INT);
    expect(await err(t.call('PSETEX', 'sx:p'))).toBe(arity('psetex'));
  });

  it('SETNX', async () => {
    expect(await t.call('SETNX', 'sx:n', 'Hello')).toBe(1);
    expect(await t.call('SETNX', 'sx:n', 'World')).toBe(0);
    expect(await t.call('GET', 'sx:n')).toBe('Hello');
    await t.call('RPUSH', 'sx:nl', 'a');
    expect(await t.call('SETNX', 'sx:nl', 'v')).toBe(0);
    expect(await err(t.call('SETNX', 'sx:n'))).toBe(arity('setnx'));
  });
});

describe('GETSET / GETDEL / GETEX', () => {
  it('GETSET returns the old value and clears TTL', async () => {
    expect(await t.call('GETSET', 'gs:a', 'v1')).toBeNull();
    await t.call('EXPIRE', 'gs:a', 100);
    expect(await t.call('GETSET', 'gs:a', 'v2')).toBe('v1');
    expect(await t.call('GET', 'gs:a')).toBe('v2');
    expect(await t.call('TTL', 'gs:a')).toBe(-1);
    // docs example
    await t.call('INCR', 'gs:counter');
    expect(await t.call('GETSET', 'gs:counter', '0')).toBe('1');
    expect(await t.call('GET', 'gs:counter')).toBe('0');
    await t.call('RPUSH', 'gs:l', 'x');
    expect(await err(t.call('GETSET', 'gs:l', 'v'))).toBe(WRONGTYPE);
    expect(await err(t.call('GETSET', 'gs:l'))).toBe(arity('getset'));
  });

  it('GETDEL', async () => {
    await t.call('SET', 'gd:a', 'Hello');
    expect(await t.call('GETDEL', 'gd:a')).toBe('Hello');
    expect(await t.call('GET', 'gd:a')).toBeNull();
    expect(await t.call('GETDEL', 'gd:a')).toBeNull();
    await t.call('RPUSH', 'gd:l', 'x');
    expect(await err(t.call('GETDEL', 'gd:l'))).toBe(WRONGTYPE);
    expect(await t.call('EXISTS', 'gd:l')).toBe(1);
    expect(await err(t.call('GETDEL'))).toBe(arity('getdel'));
  });

  it('GETEX options', async () => {
    await t.call('SET', 'ge:a', 'Hello');
    expect(await t.call('GETEX', 'ge:a')).toBe('Hello');
    expect(await t.call('TTL', 'ge:a')).toBe(-1);
    expect(await t.call('GETEX', 'ge:a', 'EX', 60)).toBe('Hello');
    expect(await t.call('TTL', 'ge:a')).toBe(60);
    expect(await t.call('GETEX', 'ge:a', 'PX', 70000)).toBe('Hello');
    expect(await t.call('PTTL', 'ge:a')).toBeGreaterThan(69000);
    const at = Math.floor(Date.now() / 1000) + 500;
    expect(await t.call('GETEX', 'ge:a', 'EXAT', at)).toBe('Hello');
    expect(await t.call('EXPIRETIME', 'ge:a')).toBe(at);
    const pat = Date.now() + 600000;
    expect(await t.call('GETEX', 'ge:a', 'PXAT', pat)).toBe('Hello');
    expect(await t.call('PEXPIRETIME', 'ge:a')).toBe(pat);
    expect(await t.call('GETEX', 'ge:a', 'PERSIST')).toBe('Hello');
    expect(await t.call('TTL', 'ge:a')).toBe(-1);
    expect(await t.call('GETEX', 'ge:missing', 'EX', 10)).toBeNull();
    expect(await t.call('EXISTS', 'ge:missing')).toBe(0);
  });

  it('GETEX with a past absolute time returns the value and deletes the key', async () => {
    await t.call('SET', 'ge:past', 'v');
    expect(await t.call('GETEX', 'ge:past', 'EXAT', 1000)).toBe('v');
    expect(await t.call('EXISTS', 'ge:past')).toBe(0);
  });

  it('GETEX errors', async () => {
    await t.call('SET', 'ge:e', 'v');
    expect(await err(t.call('GETEX', 'ge:e', 'EX', 0))).toBe("ERR invalid expire time in 'getex' command");
    expect(await err(t.call('GETEX', 'ge:e', 'PX', -1))).toBe("ERR invalid expire time in 'getex' command");
    expect(await err(t.call('GETEX', 'ge:e', 'EX', 'x'))).toBe(NOT_INT);
    expect(await err(t.call('GETEX', 'ge:e', 'EX', 10, 'PERSIST'))).toBe(SYNTAX);
    expect(await err(t.call('GETEX', 'ge:e', 'EX', 10, 'PX', 10))).toBe(SYNTAX);
    expect(await err(t.call('GETEX', 'ge:e', 'EX'))).toBe(SYNTAX);
    expect(await err(t.call('GETEX', 'ge:e', 'FOO'))).toBe(SYNTAX);
    expect(await t.call('TTL', 'ge:e')).toBe(-1);
    await t.call('RPUSH', 'ge:l', 'x');
    expect(await err(t.call('GETEX', 'ge:l'))).toBe(WRONGTYPE);
    expect(await err(t.call('GETEX'))).toBe(arity('getex'));
  });
});

describe('MGET / MSET / MSETNX', () => {
  it('MGET returns nil for missing and non-string keys', async () => {
    await t.call('MSET', 'mg:a', 'Hello', 'mg:b', 'World');
    await t.call('RPUSH', 'mg:l', 'x');
    expect(await t.call('MGET', 'mg:a', 'mg:b', 'mg:nonexisting', 'mg:l')).toEqual(['Hello', 'World', null, null]);
    expect(await err(t.call('MGET'))).toBe(arity('mget'));
  });

  it('MGET RESP3 null elements', async () => {
    await t.call('SET', 'mg:r', 'v');
    const r = await resp3();
    expect(await r.send('MGET', 'mg:r', 'mg:none')).toBe('*2\r\n$1\r\nv\r\n_\r\n');
    const r2 = await t.raw();
    expect(await r2.send('MGET', 'mg:r', 'mg:none')).toBe('*2\r\n$1\r\nv\r\n$-1\r\n');
  });

  it('MSET overwrites and clears TTL', async () => {
    await t.call('SET', 'ms:a', 'old', 'EX', 100);
    expect(await t.call('MSET', 'ms:a', '1', 'ms:b', '2')).toBe('OK');
    expect(await t.call('MGET', 'ms:a', 'ms:b')).toEqual(['1', '2']);
    expect(await t.call('TTL', 'ms:a')).toBe(-1);
    expect(await t.call('MSET', 'ms:dup', '1', 'ms:dup', '2')).toBe('OK');
    expect(await t.call('GET', 'ms:dup')).toBe('2');
    expect(await err(t.call('MSET', 'ms:a'))).toBe(arity('mset'));
    expect(await err(t.call('MSET', 'ms:a', '1', 'ms:b'))).toBe(arity('mset'));
  });

  it('MSETNX is all-or-nothing', async () => {
    expect(await t.call('MSETNX', 'mn:a', 'Hello', 'mn:b', 'there')).toBe(1);
    expect(await t.call('MSETNX', 'mn:b', 'new', 'mn:c', 'world')).toBe(0);
    expect(await t.call('MGET', 'mn:a', 'mn:b', 'mn:c')).toEqual(['Hello', 'there', null]);
    await t.call('RPUSH', 'mn:l', 'x');
    expect(await t.call('MSETNX', 'mn:l', 'v', 'mn:d', 'v')).toBe(0);
    expect(await err(t.call('MSETNX', 'mn:x'))).toBe(arity('msetnx'));
    expect(await err(t.call('MSETNX', 'mn:x', '1', 'mn:y'))).toBe(arity('msetnx'));
  });
});

/* ------------------------------------------------------------------ */
/* INCR family                                                         */
/* ------------------------------------------------------------------ */

describe('INCR / DECR / INCRBY / DECRBY', () => {
  it('docs examples', async () => {
    await t.call('SET', 'in:a', '10');
    expect(await t.call('INCR', 'in:a')).toBe(11);
    expect(await t.call('GET', 'in:a')).toBe('11');
    expect(await t.call('DECR', 'in:a')).toBe(10);
    expect(await t.call('INCRBY', 'in:a', 5)).toBe(15);
    expect(await t.call('DECRBY', 'in:a', 3)).toBe(12);
    expect(await t.call('INCRBY', 'in:a', -20)).toBe(-8);
    expect(await t.call('DECRBY', 'in:a', -8)).toBe(0);
    expect(await t.call('INCR', 'in:new')).toBe(1);
    expect(await t.call('DECR', 'in:new2')).toBe(-1);
    expect(await t.call('INCRBY', 'in:new3', 7)).toBe(7);
    expect(await t.call('DECRBY', 'in:new4', 7)).toBe(-7);
  });

  it('keeps the TTL', async () => {
    await t.call('SET', 'in:ttl', '1', 'EX', 100);
    await t.call('INCR', 'in:ttl');
    expect(await t.call('TTL', 'in:ttl')).toBeGreaterThan(95);
  });

  it('non-integer values and increments', async () => {
    await t.call('SET', 'in:s', 'abc');
    expect(await err(t.call('INCR', 'in:s'))).toBe(NOT_INT);
    await t.call('SET', 'in:sp', ' 1');
    expect(await err(t.call('INCR', 'in:sp'))).toBe(NOT_INT);
    await t.call('SET', 'in:f', '1.5');
    expect(await err(t.call('INCR', 'in:f'))).toBe(NOT_INT);
    await t.call('SET', 'in:big', '92233720368547758070');
    expect(await err(t.call('INCR', 'in:big'))).toBe(NOT_INT);
    expect(await err(t.call('INCRBY', 'in:x', 'abc'))).toBe(NOT_INT);
    expect(await err(t.call('INCRBY', 'in:x', '1.5'))).toBe(NOT_INT);
    expect(await err(t.call('DECRBY', 'in:x', 'abc'))).toBe(NOT_INT);
    expect(await t.call('EXISTS', 'in:x')).toBe(0);
  });

  it('overflow', async () => {
    await t.call('SET', 'in:max', '9223372036854775807');
    expect(await err(t.call('INCR', 'in:max'))).toBe('ERR increment or decrement would overflow');
    expect(await t.call('GET', 'in:max')).toBe('9223372036854775807');
    await t.call('SET', 'in:min', '-9223372036854775808');
    expect(await err(t.call('DECR', 'in:min'))).toBe('ERR increment or decrement would overflow');
    expect(await err(t.call('INCRBY', 'in:min', -1))).toBe('ERR increment or decrement would overflow');
    await t.call('SET', 'in:one', '1');
    expect(await err(t.call('INCRBY', 'in:one', '9223372036854775807'))).toBe('ERR increment or decrement would overflow');
    expect(await err(t.call('DECRBY', 'in:one', '-9223372036854775808'))).toBe('ERR decrement would overflow');
    expect(await err(t.call('INCRBY', 'in:one', '9223372036854775808'))).toBe(NOT_INT);
  });

  it('exact 64-bit replies on the wire', async () => {
    const r = await t.raw();
    await r.send('SET', 'in:w', '9223372036854775806');
    expect(await r.send('INCR', 'in:w')).toBe(':9223372036854775807\r\n');
    await r.send('SET', 'in:w2', '-9223372036854775807');
    expect(await r.send('DECR', 'in:w2')).toBe(':-9223372036854775808\r\n');
  });

  it('wrong type and arity', async () => {
    await t.call('RPUSH', 'in:l', 'x');
    expect(await err(t.call('INCR', 'in:l'))).toBe(WRONGTYPE);
    expect(await err(t.call('DECRBY', 'in:l', 1))).toBe(WRONGTYPE);
    expect(await err(t.call('INCR'))).toBe(arity('incr'));
    expect(await err(t.call('DECR'))).toBe(arity('decr'));
    expect(await err(t.call('INCRBY', 'a'))).toBe(arity('incrby'));
    expect(await err(t.call('DECRBY', 'a'))).toBe(arity('decrby'));
  });
});

describe('INCRBYFLOAT', () => {
  it('docs examples', async () => {
    await t.call('SET', 'if:a', '10.50');
    expect(await t.call('INCRBYFLOAT', 'if:a', '0.1')).toBe('10.6');
    expect(await t.call('INCRBYFLOAT', 'if:a', '-5')).toBe('5.6');
    await t.call('SET', 'if:a', '5.0e3');
    expect(await t.call('INCRBYFLOAT', 'if:a', '2.0e2')).toBe('5200');
    expect(await t.call('GET', 'if:a')).toBe('5200');
  });

  it('formatting: integers without decimals, no trailing zeros', async () => {
    expect(await t.call('INCRBYFLOAT', 'if:new', '3.0')).toBe('3');
    expect(await t.call('INCRBYFLOAT', 'if:new', '1.5')).toBe('4.5');
    expect(await t.call('INCRBYFLOAT', 'if:new', '-4.5')).toBe('0');
    await t.call('SET', 'if:i', '10');
    expect(await t.call('INCRBYFLOAT', 'if:i', '0.25')).toBe('10.25');
  });

  it('keeps the TTL', async () => {
    await t.call('SET', 'if:ttl', '1', 'EX', 100);
    await t.call('INCRBYFLOAT', 'if:ttl', '1.1');
    expect(await t.call('TTL', 'if:ttl')).toBeGreaterThan(95);
  });

  it('errors', async () => {
    await t.call('SET', 'if:s', 'abc');
    expect(await err(t.call('INCRBYFLOAT', 'if:s', '1'))).toBe(NOT_FLOAT);
    expect(await err(t.call('INCRBYFLOAT', 'if:x', 'abc'))).toBe(NOT_FLOAT);
    await t.call('SET', 'if:huge', '1e308');
    expect(await err(t.call('INCRBYFLOAT', 'if:huge', '1e308'))).toBe('ERR increment would produce NaN or Infinity');
    expect(await t.call('GET', 'if:huge')).toBe('1e308');
    // unverified: whether "inf" is rejected as "not a valid float" or as "would produce NaN or Infinity"
    expect(await err(t.call('INCRBYFLOAT', 'if:x', 'inf'))).toMatch(/^ERR (value is not a valid float|increment would produce NaN or Infinity)$/);
    expect(await err(t.call('INCRBYFLOAT', 'if:x', 'nan'))).toMatch(/^ERR /);
    expect(await t.call('EXISTS', 'if:x')).toBe(0);
    await t.call('RPUSH', 'if:l', 'x');
    expect(await err(t.call('INCRBYFLOAT', 'if:l', '1'))).toBe(WRONGTYPE);
    expect(await err(t.call('INCRBYFLOAT', 'if:l'))).toBe(arity('incrbyfloat'));
  });

  it('is a bulk string in RESP3 too', async () => {
    const r = await resp3();
    await r.send('SET', 'if:r3', '10.5');
    expect(await r.send('INCRBYFLOAT', 'if:r3', '0.1')).toBe('$4\r\n10.6\r\n');
  });
});

/* ------------------------------------------------------------------ */
/* APPEND / STRLEN / GETRANGE / SETRANGE / LCS                         */
/* ------------------------------------------------------------------ */

describe('APPEND / STRLEN', () => {
  it('APPEND docs example', async () => {
    expect(await t.call('EXISTS', 'ap:k')).toBe(0);
    expect(await t.call('APPEND', 'ap:k', 'Hello')).toBe(5);
    expect(await t.call('APPEND', 'ap:k', ' World')).toBe(11);
    expect(await t.call('GET', 'ap:k')).toBe('Hello World');
  });

  it('APPEND to an integer-encoded value', async () => {
    await t.call('SET', 'ap:i', '12');
    expect(await t.call('APPEND', 'ap:i', '34')).toBe(4);
    expect(await t.call('GET', 'ap:i')).toBe('1234');
  });

  it('APPEND keeps the TTL', async () => {
    await t.call('SET', 'ap:t', 'a', 'EX', 100);
    await t.call('APPEND', 'ap:t', 'b');
    expect(await t.call('TTL', 'ap:t')).toBeGreaterThan(95);
  });

  it('STRLEN', async () => {
    await t.call('SET', 'sl:k', 'Hello world');
    expect(await t.call('STRLEN', 'sl:k')).toBe(11);
    expect(await t.call('STRLEN', 'sl:nonexisting')).toBe(0);
    await t.call('SET', 'sl:i', '-12345');
    expect(await t.call('STRLEN', 'sl:i')).toBe(6);
    await t.call('SET', 'sl:u', Buffer.from('héllo', 'utf8'));
    expect(await t.call('STRLEN', 'sl:u')).toBe(6);
  });

  it('wrong type and arity', async () => {
    await t.call('RPUSH', 'ap:l', 'x');
    expect(await err(t.call('APPEND', 'ap:l', 'v'))).toBe(WRONGTYPE);
    expect(await err(t.call('STRLEN', 'ap:l'))).toBe(WRONGTYPE);
    expect(await err(t.call('APPEND', 'ap:l'))).toBe(arity('append'));
    expect(await err(t.call('STRLEN'))).toBe(arity('strlen'));
  });
});

describe('GETRANGE / SUBSTR', () => {
  it('docs examples', async () => {
    await t.call('SET', 'gr:k', 'This is a string');
    expect(await t.call('GETRANGE', 'gr:k', 0, 3)).toBe('This');
    expect(await t.call('GETRANGE', 'gr:k', -3, -1)).toBe('ing');
    expect(await t.call('GETRANGE', 'gr:k', 0, -1)).toBe('This is a string');
    expect(await t.call('GETRANGE', 'gr:k', 10, 100)).toBe('string');
  });

  it('edge cases', async () => {
    await t.call('SET', 'gr:e', 'Hello');
    expect(await t.call('GETRANGE', 'gr:e', 3, 1)).toBe('');
    expect(await t.call('GETRANGE', 'gr:e', 10, 20)).toBe('');
    expect(await t.call('GETRANGE', 'gr:e', -100, 1)).toBe('He');
    expect(await t.call('GETRANGE', 'gr:e', -1, -5)).toBe('');
    expect(await t.call('GETRANGE', 'gr:e', 4, 4)).toBe('o');
    expect(await t.call('GETRANGE', 'gr:missing', 0, -1)).toBe('');
    await t.call('SET', 'gr:int', '12345');
    expect(await t.call('GETRANGE', 'gr:int', 1, 2)).toBe('23');
  });

  it('SUBSTR is an alias', async () => {
    await t.call('SET', 'gr:sub', 'This is a string');
    expect(await t.call('SUBSTR', 'gr:sub', 0, 3)).toBe('This');
    expect(await t.call('SUBSTR', 'gr:sub', -3, -1)).toBe('ing');
  });

  it('errors', async () => {
    await t.call('SET', 'gr:x', 'v');
    expect(await err(t.call('GETRANGE', 'gr:x', 'a', 1))).toBe(NOT_INT);
    expect(await err(t.call('GETRANGE', 'gr:x', 0))).toBe(arity('getrange'));
    expect(await err(t.call('SUBSTR', 'gr:x', 0))).toBe(arity('substr'));
    await t.call('RPUSH', 'gr:l', 'x');
    expect(await err(t.call('GETRANGE', 'gr:l', 0, 1))).toBe(WRONGTYPE);
  });
});

describe('SETRANGE', () => {
  it('docs examples', async () => {
    await t.call('SET', 'sr:k1', 'Hello World');
    expect(await t.call('SETRANGE', 'sr:k1', 6, 'Redis')).toBe(11);
    expect(await t.call('GET', 'sr:k1')).toBe('Hello Redis');
    expect(await t.call('SETRANGE', 'sr:k2', 6, 'Redis')).toBe(11);
    expect(await t.redis.getBuffer('sr:k2')).toEqual(Buffer.concat([Buffer.alloc(6), Buffer.from('Redis')]));
  });

  it('pads an existing value with zero bytes', async () => {
    await t.call('SET', 'sr:p', 'ab');
    expect(await t.call('SETRANGE', 'sr:p', 4, 'z')).toBe(5);
    expect(await t.redis.getBuffer('sr:p')).toEqual(Buffer.from([0x61, 0x62, 0, 0, 0x7a]));
  });

  it('empty value', async () => {
    expect(await t.call('SETRANGE', 'sr:empty', 10, '')).toBe(0);
    expect(await t.call('EXISTS', 'sr:empty')).toBe(0);
    await t.call('SET', 'sr:e2', 'abc');
    expect(await t.call('SETRANGE', 'sr:e2', 10, '')).toBe(3);
    expect(await t.call('GET', 'sr:e2')).toBe('abc');
  });

  it('on an integer-encoded value', async () => {
    await t.call('SET', 'sr:i', '1234');
    expect(await t.call('SETRANGE', 'sr:i', 1, 'x')).toBe(4);
    expect(await t.call('GET', 'sr:i')).toBe('1x34');
  });

  it('errors', async () => {
    expect(await err(t.call('SETRANGE', 'sr:e', -1, 'x'))).toBe('ERR offset is out of range');
    expect(await err(t.call('SETRANGE', 'sr:e', 'a', 'x'))).toBe(NOT_INT);
    expect(await err(t.call('SETRANGE', 'sr:e', 536870912, 'x'))).toBe('ERR string exceeds maximum allowed size (proto-max-bulk-len)');
    expect(await t.call('EXISTS', 'sr:e')).toBe(0);
    await t.call('RPUSH', 'sr:l', 'x');
    expect(await err(t.call('SETRANGE', 'sr:l', 0, 'x'))).toBe(WRONGTYPE);
    expect(await err(t.call('SETRANGE', 'sr:l', 0))).toBe(arity('setrange'));
  });
});

describe('LCS', () => {
  it('docs examples', async () => {
    await t.call('MSET', 'lcs:1', 'ohmytext', 'lcs:2', 'mynewtext');
    expect(await t.call('LCS', 'lcs:1', 'lcs:2')).toBe('mytext');
    expect(await t.call('LCS', 'lcs:1', 'lcs:2', 'LEN')).toBe(6);
    expect(await t.call('LCS', 'lcs:1', 'lcs:2', 'IDX')).toEqual(['matches', [[[4, 7], [5, 8]], [[2, 3], [0, 1]]], 'len', 6]);
    expect(await t.call('LCS', 'lcs:1', 'lcs:2', 'IDX', 'MINMATCHLEN', 4)).toEqual(['matches', [[[4, 7], [5, 8]]], 'len', 6]);
    expect(await t.call('LCS', 'lcs:1', 'lcs:2', 'IDX', 'MINMATCHLEN', 4, 'WITHMATCHLEN')).toEqual(['matches', [[[4, 7], [5, 8], 4]], 'len', 6]);
    expect(await t.call('LCS', 'lcs:1', 'lcs:2', 'IDX', 'WITHMATCHLEN')).toEqual(['matches', [[[4, 7], [5, 8], 4], [[2, 3], [0, 1], 2]], 'len', 6]);
  });

  it('missing keys are empty strings', async () => {
    await t.call('SET', 'lcs:only', 'abc');
    expect(await t.call('LCS', 'lcs:only', 'lcs:missing')).toBe('');
    expect(await t.call('LCS', 'lcs:missing', 'lcs:missing2', 'LEN')).toBe(0);
    expect(await t.call('LCS', 'lcs:only', 'lcs:missing', 'IDX')).toEqual(['matches', [], 'len', 0]);
  });

  it('RESP3 IDX is a map', async () => {
    await t.call('MSET', 'lcs:r1', 'ohmytext', 'lcs:r2', 'mynewtext');
    const r = await resp3();
    expect(await r.send('LCS', 'lcs:r1', 'lcs:r2', 'IDX')).toBe(
      '%2\r\n$7\r\nmatches\r\n*2\r\n*2\r\n*2\r\n:4\r\n:7\r\n*2\r\n:5\r\n:8\r\n*2\r\n*2\r\n:2\r\n:3\r\n*2\r\n:0\r\n:1\r\n$3\r\nlen\r\n:6\r\n',
    );
  });

  it('errors', async () => {
    await t.call('MSET', 'lcs:e1', 'a', 'lcs:e2', 'b');
    await t.call('RPUSH', 'lcs:l', 'x');
    expect(await err(t.call('LCS', 'lcs:e1', 'lcs:l'))).toBe('ERR The specified keys must contain string values');
    expect(await err(t.call('LCS', 'lcs:e1', 'lcs:e2', 'LEN', 'IDX'))).toBe('ERR If you want both the length and indexes, please just use IDX.');
    expect(await err(t.call('LCS', 'lcs:e1', 'lcs:e2', 'FOO'))).toBe(SYNTAX);
    expect(await err(t.call('LCS', 'lcs:e1', 'lcs:e2', 'IDX', 'MINMATCHLEN', 'x'))).toBe(NOT_INT);
    expect(await err(t.call('LCS', 'lcs:e1'))).toBe(arity('lcs'));
  });
});

/* ------------------------------------------------------------------ */
/* Bitmaps                                                             */
/* ------------------------------------------------------------------ */

describe('SETBIT / GETBIT', () => {
  it('docs examples', async () => {
    expect(await t.call('SETBIT', 'bit:k', 7, 1)).toBe(0);
    expect(await t.call('SETBIT', 'bit:k', 7, 0)).toBe(1);
    expect(await t.redis.getBuffer('bit:k')).toEqual(Buffer.from([0]));
    await t.call('SETBIT', 'bit:g', 7, 1);
    expect(await t.call('GETBIT', 'bit:g', 0)).toBe(0);
    expect(await t.call('GETBIT', 'bit:g', 7)).toBe(1);
    expect(await t.call('GETBIT', 'bit:g', 100)).toBe(0);
    expect(await t.call('GETBIT', 'bit:missing', 5)).toBe(0);
  });

  it('grows the string with zero bytes', async () => {
    expect(await t.call('SETBIT', 'bit:grow', 23, 1)).toBe(0);
    expect(await t.redis.getBuffer('bit:grow')).toEqual(Buffer.from([0, 0, 1]));
    await t.call('SET', 'bit:a', 'a');
    await t.call('SETBIT', 'bit:a', 6, 1);
    expect(await t.call('GET', 'bit:a')).toBe('c');
  });

  it('errors', async () => {
    expect(await err(t.call('SETBIT', 'bit:e', -1, 1))).toBe('ERR bit offset is not an integer or out of range');
    expect(await err(t.call('SETBIT', 'bit:e', 4294967296, 1))).toBe('ERR bit offset is not an integer or out of range');
    expect(await err(t.call('SETBIT', 'bit:e', 'a', 1))).toBe('ERR bit offset is not an integer or out of range');
    expect(await err(t.call('SETBIT', 'bit:e', 0, 2))).toBe('ERR bit is not an integer or out of range');
    expect(await err(t.call('SETBIT', 'bit:e', 0, 'x'))).toBe('ERR bit is not an integer or out of range');
    expect(await err(t.call('GETBIT', 'bit:e', -1))).toBe('ERR bit offset is not an integer or out of range');
    expect(await t.call('EXISTS', 'bit:e')).toBe(0);
    await t.call('RPUSH', 'bit:l', 'x');
    expect(await err(t.call('SETBIT', 'bit:l', 0, 1))).toBe(WRONGTYPE);
    expect(await err(t.call('GETBIT', 'bit:l', 0))).toBe(WRONGTYPE);
    expect(await err(t.call('SETBIT', 'bit:l', 0))).toBe(arity('setbit'));
    expect(await err(t.call('GETBIT', 'bit:l'))).toBe(arity('getbit'));
  });
});

describe('BITCOUNT', () => {
  it('docs examples', async () => {
    await t.call('SET', 'bc:k', 'foobar');
    expect(await t.call('BITCOUNT', 'bc:k')).toBe(26);
    expect(await t.call('BITCOUNT', 'bc:k', 0, 0)).toBe(4);
    expect(await t.call('BITCOUNT', 'bc:k', 1, 1)).toBe(6);
    expect(await t.call('BITCOUNT', 'bc:k', 1, 1, 'BYTE')).toBe(6);
    expect(await t.call('BITCOUNT', 'bc:k', 5, 30, 'BIT')).toBe(17);
  });

  it('negative ranges and edge cases', async () => {
    await t.call('SET', 'bc:n', 'foobar');
    expect(await t.call('BITCOUNT', 'bc:n', 0, -1)).toBe(26);
    expect(await t.call('BITCOUNT', 'bc:n', -1, -1)).toBe(4); // 'r' = 0x72
    expect(await t.call('BITCOUNT', 'bc:n', -100, 100)).toBe(26);
    expect(await t.call('BITCOUNT', 'bc:n', 3, 1)).toBe(0);
    expect(await t.call('BITCOUNT', 'bc:n', 0, -1, 'BIT')).toBe(26);
    expect(await t.call('BITCOUNT', 'bc:n', -8, -1, 'BIT')).toBe(4);
    expect(await t.call('BITCOUNT', 'bc:missing')).toBe(0);
    expect(await t.call('BITCOUNT', 'bc:missing', 0, 10)).toBe(0);
  });

  it('errors', async () => {
    await t.call('SET', 'bc:e', 'foobar');
    expect(await err(t.call('BITCOUNT', 'bc:e', 0))).toBe(SYNTAX);
    expect(await err(t.call('BITCOUNT', 'bc:e', 0, 1, 'FOO'))).toBe(SYNTAX);
    expect(await err(t.call('BITCOUNT', 'bc:e', 'a', 1))).toBe(NOT_INT);
    await t.call('RPUSH', 'bc:l', 'x');
    expect(await err(t.call('BITCOUNT', 'bc:l'))).toBe(WRONGTYPE);
    expect(await err(t.call('BITCOUNT'))).toBe(arity('bitcount'));
  });
});

describe('BITPOS', () => {
  it('docs examples', async () => {
    await t.call('SET', 'bp:k', Buffer.from([0xff, 0xf0, 0x00]));
    expect(await t.call('BITPOS', 'bp:k', 0)).toBe(12);
    await t.call('SET', 'bp:k', Buffer.from([0x00, 0xff, 0xf0]));
    expect(await t.call('BITPOS', 'bp:k', 1, 0)).toBe(8);
    expect(await t.call('BITPOS', 'bp:k', 1, 2)).toBe(16);
    expect(await t.call('BITPOS', 'bp:k', 1, 2, -1, 'BYTE')).toBe(16);
    expect(await t.call('BITPOS', 'bp:k', 1, 7, 15, 'BIT')).toBe(8);
    await t.call('SET', 'bp:k', Buffer.from([0x00, 0x00, 0x00]));
    expect(await t.call('BITPOS', 'bp:k', 1)).toBe(-1);
    expect(await t.call('BITPOS', 'bp:k', 1, 7, -3, 'BIT')).toBe(-1);
  });

  it('clear bit search past the end', async () => {
    await t.call('SET', 'bp:ones', Buffer.from([0xff, 0xff, 0xff]));
    expect(await t.call('BITPOS', 'bp:ones', 0)).toBe(24);
    expect(await t.call('BITPOS', 'bp:ones', 0, 0)).toBe(24);
    expect(await t.call('BITPOS', 'bp:ones', 0, 0, -1)).toBe(-1);
  });

  it('missing key', async () => {
    expect(await t.call('BITPOS', 'bp:missing', 0)).toBe(0);
    expect(await t.call('BITPOS', 'bp:missing', 1)).toBe(-1);
  });

  it('errors', async () => {
    await t.call('SET', 'bp:e', 'a');
    expect(await err(t.call('BITPOS', 'bp:e', 2))).toBe('ERR The bit argument must be 1 or 0.');
    expect(await err(t.call('BITPOS', 'bp:e', 1, 'a'))).toBe(NOT_INT);
    expect(await err(t.call('BITPOS', 'bp:e', 1, 0, 1, 'FOO'))).toBe(SYNTAX);
    await t.call('RPUSH', 'bp:l', 'x');
    expect(await err(t.call('BITPOS', 'bp:l', 1))).toBe(WRONGTYPE);
    expect(await err(t.call('BITPOS', 'bp:l'))).toBe(arity('bitpos'));
  });
});

describe('BITOP', () => {
  it('AND docs example', async () => {
    await t.call('SET', 'bo:k1', 'foobar');
    await t.call('SET', 'bo:k2', 'abcdef');
    expect(await t.call('BITOP', 'AND', 'bo:dest', 'bo:k1', 'bo:k2')).toBe(6);
    expect(await t.call('GET', 'bo:dest')).toBe('`bc`ab');
  });

  it('OR / XOR pad shorter strings with zeros', async () => {
    await t.call('SET', 'bo:a', Buffer.from([0x01]));
    await t.call('SET', 'bo:b', Buffer.from([0x10, 0x02]));
    expect(await t.call('BITOP', 'OR', 'bo:or', 'bo:a', 'bo:b')).toBe(2);
    expect(await t.redis.getBuffer('bo:or')).toEqual(Buffer.from([0x11, 0x02]));
    expect(await t.call('BITOP', 'XOR', 'bo:xor', 'bo:a', 'bo:b', 'bo:b')).toBe(2);
    expect(await t.redis.getBuffer('bo:xor')).toEqual(Buffer.from([0x01, 0x00]));
    expect(await t.call('BITOP', 'AND', 'bo:and', 'bo:a', 'bo:b')).toBe(2);
    expect(await t.redis.getBuffer('bo:and')).toEqual(Buffer.from([0x00, 0x00]));
    expect(await t.call('BITOP', 'and', 'bo:and2', 'bo:a', 'bo:missing')).toBe(1);
    expect(await t.redis.getBuffer('bo:and2')).toEqual(Buffer.from([0x00]));
  });

  it('NOT', async () => {
    await t.call('SET', 'bo:n', Buffer.from([0xf0, 0x00]));
    expect(await t.call('BITOP', 'NOT', 'bo:nd', 'bo:n')).toBe(2);
    expect(await t.redis.getBuffer('bo:nd')).toEqual(Buffer.from([0x0f, 0xff]));
  });

  it('DIFF / DIFF1 / ANDOR / ONE (Redis 8.2+)', async () => {
    await t.call('SET', 'bo:x', Buffer.from([0b11110000]));
    await t.call('SET', 'bo:y', Buffer.from([0b10100000]));
    await t.call('SET', 'bo:z', Buffer.from([0b01000001]));
    expect(await t.call('BITOP', 'DIFF', 'bo:r1', 'bo:x', 'bo:y', 'bo:z')).toBe(1);
    expect(await t.redis.getBuffer('bo:r1')).toEqual(Buffer.from([0b00010000]));
    expect(await t.call('BITOP', 'DIFF1', 'bo:r2', 'bo:x', 'bo:y', 'bo:z')).toBe(1);
    expect(await t.redis.getBuffer('bo:r2')).toEqual(Buffer.from([0b00000001]));
    expect(await t.call('BITOP', 'ANDOR', 'bo:r3', 'bo:x', 'bo:y', 'bo:z')).toBe(1);
    expect(await t.redis.getBuffer('bo:r3')).toEqual(Buffer.from([0b11100000]));
    expect(await t.call('BITOP', 'ONE', 'bo:r4', 'bo:x', 'bo:y', 'bo:z')).toBe(1);
    expect(await t.redis.getBuffer('bo:r4')).toEqual(Buffer.from([0b00010001]));
  });

  it('all sources missing deletes the destination and returns 0', async () => {
    await t.call('SET', 'bo:old', 'x');
    expect(await t.call('BITOP', 'OR', 'bo:old', 'bo:m1', 'bo:m2')).toBe(0);
    expect(await t.call('EXISTS', 'bo:old')).toBe(0);
  });

  it('errors', async () => {
    await t.call('SET', 'bo:e1', 'a');
    await t.call('SET', 'bo:e2', 'b');
    await t.call('RPUSH', 'bo:l', 'x');
    expect(await err(t.call('BITOP', 'NOT', 'bo:d', 'bo:e1', 'bo:e2'))).toBe('ERR BITOP NOT must be called with a single source key.');
    expect(await err(t.call('BITOP', 'FOO', 'bo:d', 'bo:e1'))).toBe(SYNTAX);
    expect(await err(t.call('BITOP', 'AND', 'bo:d', 'bo:e1', 'bo:l'))).toBe(WRONGTYPE);
    expect(await err(t.call('BITOP', 'AND', 'bo:d'))).toBe(arity('bitop'));
  });
});

describe('BITFIELD / BITFIELD_RO', () => {
  it('docs examples', async () => {
    expect(await t.call('BITFIELD', 'bf:k', 'INCRBY', 'i5', 100, 1, 'GET', 'u4', 0)).toEqual([1, 0]);
    expect(await t.call('BITFIELD', 'bf:k2', 'SET', 'i8', '#0', 100, 'SET', 'i8', '#1', 200)).toEqual([0, 0]);
    expect(await t.call('BITFIELD', 'bf:k2', 'GET', 'i8', '#0', 'GET', 'u8', '#1', 'GET', 'i8', '#1')).toEqual([100, 200, -56]);
    expect(await t.call('GETRANGE', 'bf:k2', 0, 0)).toBe('d');
    expect(await t.call('BITFIELD', 'bf:k2', 'GET', 'u8', 8)).toEqual([200]);
  });

  it('OVERFLOW SAT / WRAP docs example', async () => {
    const step = () => t.call('BITFIELD', 'bf:ov', 'INCRBY', 'u2', 100, 1, 'OVERFLOW', 'SAT', 'INCRBY', 'u2', 102, 1);
    expect(await step()).toEqual([1, 1]);
    expect(await step()).toEqual([2, 2]);
    expect(await step()).toEqual([3, 3]);
    expect(await step()).toEqual([0, 3]);
  });

  it('OVERFLOW FAIL returns nil and leaves the value', async () => {
    await t.call('BITFIELD', 'bf:f', 'SET', 'u2', 0, 3);
    expect(await t.call('BITFIELD', 'bf:f', 'OVERFLOW', 'FAIL', 'INCRBY', 'u2', 0, 1)).toEqual([null]);
    expect(await t.call('BITFIELD', 'bf:f', 'GET', 'u2', 0)).toEqual([3]);
    expect(await t.call('BITFIELD', 'bf:f', 'OVERFLOW', 'FAIL', 'INCRBY', 'u2', 0, -1)).toEqual([2]);
    const r3 = await resp3();
    expect(await r3.send('BITFIELD', 'bf:f', 'OVERFLOW', 'FAIL', 'INCRBY', 'u2', '0', '5')).toBe('*1\r\n_\r\n');
    const r2 = await t.raw();
    expect(await r2.send('BITFIELD', 'bf:f', 'OVERFLOW', 'FAIL', 'INCRBY', 'u2', '0', '5')).toBe('*1\r\n$-1\r\n');
  });

  it('signed overflow WRAP and SAT', async () => {
    await t.call('BITFIELD', 'bf:s', 'SET', 'i8', 0, 127);
    expect(await t.call('BITFIELD', 'bf:s', 'INCRBY', 'i8', 0, 1)).toEqual([-128]);
    await t.call('BITFIELD', 'bf:s', 'SET', 'i8', 0, 127);
    expect(await t.call('BITFIELD', 'bf:s', 'OVERFLOW', 'SAT', 'INCRBY', 'i8', 0, 10)).toEqual([127]);
    expect(await t.call('BITFIELD', 'bf:s', 'OVERFLOW', 'SAT', 'INCRBY', 'i8', 0, -300)).toEqual([-128]);
    // SET with an out of range value wraps by default
    expect(await t.call('BITFIELD', 'bf:s2', 'SET', 'u8', 0, 257)).toEqual([0]);
    expect(await t.call('BITFIELD', 'bf:s2', 'GET', 'u8', 0)).toEqual([1]);
    expect(await t.call('BITFIELD', 'bf:s3', 'OVERFLOW', 'SAT', 'SET', 'u8', 0, 300)).toEqual([0]);
    expect(await t.call('BITFIELD', 'bf:s3', 'GET', 'u8', 0)).toEqual([255]);
  });

  it('i64 / u63 limits (exact on the wire)', async () => {
    const r = await t.raw();
    expect(await r.send('BITFIELD', 'bf:big', 'SET', 'i64', '0', '9223372036854775807')).toBe('*1\r\n:0\r\n');
    expect(await r.send('BITFIELD', 'bf:big', 'GET', 'i64', '0')).toBe('*1\r\n:9223372036854775807\r\n');
    expect(await r.send('BITFIELD', 'bf:big', 'INCRBY', 'i64', '0', '1')).toBe('*1\r\n:-9223372036854775808\r\n');
    expect(await r.send('BITFIELD', 'bf:big', 'OVERFLOW', 'SAT', 'INCRBY', 'i64', '0', '-1')).toBe('*1\r\n:-9223372036854775808\r\n');
    expect(await r.send('BITFIELD', 'bf:u63', 'SET', 'u63', '0', '9223372036854775807')).toBe('*1\r\n:0\r\n');
    expect(await r.send('BITFIELD', 'bf:u63', 'GET', 'u63', '0')).toBe('*1\r\n:9223372036854775807\r\n');
    expect(await r.send('BITFIELD', 'bf:u63', 'INCRBY', 'u63', '0', '1')).toBe('*1\r\n:0\r\n');
  });

  it('GET beyond the string is 0, no-op without subcommands', async () => {
    expect(await t.call('BITFIELD', 'bf:none', 'GET', 'u8', 1000)).toEqual([0]);
    expect(await t.call('EXISTS', 'bf:none')).toBe(0);
    expect(await t.call('BITFIELD', 'bf:none')).toEqual([]);
  });

  it('BITFIELD_RO', async () => {
    await t.call('SET', 'bf:ro', Buffer.from([0xff]));
    expect(await t.call('BITFIELD_RO', 'bf:ro', 'GET', 'u4', 0, 'GET', 'i8', 0)).toEqual([15, -1]);
    expect(await err(t.call('BITFIELD_RO', 'bf:ro', 'SET', 'u4', 0, 1))).toBe('ERR BITFIELD_RO only supports the GET subcommand');
    expect(await err(t.call('BITFIELD_RO', 'bf:ro', 'INCRBY', 'u4', 0, 1))).toBe('ERR BITFIELD_RO only supports the GET subcommand');
    expect(await err(t.call('BITFIELD_RO'))).toBe(arity('bitfield_ro'));
  });

  it('errors', async () => {
    const TYPE_ERR = 'ERR Invalid bitfield type. Use something like i16 u8. Note that u64 is not supported but i64 is.';
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'u64', 0))).toBe(TYPE_ERR);
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'i65', 0))).toBe(TYPE_ERR);
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'i0', 0))).toBe(TYPE_ERR);
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'x8', 0))).toBe(TYPE_ERR);
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'u8', -1))).toBe('ERR bit offset is not an integer or out of range');
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'u8', 'abc'))).toBe('ERR bit offset is not an integer or out of range');
    expect(await err(t.call('BITFIELD', 'bf:e', 'OVERFLOW', 'FOO'))).toBe('ERR Invalid OVERFLOW type specified');
    expect(await err(t.call('BITFIELD', 'bf:e', 'SET', 'u8', 0, 'abc'))).toBe(NOT_INT);
    expect(await err(t.call('BITFIELD', 'bf:e', 'FOO'))).toBe(SYNTAX);
    expect(await err(t.call('BITFIELD', 'bf:e', 'GET', 'u8'))).toBe(SYNTAX);
    expect(await t.call('EXISTS', 'bf:e')).toBe(0);
    await t.call('RPUSH', 'bf:l', 'x');
    expect(await err(t.call('BITFIELD', 'bf:l', 'GET', 'u8', 0))).toBe(WRONGTYPE);
    expect(await err(t.call('BITFIELD'))).toBe(arity('bitfield'));
  });
});

/* ------------------------------------------------------------------ */
/* DUMP / RESTORE (round trip only)                                    */
/* ------------------------------------------------------------------ */

describe('DUMP / RESTORE', () => {
  it('round-trips every type', async () => {
    await t.call('SET', 'dr:s', 'hello');
    await t.call('SET', 'dr:i', '12345');
    await t.call('RPUSH', 'dr:l', 'a', 'b', 'c');
    await t.call('SADD', 'dr:set', 'x', 'y');
    await t.call('ZADD', 'dr:z', 1, 'a', 2.5, 'b');
    await t.call('HSET', 'dr:h', 'f1', 'v1', 'f2', 'v2');
    for (const k of ['dr:s', 'dr:i', 'dr:l', 'dr:set', 'dr:z', 'dr:h']) {
      const payload = await t.redis.dumpBuffer(k);
      expect(Buffer.isBuffer(payload)).toBe(true);
      expect(await t.call('RESTORE', `${k}:copy`, 0, payload)).toBe('OK');
      expect(await t.call('TYPE', `${k}:copy`)).toBe(await t.call('TYPE', k));
      expect(await t.call('TTL', `${k}:copy`)).toBe(-1);
    }
    expect(await t.call('GET', 'dr:s:copy')).toBe('hello');
    expect(await t.call('GET', 'dr:i:copy')).toBe('12345');
    expect(await t.call('LRANGE', 'dr:l:copy', 0, -1)).toEqual(['a', 'b', 'c']);
    expect(((await t.call('SMEMBERS', 'dr:set:copy')) as string[]).sort()).toEqual(['x', 'y']);
    expect(await t.call('ZRANGE', 'dr:z:copy', 0, -1, 'WITHSCORES')).toEqual(['a', '1', 'b', '2.5']);
    expect(await t.call('HGETALL', 'dr:h:copy')).toEqual(['f1', 'v1', 'f2', 'v2']);
  });

  it('binary values round-trip', async () => {
    const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await t.call('SET', 'dr:bin', bin);
    await t.call('RESTORE', 'dr:bin2', 0, await t.redis.dumpBuffer('dr:bin'));
    expect(await t.redis.getBuffer('dr:bin2')).toEqual(bin);
  });

  it('TTL, ABSTTL, REPLACE, BUSYKEY', async () => {
    await t.call('SET', 'dr:t', 'v');
    const payload = await t.redis.dumpBuffer('dr:t');
    expect(await t.call('RESTORE', 'dr:t2', 100000, payload)).toBe('OK');
    expect(await t.call('PTTL', 'dr:t2')).toBeGreaterThan(99000);
    expect(await err(t.call('RESTORE', 'dr:t2', 0, payload))).toBe('BUSYKEY Target key name already exists.');
    expect(await t.call('RESTORE', 'dr:t2', 0, payload, 'REPLACE')).toBe('OK');
    expect(await t.call('TTL', 'dr:t2')).toBe(-1);
    const at = Date.now() + 200000;
    expect(await t.call('RESTORE', 'dr:t3', at, payload, 'ABSTTL')).toBe('OK');
    expect(await t.call('PEXPIRETIME', 'dr:t3')).toBe(at);
    expect(await t.call('RESTORE', 'dr:t4', 0, payload, 'IDLETIME', 100)).toBe('OK');
    expect(await t.call('OBJECT', 'IDLETIME', 'dr:t4')).toBeGreaterThanOrEqual(100);
  });

  it('DUMP of a missing key is nil', async () => {
    expect(await t.call('DUMP', 'dr:missing')).toBeNull();
    const r = await resp3();
    expect(await r.send('DUMP', 'dr:missing')).toBe('_\r\n');
  });

  it('errors', async () => {
    await t.call('SET', 'dr:e', 'v');
    const payload = await t.redis.dumpBuffer('dr:e');
    expect(await err(t.call('RESTORE', 'dr:e2', -1, payload))).toBe('ERR Invalid TTL value, must be >= 0');
    expect(await err(t.call('RESTORE', 'dr:e2', 'x', payload))).toBe(NOT_INT);
    expect(await err(t.call('RESTORE', 'dr:e2', 0, 'garbage'))).toBe('ERR DUMP payload version or checksum are wrong');
    expect(await err(t.call('RESTORE', 'dr:e2', 0, payload, 'FOO'))).toBe(SYNTAX);
    expect(await t.call('EXISTS', 'dr:e2')).toBe(0);
    expect(await err(t.call('DUMP'))).toBe(arity('dump'));
    expect(await err(t.call('RESTORE', 'dr:e2', 0))).toBe(arity('restore'));
  });
});

/* ------------------------------------------------------------------ */
/* Binary safety                                                       */
/* ------------------------------------------------------------------ */

describe('binary-safe keys and values', () => {
  const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const binKey = Buffer.concat([Buffer.from('bin:'), allBytes]);

  it('SET / GET / STRLEN / APPEND with all byte values', async () => {
    expect(await t.call('SET', binKey, allBytes)).toBe('OK');
    expect(await t.redis.getBuffer(binKey)).toEqual(allBytes);
    expect(await t.call('STRLEN', binKey)).toBe(256);
    expect(await t.call('EXISTS', binKey)).toBe(1);
    expect(await t.call('APPEND', binKey, Buffer.from([0x00, 0xff]))).toBe(258);
    expect(await t.redis.getBuffer(binKey)).toEqual(Buffer.concat([allBytes, Buffer.from([0x00, 0xff])]));
  });

  it('keys differing only in high bytes stay distinct', async () => {
    await t.call('SET', Buffer.from([0x62, 0x3a, 0xc3, 0xa9]), 'utf8-e-acute');
    await t.call('SET', Buffer.from([0x62, 0x3a, 0xe9]), 'latin1-e-acute');
    expect(await t.call('GET', Buffer.from([0x62, 0x3a, 0xc3, 0xa9]))).toBe('utf8-e-acute');
    expect(await t.call('GET', Buffer.from([0x62, 0x3a, 0xe9]))).toBe('latin1-e-acute');
    const keys = (await t.redis.keysBuffer('b:*')) as Buffer[];
    const hex = keys.map((k) => k.toString('hex')).sort();
    expect(hex).toEqual(['623ac3a9', '623ae9']);
  });

  it('byte-exact reply on the wire', async () => {
    const r = await t.raw();
    const v = '\x00\xff\r\n\x80';
    expect(await r.send('SET', 'bin:wire', v)).toBe('+OK\r\n');
    expect(await r.send('GET', 'bin:wire')).toBe(`$5\r\n${v}\r\n`);
    expect(await r.send('GETRANGE', 'bin:wire', '1', '3')).toBe('$3\r\n\xff\r\n\r\n');
  });

  it('MSET / MGET / RENAME / COPY with binary keys', async () => {
    const k1 = Buffer.from([0x00, 0x01, 0xfe]);
    const k2 = Buffer.from([0x00, 0x01, 0xff]);
    await t.call('MSET', k1, Buffer.from([0xaa]), k2, Buffer.from([0xbb]));
    const got = (await t.redis.mgetBuffer(k1, k2)) as Buffer[];
    expect(got).toEqual([Buffer.from([0xaa]), Buffer.from([0xbb])]);
    const k3 = Buffer.from([0x00, 0x02, 0x80]);
    await t.call('RENAME', k1, k3);
    expect(await t.redis.getBuffer(k3)).toEqual(Buffer.from([0xaa]));
    const k4 = Buffer.from([0x00, 0x03, 0x81]);
    expect(await t.call('COPY', k3, k4)).toBe(1);
    expect(await t.redis.getBuffer(k4)).toEqual(Buffer.from([0xaa]));
  });

  it('bit operations on binary values', async () => {
    await t.call('SET', 'bin:bits', Buffer.from([0x80, 0x00, 0x01]));
    expect(await t.call('BITCOUNT', 'bin:bits')).toBe(2);
    expect(await t.call('GETBIT', 'bin:bits', 0)).toBe(1);
    expect(await t.call('GETBIT', 'bin:bits', 23)).toBe(1);
    expect(await t.call('BITPOS', 'bin:bits', 1, 1)).toBe(23);
  });
});
