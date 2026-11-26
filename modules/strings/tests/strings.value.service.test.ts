import { describe, expect, it } from 'vitest';

import { arity, err, NOT_INT, resp3Client, SYNTAX, useServer, WRONGTYPE } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * GET, SET and variants, GETEX, MGET, MSET, MSETNX (strings.value.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();
const resp3 = (): Promise<RawClient> => resp3Client(t);

// ============================================================================
// GET / SET and variants
// ============================================================================

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
    expect(await t.call('PTTL', 'st:px')).toBeGreaterThan(95000);
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
    // 100 s rather than redis.io's 1 s, so the lower bound keeps a margin for a loaded machine
    expect(await t.call('PSETEX', 'sx:p', 100000, 'Hello')).toBe('OK');
    const pttl = (await t.call('PTTL', 'sx:p')) as number;
    expect(pttl).toBeGreaterThan(95000);
    expect(pttl).toBeLessThanOrEqual(100000);
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
    expect(await t.call('PTTL', 'ge:a')).toBeGreaterThan(65000);
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
