import { describe, expect, it } from 'vitest';

import { arity, err, useServer } from '@/tests/helpers';

/**
 * OBJECT ENCODING / REFCOUNT / IDLETIME / FREQ / HELP (keys.object.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

async function resp3() {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

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
    // APPEND to a missing key stores its argument like SET (Redis 7.0)
    await t.call('APPEND', 'ob:apnew', 'x');
    expect(await enc('ob:apnew')).toBe('embstr');
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
    expect(await enc('ob:l')).toBe('quicklist');
    await t.call('SADD', 'ob:si', '1', '2');
    expect(await enc('ob:si')).toBe('intset');
    await t.call('SADD', 'ob:ss', 'a');
    expect(await enc('ob:ss')).toBe('hashtable');
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
    const start = Date.now();
    await t.call('SET', 'ob:idle', 'v');
    const idle = (await t.call('OBJECT', 'IDLETIME', 'ob:idle')) as number;
    expect(idle).toBeGreaterThanOrEqual(0);
    // at most 1 s on an idle machine; a loaded one may take longer between the two commands
    expect(idle).toBeLessThanOrEqual(1 + Math.floor((Date.now() - start) / 1000));
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
