import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * Geo commands: GEORADIUS, GEORADIUSBYMEMBER (+_RO), GEOSEARCH, GEOSEARCHSTORE (geo.search.service). Expected values come from the redis.io command docs (and their examples) and Redis error
 * strings; anything not certain is marked `// unverified:`.
 */
const t = useServer();

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const SYNTAX = 'ERR syntax error';

/** Resolves to the error message, or to a marker describing the non-error reply. */
const err = async (p: Promise<unknown>): Promise<string> => {
  try {
    return `(no error; reply: ${JSON.stringify(await p)})`;
  } catch (e) {
    return (e as Error).message;
  }
};

async function resp3(): Promise<RawClient> {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}

const PALERMO = [13.361389, 38.115556] as const;

const CATANIA = [15.087269, 37.502669] as const;

const PALERMO_POS = ['13.36138933897018433', '38.11555639549629859'];

const CATANIA_POS = ['15.08726745843887329', '37.50266842333162032'];

async function sicily(key: string): Promise<void> {
  await t.call('GEOADD', key, ...PALERMO, 'Palermo', ...CATANIA, 'Catania');
}

describe('GEORADIUS / GEORADIUSBYMEMBER (+_RO)', () => {
  it('GEORADIUS docs examples', async () => {
    await sicily('gr:doc');
    expect(await t.call('GEORADIUS', 'gr:doc', 15, 37, 200, 'km', 'WITHDIST')).toEqual([['Palermo', '190.4424'], ['Catania', '56.4413']]);
    expect(await t.call('GEORADIUS', 'gr:doc', 15, 37, 200, 'km', 'WITHCOORD')).toEqual([['Palermo', PALERMO_POS], ['Catania', CATANIA_POS]]);
    expect(await t.call('GEORADIUS', 'gr:doc', 15, 37, 200, 'km', 'WITHDIST', 'WITHCOORD')).toEqual([
      ['Palermo', '190.4424', PALERMO_POS],
      ['Catania', '56.4413', CATANIA_POS],
    ]);
  });

  it('ASC / DESC / COUNT / ANY / WITHHASH', async () => {
    await sicily('gr:opt');
    expect(await t.call('GEORADIUS', 'gr:opt', 15, 37, 200, 'km', 'ASC')).toEqual(['Catania', 'Palermo']);
    expect(await t.call('GEORADIUS', 'gr:opt', 15, 37, 200, 'km', 'DESC')).toEqual(['Palermo', 'Catania']);
    expect(await t.call('GEORADIUS', 'gr:opt', 15, 37, 200, 'km', 'COUNT', 1)).toEqual(['Catania']);
    expect(await t.call('GEORADIUS', 'gr:opt', 15, 37, 200, 'km', 'COUNT', 1, 'DESC')).toEqual(['Palermo']);
    expect(((await t.call('GEORADIUS', 'gr:opt', 15, 37, 200, 'km', 'COUNT', 1, 'ANY')) as string[]).length).toBe(1);
    expect(await t.call('GEORADIUS', 'gr:opt', 15, 37, 200, 'km', 'WITHHASH', 'ASC')).toEqual([
      ['Catania', 3479447370796909],
      ['Palermo', 3479099956230698],
    ]);
    expect(await t.call('GEORADIUS', 'gr:opt', 15, 37, 200000, 'm', 'ASC')).toEqual(['Catania', 'Palermo']);
    expect(await t.call('GEORADIUS', 'gr:opt', 15, 37, 1, 'km')).toEqual([]);
    expect(await t.call('GEORADIUS', 'gr:missing', 15, 37, 200, 'km')).toEqual([]);
  });

  it('GEORADIUSBYMEMBER docs example', async () => {
    await t.call('GEOADD', 'grm:doc', 13.583333, 37.316667, 'Agrigento');
    await t.call('GEOADD', 'grm:doc', ...PALERMO, 'Palermo', ...CATANIA, 'Catania');
    expect([...((await t.call('GEORADIUSBYMEMBER', 'grm:doc', 'Agrigento', 100, 'km')) as string[])].sort()).toEqual(['Agrigento', 'Palermo']);
    expect(await t.call('GEORADIUSBYMEMBER', 'grm:doc', 'Agrigento', 100, 'km', 'ASC')).toEqual(['Agrigento', 'Palermo']);
    const withDist = (await t.call('GEORADIUSBYMEMBER', 'grm:doc', 'Palermo', 200, 'km', 'ASC', 'WITHDIST')) as Array<[string, string]>;
    expect(withDist.map((e) => e[0])).toEqual(['Palermo', 'Agrigento', 'Catania']);
    expect(withDist[0]![1]).toBe('0.0000');
    expect(withDist[2]![1]).toBe('166.2742');
    expect.soft(await err(t.call('GEORADIUSBYMEMBER', 'grm:doc', 'Nope', 100, 'km'))).toBe('ERR could not decode requested zset member');
  });

  it('_RO variants', async () => {
    await sicily('gro:doc');
    expect(await t.call('GEORADIUS_RO', 'gro:doc', 15, 37, 200, 'km', 'ASC')).toEqual(['Catania', 'Palermo']);
    expect(await t.call('GEORADIUSBYMEMBER_RO', 'gro:doc', 'Palermo', 200, 'km', 'ASC', 'WITHDIST')).toEqual([['Palermo', '0.0000'], ['Catania', '166.2742']]);
    // unverified: exact error text; _RO variants reject STORE
    await expect(t.call('GEORADIUS_RO', 'gro:doc', 15, 37, 200, 'km', 'STORE', 'gro:dst')).rejects.toThrow();
    expect(await t.call('EXISTS', 'gro:dst')).toBe(0);
  });

  it('STORE / STOREDIST', async () => {
    await sicily('grs:src');
    expect(await t.call('GEORADIUS', 'grs:src', 15, 37, 200, 'km', 'STORE', 'grs:dst')).toBe(2);
    expect(await t.call('ZRANGE', 'grs:dst', 0, -1, 'WITHSCORES')).toEqual(['Palermo', '3479099956230698', 'Catania', '3479447370796909']);
    expect(await t.call('GEORADIUS', 'grs:src', 15, 37, 200, 'km', 'STOREDIST', 'grs:dist', 'ASC', 'COUNT', 1)).toBe(1);
    const dist = Number(await t.call('ZSCORE', 'grs:dist', 'Catania'));
    expect(dist).toBeCloseTo(56.4413, 3);
    expect(await t.call('GEORADIUSBYMEMBER', 'grs:src', 'Palermo', 200, 'km', 'STOREDIST', 'grs:dist2')).toBe(2);
    expect(Number(await t.call('ZSCORE', 'grs:dist2', 'Palermo'))).toBe(0);
    expect(Number(await t.call('ZSCORE', 'grs:dist2', 'Catania'))).toBeCloseTo(166.2742, 3);
    expect(await t.call('GEORADIUS', 'grs:src', 15, 37, 1, 'km', 'STORE', 'grs:dist2')).toBe(0);
    expect(await t.call('EXISTS', 'grs:dist2')).toBe(0);
  });

  it('errors', async () => {
    await sicily('gr:e');
    expect.soft(await err(t.call('GEORADIUS', 'gr:e', 15, 37, 200, 'km', 'WITHDIST', 'STORE', 'x'))).toBe('ERR STORE option in GEORADIUS is not compatible with WITHDIST, WITHHASH and WITHCOORD options');
    expect.soft(await err(t.call('GEORADIUS', 'gr:e', 15, 37, 200, 'km', 'ANY'))).toBe('ERR the ANY argument requires COUNT argument');
    expect.soft(await err(t.call('GEORADIUS', 'gr:e', 15, 37, 200, 'km', 'COUNT', 0))).toBe('ERR COUNT must be > 0');
    expect.soft(await err(t.call('GEORADIUS', 'gr:e', 15, 37, 200, 'km', 'COUNT'))).toBe(SYNTAX);
    expect.soft(await err(t.call('GEORADIUS', 'gr:e', 15, 37, 200, 'km', 'FOO'))).toBe(SYNTAX);
    expect.soft(await err(t.call('GEORADIUS', 'gr:e', 15, 37, 200, 'yards'))).toBe('ERR unsupported unit provided. please use M, KM, FT, MI');
    expect.soft(await err(t.call('GEORADIUS', 'gr:e', 15, 37, -1, 'km'))).toBe('ERR radius cannot be negative');
    expect.soft(await err(t.call('GEORADIUS', 'gr:e', 200, 100, 10, 'km'))).toBe('ERR invalid longitude,latitude pair 200.000000,100.000000');
    expect.soft(await err(t.call('GEORADIUS', 'gr:e', 15, 37, 200))).toBe(arity('georadius'));
    await t.call('SET', 'gr:str', 'x');
    expect.soft(await err(t.call('GEORADIUS', 'gr:str', 15, 37, 200, 'km'))).toBe(WRONGTYPE);
  });
});

describe('GEOSEARCH / GEOSEARCHSTORE', () => {
  async function docSicily(key: string): Promise<void> {
    await sicily(key);
    await t.call('GEOADD', key, 12.758489, 38.788135, 'edge1', 17.24151, 38.788135, 'edge2');
  }

  it('GEOSEARCH docs examples', async () => {
    await sicily('gs:doc');
    expect(await t.call('GEOADD', 'gs:doc', 12.758489, 38.788135, 'edge1', 17.24151, 38.788135, 'edge2')).toBe(2);
    expect(await t.call('GEOSEARCH', 'gs:doc', 'FROMLONLAT', 15, 37, 'BYRADIUS', 200, 'km', 'ASC')).toEqual(['Catania', 'Palermo']);
    expect(await t.call('GEOSEARCH', 'gs:doc', 'FROMLONLAT', 15, 37, 'BYBOX', 400, 400, 'km', 'ASC', 'WITHCOORD', 'WITHDIST')).toEqual([
      ['Catania', '56.4413', CATANIA_POS],
      ['Palermo', '190.4424', PALERMO_POS],
      ['edge2', '279.7403', ['17.24151045083999634', '38.78813451624225195']],
      ['edge1', '279.7405', ['12.7584877610206604', '38.78813451624225195']],
    ]);
  });

  it('FROMMEMBER, DESC, COUNT, ANY, WITHHASH', async () => {
    await sicily('gs:opt0');
    expect(await t.call('GEOSEARCH', 'gs:opt0', 'FROMMEMBER', 'Palermo', 'BYRADIUS', 200, 'km', 'ASC', 'WITHDIST')).toEqual([['Palermo', '0.0000'], ['Catania', '166.2742']]);
    await docSicily('gs:opt');
    expect(await t.call('GEOSEARCH', 'gs:opt', 'FROMLONLAT', 15, 37, 'BYBOX', 400, 400, 'km', 'DESC')).toEqual(['edge1', 'edge2', 'Palermo', 'Catania']);
    expect(await t.call('GEOSEARCH', 'gs:opt', 'FROMLONLAT', 15, 37, 'BYBOX', 400, 400, 'km', 'ASC', 'COUNT', 2)).toEqual(['Catania', 'Palermo']);
    expect(await t.call('GEOSEARCH', 'gs:opt', 'FROMLONLAT', 15, 37, 'BYBOX', 400, 400, 'km', 'COUNT', 1, 'DESC')).toEqual(['edge1']);
    expect(((await t.call('GEOSEARCH', 'gs:opt', 'FROMLONLAT', 15, 37, 'BYBOX', 400, 400, 'km', 'COUNT', 2, 'ANY')) as string[]).length).toBe(2);
    expect(await t.call('GEOSEARCH', 'gs:opt', 'FROMLONLAT', 15, 37, 'BYBOX', 400, 400, 'km', 'ASC', 'COUNT', 3, 'WITHHASH')).toEqual([
      ['Catania', 3479447370796909],
      ['Palermo', 3479099956230698],
      ['edge2', 3481342659049484],
    ]);
    expect(await t.call('GEOSEARCH', 'gs:opt', 'FROMLONLAT', 15, 37, 'BYRADIUS', 1, 'm')).toEqual([]);
    expect(await t.call('GEOSEARCH', 'gs:missing', 'FROMLONLAT', 15, 37, 'BYRADIUS', 1, 'km')).toEqual([]);
    // Box narrower than Palermo's longitude offset excludes it even though it is within radius.
    expect(await t.call('GEOSEARCH', 'gs:opt', 'FROMLONLAT', 15, 37, 'BYBOX', 200, 400, 'km', 'ASC')).toEqual(['Catania']);
  });

  it('GEOSEARCHSTORE docs examples', async () => {
    await docSicily('gss:src');
    expect(await t.call('GEOSEARCHSTORE', 'gss:key1', 'gss:src', 'FROMLONLAT', 15, 37, 'BYBOX', 400, 400, 'km', 'ASC', 'COUNT', 3)).toBe(3);
    expect(await t.call('GEOSEARCH', 'gss:key1', 'FROMLONLAT', 15, 37, 'BYBOX', 400, 400, 'km', 'ASC', 'WITHCOORD', 'WITHDIST', 'WITHHASH')).toEqual([
      ['Catania', '56.4413', 3479447370796909, CATANIA_POS],
      ['Palermo', '190.4424', 3479099956230698, PALERMO_POS],
      ['edge2', '279.7403', 3481342659049484, ['17.24151045083999634', '38.78813451624225195']],
    ]);
    expect(await t.call('GEOSEARCHSTORE', 'gss:key2', 'gss:src', 'FROMLONLAT', 15, 37, 'BYBOX', 400, 400, 'km', 'ASC', 'COUNT', 3, 'STOREDIST')).toBe(3);
    // unverified: the docs print 56.441257870158204 / 190.44242984775784 / 279.7403417843143; the last
    // digits depend on the exact distance arithmetic, so only the leading digits are asserted.
    const stored = (await t.call('ZRANGE', 'gss:key2', 0, -1, 'WITHSCORES')) as string[];
    expect(stored.filter((_, i) => i % 2 === 0)).toEqual(['Catania', 'Palermo', 'edge2']);
    expect(Number(stored[1])).toBeCloseTo(56.441257870158204, 9);
    expect(Number(stored[3])).toBeCloseTo(190.44242984775784, 9);
    expect(Number(stored[5])).toBeCloseTo(279.7403417843143, 9);
  });

  it('GEOSEARCHSTORE with no match deletes the destination', async () => {
    await sicily('gss:src2');
    await t.call('SET', 'gss:dst', 'x');
    expect(await t.call('GEOSEARCHSTORE', 'gss:dst', 'gss:src2', 'FROMLONLAT', 0, 0, 'BYRADIUS', 1, 'km')).toBe(0);
    expect(await t.call('EXISTS', 'gss:dst')).toBe(0);
    await t.call('SET', 'gss:dst2', 'x');
    expect(await t.call('GEOSEARCHSTORE', 'gss:dst2', 'gss:nosrc', 'FROMLONLAT', 0, 0, 'BYRADIUS', 1, 'km')).toBe(0);
    expect(await t.call('EXISTS', 'gss:dst2')).toBe(0);
  });

  it('errors', async () => {
    await sicily('gs:e');
    const k = 'gs:e';
    expect.soft(await err(t.call('GEOSEARCH', k, 'BYRADIUS', 10, 'km', 'ASC', 'WITHDIST'))).toBe('ERR exactly one of FROMMEMBER or FROMLONLAT can be specified for GEOSEARCH');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMMEMBER', 'Palermo', 'FROMLONLAT', 15, 37, 'BYRADIUS', 10, 'km'))).toBe('ERR exactly one of FROMMEMBER or FROMLONLAT can be specified for GEOSEARCH');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 15, 37, 'ASC', 'WITHDIST'))).toBe('ERR exactly one of BYRADIUS and BYBOX can be specified for GEOSEARCH');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 15, 37, 'BYRADIUS', 10, 'km', 'BYBOX', 1, 1, 'km'))).toBe('ERR exactly one of BYRADIUS and BYBOX can be specified for GEOSEARCH');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 15, 37, 'BYRADIUS', 10, 'km', 'ANY'))).toBe('ERR the ANY argument requires COUNT argument');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 15, 37, 'BYRADIUS', 10, 'km', 'COUNT', 0))).toBe('ERR COUNT must be > 0');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMMEMBER', 'Nope', 'BYRADIUS', 10, 'km'))).toBe('ERR could not decode requested zset member');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 200, 100, 'BYRADIUS', 10, 'km'))).toBe('ERR invalid longitude,latitude pair 200.000000,100.000000');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 15, 37, 'BYRADIUS', 10, 'yards'))).toBe('ERR unsupported unit provided. please use M, KM, FT, MI');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 15, 37, 'BYRADIUS', -1, 'km'))).toBe('ERR radius cannot be negative');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 15, 37, 'BYBOX', -1, 1, 'km'))).toBe('ERR height or width cannot be negative');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 15, 37, 'BYRADIUS', 10, 'km', 'STORE', 'x'))).toBe(SYNTAX);
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 15, 37, 'BYRADIUS', 10, 'km', 'FOO'))).toBe(SYNTAX);
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 15, 37, 'BYRADIUS', 10, 'km', 'STOREDIST'))).toBe(SYNTAX);
    expect.soft(await err(t.call('GEOSEARCHSTORE', 'gs:d', k, 'FROMLONLAT', 15, 37, 'BYRADIUS', 10, 'km', 'WITHDIST'))).toBe('ERR GEOSEARCHSTORE is not compatible with WITHDIST, WITHHASH and WITHCOORD options');
    expect.soft(await err(t.call('GEOSEARCH', k, 'FROMLONLAT', 15))).toBe(arity('geosearch')); // unverified: GEOSEARCH arity is -7
    await t.call('SET', 'gs:str', 'x');
    expect.soft(await err(t.call('GEOSEARCH', 'gs:str', 'FROMLONLAT', 15, 37, 'BYRADIUS', 10, 'km'))).toBe(WRONGTYPE);
  });

  it('RESP3: distance is a bulk string, hash an integer', async () => {
    await sicily('gs:r3');
    const r = await resp3();
    expect.soft(await r.send('GEOSEARCH', 'gs:r3', 'FROMLONLAT', 15, 37, 'BYRADIUS', 100, 'km', 'WITHDIST', 'WITHHASH')).toBe('*1\r\n*3\r\n$7\r\nCatania\r\n$7\r\n56.4413\r\n:3479447370796909\r\n');
  });
});
