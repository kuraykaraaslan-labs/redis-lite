import { describe, expect, it } from 'vitest';

import { arity, err, NOT_INT, resp3Client, SYNTAX, useServer } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * LCS (strings.lcs.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();
const resp3 = (): Promise<RawClient> => resp3Client(t);

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
