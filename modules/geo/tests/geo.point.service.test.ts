import { describe, expect, it } from 'vitest';

import { useServer } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * Geo commands: GEOADD, GEOPOS, GEODIST, GEOHASH (geo.point.service). Expected values come from the redis.io command docs (and their examples) and Redis error
 * strings; anything not certain is marked `// unverified:`.
 */
const t = useServer();

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

const SYNTAX = 'ERR syntax error';

const NOT_FLOAT = 'ERR value is not a valid float';

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

describe('GEOADD', () => {
  it('docs example', async () => {
    expect(await t.call('GEOADD', 'ga:doc', ...PALERMO, 'Palermo', ...CATANIA, 'Catania')).toBe(2);
    expect(await t.call('GEODIST', 'ga:doc', 'Palermo', 'Catania')).toBe('166274.1516');
    expect(await t.call('GEORADIUS', 'ga:doc', 15, 37, 100, 'km')).toEqual(['Catania']);
    expect(await t.call('GEORADIUS', 'ga:doc', 15, 37, 200, 'km')).toEqual(['Palermo', 'Catania']);
    expect(await t.call('ZSCORE', 'ga:doc', 'Palermo')).toBe('3479099956230698');
    expect(await t.call('ZSCORE', 'ga:doc', 'Catania')).toBe('3479447370796909');
  });

  it('NX / XX / CH', async () => {
    await sicily('ga:opt');
    expect(await t.call('GEOADD', 'ga:opt', 'NX', 13, 38, 'Palermo', 14, 37, 'New')).toBe(1);
    expect(await t.call('GEOPOS', 'ga:opt', 'Palermo')).toEqual([PALERMO_POS]);
    expect(await t.call('GEOADD', 'ga:opt', 'XX', 13, 38, 'Palermo', 14, 37, 'Other')).toBe(0);
    expect(await t.call('ZSCORE', 'ga:opt', 'Other')).toBeNull();
    expect(await t.call('GEOADD', 'ga:opt', 'CH', ...PALERMO, 'Palermo')).toBe(1);
    expect(await t.call('GEOADD', 'ga:opt', 'CH', ...PALERMO, 'Palermo')).toBe(0);
    expect(await t.call('GEOADD', 'ga:opt', 'XX', 'CH', 15, 37, 'Palermo')).toBe(1);
    expect(await t.call('GEOADD', 'ga:opt', ...CATANIA, 'Catania')).toBe(0);
  });

  it('invalid coordinates and syntax errors', async () => {
    expect.soft(await err(t.call('GEOADD', 'ga:e', 200, 100, 'x'))).toBe('ERR invalid longitude,latitude pair 200.000000,100.000000');
    expect.soft(await err(t.call('GEOADD', 'ga:e', 13, 86, 'x'))).toBe('ERR invalid longitude,latitude pair 13.000000,86.000000');
    expect.soft(await err(t.call('GEOADD', 'ga:e', -180.5, 0, 'x'))).toBe('ERR invalid longitude,latitude pair -180.500000,0.000000');
    expect.soft(await err(t.call('GEOADD', 'ga:e', 'abc', 0, 'x'))).toBe(NOT_FLOAT);
    expect.soft(await err(t.call('GEOADD', 'ga:e', 1, 2, 'x', 3))).toBe(SYNTAX);
    expect.soft(await err(t.call('GEOADD', 'ga:e', 'NX', 'XX', 1, 2, 'x'))).toBe(SYNTAX);
    expect.soft(await err(t.call('GEOADD', 'ga:e', 1, 2))).toBe(arity('geoadd'));
    expect(await t.call('EXISTS', 'ga:e')).toBe(0);
    await t.call('SET', 'ga:str', 'x');
    expect.soft(await err(t.call('GEOADD', 'ga:str', 1, 2, 'x'))).toBe(WRONGTYPE);
  });
});

describe('GEOPOS / GEODIST / GEOHASH', () => {
  it('GEOPOS docs example', async () => {
    await sicily('gp:doc');
    expect(await t.call('GEOPOS', 'gp:doc', 'Palermo', 'Catania', 'NonExisting')).toEqual([PALERMO_POS, CATANIA_POS, null]);
    expect(await t.call('GEOPOS', 'gp:missing', 'a', 'b')).toEqual([null, null]);
    expect(await t.call('GEOPOS', 'gp:doc')).toEqual([]);
    expect.soft(await err(t.call('GEOPOS'))).toBe(arity('geopos'));
    await t.call('SET', 'gp:str', 'x');
    expect.soft(await err(t.call('GEOPOS', 'gp:str', 'a'))).toBe(WRONGTYPE);
  });

  it('GEOPOS wire shapes', async () => {
    await sicily('gp:wire');
    const r = await t.raw();
    expect.soft(await r.send('GEOPOS', 'gp:wire', 'Palermo', 'x')).toBe('*2\r\n*2\r\n$20\r\n13.36138933897018433\r\n$20\r\n38.11555639549629859\r\n*-1\r\n');
    const r3 = await resp3();
    // unverified: RESP3 coordinates via addReplyHumanLongDouble are doubles
    expect.soft(await r3.send('GEOPOS', 'gp:wire', 'Palermo', 'x')).toBe('*2\r\n*2\r\n,13.36138933897018433\r\n,38.11555639549629859\r\n_\r\n');
  });

  it('GEODIST docs example and units', async () => {
    await sicily('gd:doc');
    expect(await t.call('GEODIST', 'gd:doc', 'Palermo', 'Catania')).toBe('166274.1516');
    expect(await t.call('GEODIST', 'gd:doc', 'Palermo', 'Catania', 'km')).toBe('166.2742');
    expect(await t.call('GEODIST', 'gd:doc', 'Palermo', 'Catania', 'mi')).toBe('103.3182');
    expect(await t.call('GEODIST', 'gd:doc', 'Palermo', 'Catania', 'M')).toBe('166274.1516');
    expect(await t.call('GEODIST', 'gd:doc', 'Palermo', 'Catania', 'KM')).toBe('166.2742');
    expect(await t.call('GEODIST', 'gd:doc', 'Palermo', 'Palermo')).toBe('0.0000');
    expect(await t.call('GEODIST', 'gd:doc', 'Foo', 'Bar')).toBeNull();
    expect(await t.call('GEODIST', 'gd:doc', 'Palermo', 'Bar')).toBeNull();
    expect(await t.call('GEODIST', 'gd:missing', 'a', 'b')).toBeNull();
  });

  it('GEODIST errors and RESP3', async () => {
    await sicily('gd:e');
    expect.soft(await err(t.call('GEODIST', 'gd:e', 'Palermo', 'Catania', 'yards'))).toBe('ERR unsupported unit provided. please use M, KM, FT, MI');
    expect.soft(await err(t.call('GEODIST', 'gd:e', 'Palermo', 'Catania', 'km', 'x'))).toBe(SYNTAX);
    expect.soft(await err(t.call('GEODIST', 'gd:e', 'Palermo'))).toBe(arity('geodist'));
    await t.call('SET', 'gd:str', 'x');
    expect.soft(await err(t.call('GEODIST', 'gd:str', 'a', 'b'))).toBe(WRONGTYPE);
    const r3 = await resp3();
    expect.soft(await r3.send('GEODIST', 'gd:e', 'Palermo', 'Catania', 'km')).toBe('$8\r\n166.2742\r\n');
    expect.soft(await r3.send('GEODIST', 'gd:e', 'Palermo', 'Nope')).toBe('_\r\n');
  });

  it('GEOHASH docs example', async () => {
    await sicily('gh:doc');
    expect(await t.call('GEOHASH', 'gh:doc', 'Palermo', 'Catania')).toEqual(['sqc8b49rny0', 'sqdtr74hyu0']);
    expect(await t.call('GEOHASH', 'gh:doc', 'Palermo', 'Nope')).toEqual(['sqc8b49rny0', null]);
    expect(await t.call('GEOHASH', 'gh:missing', 'a')).toEqual([null]);
    expect(await t.call('GEOHASH', 'gh:doc')).toEqual([]);
    expect.soft(await err(t.call('GEOHASH'))).toBe(arity('geohash'));
    await t.call('SET', 'gh:str', 'x');
    expect.soft(await err(t.call('GEOHASH', 'gh:str', 'a'))).toBe(WRONGTYPE);
  });
});
