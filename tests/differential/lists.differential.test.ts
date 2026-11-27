import { differential, s } from './differential.harness';
import { debugObject } from './differential.normalizers';
import { intProbes } from './differential.probes';

/** Redis 7.0 reports every list as quicklist: DEBUG OBJECT shows the node layout (ql_*) and DUMP the nodes themselves. */
const ql = { cmd: 'DEBUG OBJECT l', norm: debugObject };

/** 200 elements: past the 128-entry listpack limit of small lists. */
const LONG = ['RPUSH long', ...Array.from({ length: 200 }, (_, i) => `e${i}`)].join(' ');

differential('lists', [
  // push
  s('LPUSH and RPUSH order and counts', ['LPUSH l a b c', 'RPUSH l x y', 'LRANGE l 0 -1', 'LLEN l']),
  s('LPUSHX and RPUSHX on missing and present key', ['LPUSHX l a', 'RPUSHX l a', 'EXISTS l', 'RPUSH l x', 'LPUSHX l a b', 'RPUSHX l c', 'LRANGE l 0 -1']),
  s('push arity errors', ['LPUSH l', 'RPUSH l', 'LPUSHX l', 'RPUSHX l', 'LPUSH']),
  s('push empty and binary elements', ['RPUSH l "" "\\x00" "a b"', 'LRANGE l 0 -1', 'LLEN l']),
  s('list commands against a string key', [
    'SET k v', 'LPUSH k a', 'RPUSH k a', 'LPUSHX k a', 'LPOP k', 'RPOP k', 'LLEN k', 'LRANGE k 0 -1', 'LINDEX k 0', 'LSET k 0 a',
    'LINSERT k BEFORE a b', 'LREM k 0 a', 'LTRIM k 0 1', 'LPOS k a', 'LMOVE k k LEFT LEFT', 'RPOPLPUSH k x', 'LMPOP 1 k LEFT',
  ]),
  s('LMOVE into a string destination', ['RPUSH l a', 'SET k v', 'LMOVE l k LEFT LEFT', 'RPOPLPUSH l k', 'LRANGE l 0 -1']),

  // LPOP / RPOP
  s('LPOP RPOP single elements', ['RPUSH l a b c', 'LPOP l', 'RPOP l', 'LPOP l', 'LPOP l', 'RPOP l', 'EXISTS l']),
  s('LPOP RPOP with count', ['RPUSH l a b c d e', 'LPOP l 2', 'RPOP l 2', 'LPOP l 10', 'EXISTS l']),
  s('LPOP count zero', ['RPUSH l a', 'LPOP l 0', 'RPOP l 0', 'LLEN l']),
  s('LPOP count on missing key', ['LPOP nokey 2', 'RPOP nokey 2', 'LPOP nokey 0', 'LPOP nokey']),
  s('LPOP negative and invalid count', ['RPUSH l a', 'LPOP l -1', 'RPOP l -5', 'LPOP l x', 'LPOP l 1.5', 'LPOP l 1 2', 'LPOP nokey -1']),

  // LRANGE / LINDEX / LLEN
  s('LRANGE index signs and out of range', [
    'RPUSH l a b c d e', 'LRANGE l 1 3', 'LRANGE l -2 -1', 'LRANGE l -100 1', 'LRANGE l 3 1', 'LRANGE l 5 10', 'LRANGE l 0 100',
    'LRANGE l -1 -5', 'LRANGE nokey 0 -1',
  ]),
  s('LRANGE invalid indices', ['RPUSH l a', 'LRANGE l a 1', 'LRANGE l 0 1.5', 'LRANGE l 0', 'LRANGE l 0 99999999999999999999']),
  s('LINDEX positive negative out of range', ['RPUSH l a b c', 'LINDEX l 0', 'LINDEX l -1', 'LINDEX l 3', 'LINDEX l -4', 'LINDEX nokey 0', 'LINDEX l x', 'LINDEX l']),
  s('LLEN errors', ['LLEN nokey', 'LLEN', 'LLEN a b']),

  // LSET
  s('LSET valid and out of range', ['RPUSH l a b c', 'LSET l 0 x', 'LSET l -1 z', 'LSET l 3 q', 'LSET l -4 q', 'LRANGE l 0 -1']),
  s('LSET missing key and bad index', ['LSET nokey 0 a', 'RPUSH l a', 'LSET l x a', 'LSET l 0', 'LSET l 0 a b']),

  // LINSERT
  s('LINSERT BEFORE and AFTER', ['RPUSH l a b c', 'LINSERT l BEFORE b x', 'LINSERT l AFTER c y', 'LINSERT l after a z', 'LRANGE l 0 -1']),
  s('LINSERT missing pivot and missing key', ['RPUSH l a', 'LINSERT l BEFORE q x', 'LINSERT nokey BEFORE a x', 'EXISTS nokey']),
  s('LINSERT syntax errors', ['RPUSH l a', 'LINSERT l MIDDLE a x', 'LINSERT l BEFORE a', 'LINSERT l BEFORE a x y']),
  s('LINSERT pivot is first match', ['RPUSH l a b a', 'LINSERT l AFTER a x', 'LRANGE l 0 -1']),

  // LREM
  s('LREM positive count from head', ['RPUSH l a b a c a', 'LREM l 2 a', 'LRANGE l 0 -1']),
  s('LREM negative count from tail', ['RPUSH l a b a c a', 'LREM l -2 a', 'LRANGE l 0 -1']),
  s('LREM zero removes all', ['RPUSH l a b a', 'LREM l 0 a', 'LRANGE l 0 -1', 'LREM l 0 b', 'EXISTS l']),
  s('LREM errors and missing', ['LREM nokey 0 a', 'RPUSH l a', 'LREM l x a', 'LREM l 0', 'LREM l 0 zz']),

  // LTRIM
  s('LTRIM ranges', ['RPUSH l a b c d e', 'LTRIM l 1 -2', 'LRANGE l 0 -1', 'LTRIM l -2 100', 'LRANGE l 0 -1']),
  s('LTRIM empty range deletes key', ['RPUSH l a b', 'LTRIM l 5 10', 'EXISTS l', 'RPUSH m a b', 'LTRIM m 1 0', 'EXISTS m']),
  s('LTRIM errors', ['LTRIM nokey 0 1', 'RPUSH l a', 'LTRIM l a 1', 'LTRIM l 0', 'LTRIM l 0 1 2']),

  // LPOS
  s('LPOS basic, RANK and COUNT', [
    'RPUSH l a b c a b c a', 'LPOS l a', 'LPOS l a RANK 2', 'LPOS l a RANK -1', 'LPOS l a RANK -3', 'LPOS l a RANK 4',
    'LPOS l a COUNT 2', 'LPOS l a COUNT 0', 'LPOS l a COUNT 0 RANK -1', 'LPOS l z', 'LPOS l z COUNT 2', 'LPOS nokey a', 'LPOS nokey a COUNT 1',
  ]),
  s('LPOS MAXLEN limits the scan', ['RPUSH l a b c a', 'LPOS l a MAXLEN 3 COUNT 0', 'LPOS l c MAXLEN 2', 'LPOS l a RANK -1 MAXLEN 1', 'LPOS l a MAXLEN 0 COUNT 0']),
  s('LPOS option errors', [
    'RPUSH l a', 'LPOS l a RANK 0', 'LPOS l a COUNT -1', 'LPOS l a MAXLEN -1', 'LPOS l a RANK x', 'LPOS l a COUNT', 'LPOS l a FOO 1',
    'LPOS l', 'LPOS l a MAXLEN',
  ]),
  s('LPOS RANK of the minimum integer', ['RPUSH l a', 'LPOS l a RANK -9223372036854775808']),
  s('LPOS repeated options last wins', ['RPUSH l a b a', 'LPOS l a RANK 1 RANK 2', 'LPOS l a COUNT 1 COUNT 0']),

  // LMOVE / RPOPLPUSH
  s('LMOVE all directions', [
    'RPUSH src a b c d', 'LMOVE src dst LEFT LEFT', 'LMOVE src dst LEFT RIGHT', 'LMOVE src dst RIGHT LEFT', 'LMOVE src dst RIGHT RIGHT',
    'LRANGE dst 0 -1', 'EXISTS src',
  ]),
  s('LMOVE same list rotates', ['RPUSH l a b c', 'LMOVE l l LEFT RIGHT', 'LRANGE l 0 -1', 'LMOVE l l RIGHT LEFT', 'LRANGE l 0 -1', 'LMOVE l l LEFT LEFT', 'LRANGE l 0 -1']),
  s('RPOPLPUSH same list and missing source', ['RPUSH l a b c', 'RPOPLPUSH l l', 'LRANGE l 0 -1', 'RPOPLPUSH nokey l', 'LMOVE nokey l LEFT LEFT']),
  s('LMOVE syntax errors', ['RPUSH l a', 'LMOVE l d UP LEFT', 'LMOVE l d LEFT', 'LMOVE l d left right', 'LRANGE d 0 -1', 'RPOPLPUSH l']),

  // LMPOP
  s('LMPOP first non-empty key', ['RPUSH b x y z', 'LMPOP 2 a b LEFT', 'LMPOP 2 a b RIGHT COUNT 5', 'LMPOP 2 a b LEFT', 'EXISTS b']),
  s('LMPOP count', ['RPUSH l a b c', 'LMPOP 1 l LEFT COUNT 2', 'LMPOP 1 l RIGHT COUNT 1']),
  s('LMPOP errors', [
    'RPUSH l a', 'LMPOP 0 l LEFT', 'LMPOP -1 l LEFT', 'LMPOP 2 l LEFT', 'LMPOP 1 l UP', 'LMPOP 1 l LEFT COUNT 0', 'LMPOP 1 l LEFT COUNT -1',
    'LMPOP 1 l LEFT COUNT', 'LMPOP 1 l LEFT COUNT 1 COUNT 2', 'LMPOP x l LEFT', 'LMPOP 1', 'LMPOP 1 l LEFT FOO',
  ]),
  s('LMPOP wrong type key among keys', ['SET k v', 'RPUSH l a', 'LMPOP 2 k l LEFT', 'LMPOP 2 nokey l LEFT']),

  // encodings
  s('small list encoding', ['RPUSH l a b', 'OBJECT ENCODING l']),
  s('long list encoding', [LONG, 'OBJECT ENCODING long', 'LINDEX long 150', 'LRANGE long 120 130', 'LPOS long e199', 'LLEN long']),
  s('long list reads', [LONG, 'LINDEX long 150', 'LRANGE long 120 130', 'LPOS long e199', 'LLEN long']),
  s('big element encoding', [`RPUSH l ${'x'.repeat(10000)}`, 'OBJECT ENCODING l', 'LLEN l']),
  s('long list operations across nodes', [LONG, 'LINSERT long AFTER e100 mid', 'LREM long 1 e50', 'LSET long 10 ten', 'LTRIM long 5 -5', 'LRANGE long 0 7', 'LLEN long']),

  // quicklist node layout (DEBUG OBJECT ql_*, MEMORY USAGE, DUMP)
  s('quicklist of a small list', ['RPUSH l a b c', ql, 'MEMORY USAGE l', 'DUMP l']),
  s('quicklist nodes by size, pushed at either end', [
    'RPUSH l ' + Array.from({ length: 1000 }, (_, i) => `item-${i}`).join(' '), ql, 'MEMORY USAGE l',
    'DEL l', 'LPUSH l ' + Array.from({ length: 1000 }, (_, i) => `item-${i}`).join(' '), ql, 'MEMORY USAGE l',
  ]),
  s('quicklist node fill by size class', [
    'CONFIG SET list-max-listpack-size -1', 'RPUSH l ' + Array.from({ length: 300 }, (_, i) => `${i}`.padStart(100, 'x')).join(' '), ql, 'MEMORY USAGE l',
    'DEL l', 'LPUSH l ' + Array.from({ length: 300 }, (_, i) => `${i}`.padStart(62, 'x')).join(' '), ql, 'MEMORY USAGE l',
    'DEL l', 'RPUSH l ' + Array.from({ length: 1000 }, () => '1234567').join(' '), ql,
  ]),
  s('quicklist node fill by count', ['CONFIG SET list-max-listpack-size 5', 'RPUSH l ' + Array.from({ length: 23 }, (_, i) => `${i}`).join(' '), ql, 'MEMORY USAGE l', 'DUMP l']),
  s('a large element takes a listpack node of its own', [`RPUSH l a ${'x'.repeat(9000)} b`, ql, 'MEMORY USAGE l', 'RPUSH l c', ql]),
  s('LINSERT splits a full node and merges neighbours', [
    'CONFIG SET list-max-listpack-size 5', 'RPUSH l 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14', 'LINSERT l BEFORE 7 x', ql, 'DUMP l',
    'LINSERT l BEFORE 7 y', 'LINSERT l AFTER 9 z', 'LINSERT l BEFORE 0 h', 'LINSERT l AFTER 14 t', ql, 'DUMP l',
    'LREM l 0 0', 'LREM l 0 1', 'LREM l 0 2', 'LREM l 0 3', 'LINSERT l AFTER 6 w', ql, 'DUMP l',
  ]),
  s('LINSERT merge by size', [
    'CONFIG SET list-max-listpack-size -1', 'RPUSH l ' + Array.from({ length: 80 }, (_, i) => `${i}`.padStart(100, 'a')).join(' '),
    `LINSERT l BEFORE ${'20'.padStart(100, 'a')} ${'x'.repeat(73)}`, ql, `LINSERT l BEFORE ${'60'.padStart(100, 'a')} ${'y'.repeat(74)}`, ql,
  ]),
  s('pops and trims shrink nodes without merging', [
    'CONFIG SET list-max-listpack-size 4', 'RPUSH l 0 1 2 3 4 5 6 7 8 9', 'LPOP l 3', 'RPOP l', ql, 'LTRIM l 1 -2', ql, 'DUMP l', 'LMPOP 1 l RIGHT COUNT 2', ql,
  ]),
  s('each list keeps the fill it was created with', ['CONFIG SET list-max-listpack-size 5', 'RPUSH l a b c', 'CONFIG SET list-max-listpack-size 2', 'RPUSH l d e f', ql, 'RPUSH m a b c', { cmd: 'DEBUG OBJECT m', norm: debugObject }]),
  s('list-compress-depth compresses interior nodes', [
    'CONFIG SET list-compress-depth 1', 'CONFIG SET list-max-listpack-size 5',
    'RPUSH l ' + Array.from({ length: 23 }, (_, i) => `${i}-`.repeat(20)).join(' '), ql, 'MEMORY USAGE l', 'LINDEX l 12', 'MEMORY USAGE l',
  ]),
  s('COPY and SORT STORE lay lists out', [
    'CONFIG SET list-max-listpack-size 3', 'LPUSH l 1 2 3 4 5 6 7', 'COPY l c', { cmd: 'DEBUG OBJECT c', norm: debugObject }, 'DUMP c',
    'SORT l STORE s', { cmd: 'DEBUG OBJECT s', norm: debugObject }, 'DUMP s', 'CONFIG SET list-compress-depth 2', 'RPOPLPUSH l d', 'LMOVE l e LEFT RIGHT',
    { cmd: 'DEBUG OBJECT d', norm: debugObject }, { cmd: 'DEBUG OBJECT e', norm: debugObject },
  ]),

  // integer arguments at the int64 and int32 edges (see differential.probes)
  ...intProbes('LRANGE start', ['RPUSH l a b c', 'LRANGE l $N 1']),
  ...intProbes('LRANGE stop', ['RPUSH l a b c', 'LRANGE l 0 $N', 'LRANGE l $N $N']),
  ...intProbes('LINDEX', ['RPUSH l a b c', 'LINDEX l $N']),
  ...intProbes('LTRIM start', ['RPUSH l a b c', 'LTRIM l $N -1', 'LRANGE l 0 -1']),
  ...intProbes('LTRIM stop', ['RPUSH l a b c', 'LTRIM l 0 $N', 'LRANGE l 0 -1']),
  ...intProbes('LSET', ['RPUSH l a b c', 'LSET l $N x', 'LRANGE l 0 -1']),
  ...intProbes('LPOS RANK', ['RPUSH l a b a', 'LPOS l a RANK $N']),
  ...intProbes('LPOS COUNT', ['RPUSH l a b a', 'LPOS l a COUNT $N']),
  ...intProbes('LPOS beyond int64', ['RPUSH l a b a', 'LPOS l a COUNT 1$N', 'LPOS l a MAXLEN 1$N', 'LPOS l a RANK 1$N', 'LPOS l a COUNT 18446744073709551615', 'LPOS l a COUNT 18446744073709551616', 'LPOS l a RANK 18446744073709551615', 'LPOS l a MAXLEN 9223372036854775809']),
  ...intProbes('LPOS MAXLEN', ['RPUSH l a b a', 'LPOS l a MAXLEN $N']),
  ...intProbes('LPOP RPOP count', ['RPUSH l a b c', 'LPOP l $N', 'RPUSH l a b c', 'RPOP l $N']),
  ...intProbes('LMPOP numkeys', ['RPUSH l a b c', 'LMPOP $N l LEFT']),
  ...intProbes('LMPOP COUNT', ['RPUSH l a b c', 'LMPOP 1 l LEFT COUNT $N']),
  ...intProbes('BLMPOP numkeys and COUNT', ['RPUSH l a b c', 'BLMPOP 0 $N l LEFT', 'BLMPOP 0 1 l LEFT COUNT $N']),
  ...intProbes('blocking list timeouts', ['RPUSH l a b c d e', 'BLPOP l $N', 'BRPOP l $N', 'BLMPOP $N 1 l LEFT', 'BRPOPLPUSH l d $N', 'BLMOVE l d LEFT LEFT $N']),
  ...intProbes('LREM count', ['RPUSH l a b a', 'LREM l $N a', 'LRANGE l 0 -1']),
]);
