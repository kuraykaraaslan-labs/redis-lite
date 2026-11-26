import { differential, s, v } from './differential.harness';

/** 7.2 added the plain listpack encoding for small lists; 7.0 reports every list as quicklist. */
const LISTPACK = v('lists encoded as plain listpack (OBJECT ENCODING listpack) since 7.2; 7.0 always says quicklist');

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
  s('LPOS RANK of the minimum integer', ['RPUSH l a', 'LPOS l a RANK -9223372036854775808'], v('7.2 range-checks RANK to -LONG_MAX..LONG_MAX (LLONG_MIN negation overflow fix); 7.0 accepts it', 'low')),
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
  s('small list encoding', ['RPUSH l a b', 'OBJECT ENCODING l'], LISTPACK),
  s('long list encoding', [LONG, 'OBJECT ENCODING long', 'LINDEX long 150', 'LRANGE long 120 130', 'LPOS long e199', 'LLEN long'], LISTPACK),
  s('long list reads', [LONG, 'LINDEX long 150', 'LRANGE long 120 130', 'LPOS long e199', 'LLEN long']),
  s('big element encoding', [`RPUSH l ${'x'.repeat(10000)}`, 'OBJECT ENCODING l', 'LLEN l']),
  s('long list operations across nodes', [LONG, 'LINSERT long AFTER e100 mid', 'LREM long 1 e50', 'LSET long 10 ten', 'LTRIM long 5 -5', 'LRANGE long 0 7', 'LLEN long']),
]);
