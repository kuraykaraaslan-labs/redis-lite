import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';

/**
 * HyperLogLog commands: PFDEBUG (hyperloglog.debug.service). Expected values come from the redis.io command docs
 * (and their examples) and Redis error strings; anything not certain is marked `// unverified:`.
 */
const t = useServer();

const HLL_WRONGTYPE = 'WRONGTYPE Key is not a valid HyperLogLog string value.';

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

/** Resolves to the error message, or to a marker describing the non-error reply. */
const err = async (p: Promise<unknown>): Promise<string> => {
  try {
    return `(no error; reply: ${JSON.stringify(await p)})`;
  } catch (e) {
    return (e as Error).message;
  }
};

describe('PFDEBUG', () => {
  it('ENCODING / TODENSE / GETREG / DECODE', async () => {
    await t.call('PFADD', 'hd:a', 'a', 'b', 'c');
    expect(await t.call('PFDEBUG', 'ENCODING', 'hd:a')).toBe('sparse');
    expect(typeof (await t.call('PFDEBUG', 'DECODE', 'hd:a'))).toBe('string');
    const before = (await t.call('PFDEBUG', 'GETREG', 'hd:a')) as number[];
    expect(before.length).toBe(16384);
    expect(before.filter((r) => r > 0).length).toBe(3);
    expect(await t.call('PFDEBUG', 'ENCODING', 'hd:a')).toBe('dense'); // GETREG converts to dense
    expect(await t.call('PFDEBUG', 'TODENSE', 'hd:a')).toBe(0);
    await t.call('PFADD', 'hd:b', 'x');
    expect(await t.call('PFDEBUG', 'todense', 'hd:b')).toBe(1);
    expect(await t.call('PFDEBUG', 'encoding', 'hd:b')).toBe('dense');
    expect(await t.call('PFCOUNT', 'hd:b')).toBe(1);
    expect(await t.call('PFCOUNT', 'hd:a')).toBe(3);
  });

  it('DECODE of a single-element HLL', async () => {
    await t.call('PFADD', 'hd:one', 'a');
    // 'a' hashes to register 12711 with run length 2 (MurmurHash64A, seed 0xadc83b19).
    expect(await t.call('PFDEBUG', 'DECODE', 'hd:one')).toBe('Z:12711 v:2,1 Z:3672');
    await t.call('PFADD', 'hd:none');
    expect(await t.call('PFDEBUG', 'DECODE', 'hd:none')).toBe('Z:16384');
  });

  it('errors', async () => {
    await t.call('PFADD', 'hd:e', 'a');
    await t.call('PFDEBUG', 'TODENSE', 'hd:e');
    expect.soft(await err(t.call('PFDEBUG', 'DECODE', 'hd:e'))).toBe('ERR HLL encoding is not sparse');
    expect.soft(await err(t.call('PFDEBUG', 'GETREG', 'hd:missing'))).toBe('ERR The specified key does not exist');
    expect.soft(await err(t.call('PFDEBUG', 'FOO', 'hd:e'))).toBe("ERR Unknown PFDEBUG subcommand 'FOO'");
    expect.soft(await err(t.call('PFDEBUG', 'GETREG', 'hd:e', 'x'))).toBe("ERR Wrong number of arguments for the 'GETREG' subcommand");
    expect.soft(await err(t.call('PFDEBUG', 'GETREG'))).toBe(arity('pfdebug'));
    await t.call('SET', 'hd:bad', 'nope');
    expect.soft(await err(t.call('PFDEBUG', 'ENCODING', 'hd:bad'))).toBe(HLL_WRONGTYPE);
  });
});
