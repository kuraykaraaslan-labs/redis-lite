import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

/**
 * Binary safety of keys and values across the string, key and bitmap commands.
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();

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
