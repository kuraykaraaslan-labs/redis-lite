import { describe, expect, it } from 'vitest';

import {
  encode,
  NULL_ARRAY,
  OK,
  RespBigNumber,
  RespBool,
  RespDouble,
  RespError,
  RespMap,
  RespPairs,
  RespParser,
  RespPush,
  RespSet,
  RespVerbatim,
} from '@/libs/resp';
import type { Reply } from '@/libs/resp';

/** Unit tests of the RESP codec (no server): exact reply bytes in RESP2 and RESP3, and request header parsing. */

const bytes = (reply: Reply, proto: 2 | 3 = 2): string => encode(reply, proto).toString('latin1');

describe('encode: scalars', () => {
  it('bulk strings, binary-safe', () => {
    expect(bytes('')).toBe('$0\r\n\r\n');
    expect(bytes('a\r\nb')).toBe('$4\r\na\r\nb\r\n');
    expect(bytes('\xff\x00é')).toBe('$3\r\n\xff\x00é\r\n');
  });

  it('integers are truncated; bigints are exact', () => {
    expect(bytes(42)).toBe(':42\r\n');
    expect(bytes(-7.9)).toBe(':-7\r\n');
    expect(bytes(-0)).toBe(':0\r\n');
    expect(bytes(9007199254740993n)).toBe(':9007199254740993\r\n');
  });

  it('nulls, status, errors (CR/LF runs become one space)', () => {
    expect(bytes(null)).toBe('$-1\r\n');
    expect(bytes(null, 3)).toBe('_\r\n');
    expect(bytes(NULL_ARRAY)).toBe('*-1\r\n');
    expect(bytes(NULL_ARRAY, 3)).toBe('_\r\n');
    expect(bytes(OK)).toBe('+OK\r\n');
    expect(bytes(new RespError('ERR a\r\n\nb\rc'))).toBe('-ERR a b c\r\n');
  });

  it('RESP3-typed scalars and their RESP2 fallbacks', () => {
    expect(bytes(new RespDouble(1.5))).toBe('$3\r\n1.5\r\n');
    expect(bytes(new RespDouble(1.5), 3)).toBe(',1.5\r\n');
    expect(bytes(new RespDouble(-Infinity), 3)).toBe(',-inf\r\n');
    expect(bytes(new RespDouble(2, '2.00'), 3)).toBe(',2.00\r\n');
    expect(bytes(new RespBool(true))).toBe(':1\r\n');
    expect(bytes(new RespBool(false), 3)).toBe('#f\r\n');
    expect(bytes(new RespBigNumber(-12n))).toBe('$3\r\n-12\r\n');
    expect(bytes(new RespBigNumber(-12n), 3)).toBe('(-12\r\n');
    expect(bytes(new RespVerbatim('hi'))).toBe('$2\r\nhi\r\n');
    expect(bytes(new RespVerbatim('hi'), 3)).toBe('=6\r\ntxt:hi\r\n');
  });
});

describe('encode: aggregates', () => {
  it('arrays, nested', () => {
    expect(bytes([])).toBe('*0\r\n');
    expect(bytes(['a', 1, null, ['b']])).toBe('*4\r\n$1\r\na\r\n:1\r\n$-1\r\n*1\r\n$1\r\nb\r\n');
  });

  it('maps: flat in RESP2, % in RESP3, nested pairs for XREAD-style maps', () => {
    const map = new RespMap([['k', 1], ['l', 'v']]);
    expect(bytes(map)).toBe('*4\r\n$1\r\nk\r\n:1\r\n$1\r\nl\r\n$1\r\nv\r\n');
    expect(bytes(map, 3)).toBe('%2\r\n$1\r\nk\r\n:1\r\n$1\r\nl\r\n$1\r\nv\r\n');
    const nested = new RespMap([['k', 1]], true);
    expect(bytes(nested)).toBe('*1\r\n*2\r\n$1\r\nk\r\n:1\r\n');
    expect(bytes(nested, 3)).toBe('%1\r\n$1\r\nk\r\n:1\r\n');
  });

  it('sets, pushes and pairs', () => {
    expect(bytes(new RespSet(['a']))).toBe('*1\r\n$1\r\na\r\n');
    expect(bytes(new RespSet(['a']), 3)).toBe('~1\r\n$1\r\na\r\n');
    expect(bytes(new RespPush(['m']), 3)).toBe('>1\r\n$1\r\nm\r\n');
    const pairs = new RespPairs([['a', new RespDouble(1)]]);
    expect(bytes(pairs)).toBe('*2\r\n$1\r\na\r\n$1\r\n1\r\n');
    expect(bytes(pairs, 3)).toBe('*1\r\n*2\r\n$1\r\na\r\n,1\r\n');
  });
});

describe('RespParser headers', () => {
  const parse = (text: string): { commands: string[][]; error: string | null } =>
    new RespParser().parse(Buffer.from(text, 'latin1'));

  it('reads multibulk and bulk lengths', () => {
    expect(parse('*2\r\n$3\r\nGET\r\n$1\r\nk\r\n').commands).toEqual([['GET', 'k']]);
    expect(parse('*1\r\n$0\r\n\r\n').commands).toEqual([['']]);
    expect(parse('*0\r\n*-1\r\n*1\r\n$4\r\nPING\r\n').commands).toEqual([['PING']]);
  });

  it('rejects lengths that are not strict integers', () => {
    for (const bad of ['*01\r\n', '*-0\r\n', '*+1\r\n', '* 1\r\n', '*1x\r\n', '*\r\n', '*99999999999999999999\r\n']) {
      expect(parse(bad).error, bad).toBe('Protocol error: invalid multibulk length');
    }
    for (const bad of ['*1\r\n$01\r\n', '*1\r\n$-1\r\n', '*1\r\n$-0\r\n', '*1\r\n$\r\n', '*1\r\n$1a\r\n']) {
      expect(parse(bad).error, bad).toBe('Protocol error: invalid bulk length');
    }
    expect(parse('*3000000000\r\n').error).toBe('Protocol error: invalid multibulk length');
  });

  it('reads long lengths exactly and checks proto-max-bulk-len', () => {
    const parser = new RespParser({ maxBulkLen: () => 4 });
    expect(parser.parse(Buffer.from('*1\r\n$5\r\nhello\r\n')).error).toBe('Protocol error: invalid bulk length');
    expect(new RespParser().parse(Buffer.from('*1\r\n$0000000000000001\r\n')).error).toBe('Protocol error: invalid bulk length');
  });

  it('waits for more bytes when a header or bulk is incomplete', () => {
    const parser = new RespParser();
    expect(parser.parse(Buffer.from('*2\r\n$3\r')).commands).toEqual([]);
    expect(parser.parse(Buffer.from('\nGET\r\n$1')).commands).toEqual([]);
    expect(parser.parse(Buffer.from('\r\nk\r\n')).commands).toEqual([['GET', 'k']]);
  });
});
