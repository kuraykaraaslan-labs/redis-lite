import { differential, s, v } from './differential.harness';
import { shape, sorted } from './differential.normalizers';

/**
 * Sets. Intsets reply in ascending numeric order on every version (compared as is). Small string sets are hashtable
 * encoded on the 7.0 oracle (listpack only since 7.2), so their member order is hash-table order: sorted.
 */
const LISTPACK = v('small non-integer sets are listpack-encoded since 7.2; 7.0 uses hashtable');
/** 600 integers: past set-max-intset-entries (512). */
const BIGINT = ['SADD big', ...Array.from({ length: 600 }, (_, i) => String(i))].join(' ');

differential('sets', [
  // SADD / SREM / SCARD / SISMEMBER / SMISMEMBER
  s('SADD counts new members only', ['SADD s a b c', 'SADD s a d', 'SADD s a a a', 'SCARD s', { cmd: 'SMEMBERS s', norm: sorted }]),
  s('SADD arity', ['SADD s', 'SADD']),
  s('SREM present missing and last member', ['SADD s a b', 'SREM s a x a', 'SREM s b', 'EXISTS s', 'SREM s b', 'SREM nokey a', 'SREM s']),
  s('SCARD and SISMEMBER on missing key', ['SCARD nokey', 'SISMEMBER nokey a', 'SADD s a', 'SISMEMBER s a', 'SISMEMBER s b', 'SISMEMBER s', 'SCARD']),
  s('SMISMEMBER mixes results', ['SADD s a 1', 'SMISMEMBER s a b 1 2', 'SMISMEMBER nokey a b', 'SMISMEMBER s']),
  s('set commands against a string key', [
    'SET k v', 'SADD k a', 'SREM k a', 'SCARD k', 'SISMEMBER k a', 'SMISMEMBER k a', 'SMEMBERS k', 'SPOP k', 'SRANDMEMBER k',
    'SINTER k', 'SUNION k', 'SDIFF k', 'SINTERCARD 1 k', 'SMOVE k s a', 'SSCAN k 0',
  ]),
  s('SINTER and SUNION with one wrong type key', ['SADD s a', 'SET k v', 'SINTER s k', 'SUNION s k', 'SDIFF s k', 'SINTERSTORE d s k', 'SINTER nokey k']),

  // SMEMBERS ordering
  s('SMEMBERS of an intset is numerically ordered', ['SADD s 10 -5 3 100 0', 'SMEMBERS s', 'OBJECT ENCODING s']),
  s('SMEMBERS of string set', ['SADD s b a c', { cmd: 'SMEMBERS s', norm: sorted }, 'SMEMBERS nokey']),
  s('intset with 64-bit values', ['SADD s 9223372036854775807 -9223372036854775808 0', 'SMEMBERS s', 'OBJECT ENCODING s', 'SISMEMBER s -9223372036854775808']),
  s('non-canonical integers are strings', ['SADD s 1 01 +1 " 1" 1.0', 'SCARD s', { cmd: 'SMEMBERS s', norm: sorted }]),

  // encodings
  s('intset converts on a string member', ['SADD s 1 2 3', 'SADD s x', 'OBJECT ENCODING s'], LISTPACK),
  s('intset converts past set-max-intset-entries', [BIGINT, 'OBJECT ENCODING big', 'SCARD big', 'SISMEMBER big 599']),
  s('small string set encoding', ['SADD s a b', 'OBJECT ENCODING s'], LISTPACK),
  s('string set with a long member', ['SADD s 1', `SADD s ${'x'.repeat(100)}`, 'OBJECT ENCODING s', 'SCARD s']),
  s('CONFIG set-max-intset-entries lowers the limit', ['CONFIG SET set-max-intset-entries 2', 'SADD s 1 2', 'OBJECT ENCODING s', 'SADD s 3', 'OBJECT ENCODING s', { cmd: 'SMEMBERS s', norm: sorted }], LISTPACK),
  s('removing the string member keeps the encoding', ['SADD s 1 2 x', 'SREM s x', 'OBJECT ENCODING s'], LISTPACK),

  // SMOVE
  s('SMOVE between sets', ['SADD a x y', 'SADD b z', 'SMOVE a b x', 'SMEMBERS a', { cmd: 'SMEMBERS b', norm: sorted }, 'SMOVE a b nope']),
  s('SMOVE member already in destination', ['SADD a x', 'SADD b x', 'SMOVE a b x', 'EXISTS a', 'SMEMBERS b']),
  s('SMOVE same source and destination', ['SADD a x', 'SMOVE a a x', 'SMEMBERS a', 'SMOVE a a nope']),
  s('SMOVE missing source and wrong type destination', ['SMOVE nokey b x', 'SADD a x', 'SET d v', 'SMOVE a d x', 'SMOVE a d nope', 'SMEMBERS a', 'SMOVE a b']),
  s('SMOVE into intset', ['SADD a 5 x', 'SADD b 1 2', 'SMOVE a b 5', 'SMEMBERS b', 'OBJECT ENCODING b']),

  // SPOP
  s('SPOP from missing key', ['SPOP nokey', 'SPOP nokey 3', 'SPOP nokey 0']),
  s('SPOP single member set', ['SADD s a', 'SPOP s', 'EXISTS s', 'SADD s b', 'SPOP s 5', 'EXISTS s']),
  s('SPOP count shapes', ['SADD s a b c d e', { cmd: 'SPOP s', norm: shape }, { cmd: 'SPOP s 2', norm: shape }, 'SCARD s', { cmd: 'SPOP s 10', norm: shape }, 'EXISTS s']),
  s('SPOP count zero and errors', ['SADD s a b', 'SPOP s 0', 'SPOP s -1', 'SPOP s x', 'SPOP s 1 2', 'SCARD s']),
  s('SPOP whole intset', ['SADD s 3 1 2', { cmd: 'SPOP s 3', norm: sorted }, 'EXISTS s']),
  s('SPOP from big set', [BIGINT, { cmd: 'SPOP big 590', norm: shape }, 'SCARD big', { cmd: 'SPOP big 3', norm: shape }]),

  // SRANDMEMBER
  s('SRANDMEMBER missing key', ['SRANDMEMBER nokey', 'SRANDMEMBER nokey 3', 'SRANDMEMBER nokey -3', 'SRANDMEMBER nokey 0']),
  s('SRANDMEMBER single member set', ['SADD s a', 'SRANDMEMBER s', 'SRANDMEMBER s 3', 'SRANDMEMBER s -3', 'SRANDMEMBER s 0']),
  s('SRANDMEMBER count shapes', ['SADD s a b c d e', { cmd: 'SRANDMEMBER s', norm: shape }, { cmd: 'SRANDMEMBER s 3', norm: shape }, { cmd: 'SRANDMEMBER s -8', norm: shape }]),
  s('SRANDMEMBER count at least size', ['SADD s a b c', { cmd: 'SRANDMEMBER s 3', norm: sorted }, { cmd: 'SRANDMEMBER s 100', norm: sorted }]),
  s('SRANDMEMBER errors', ['SADD s a', 'SRANDMEMBER s x', 'SRANDMEMBER s 1 2', 'SRANDMEMBER s 1.5', 'SRANDMEMBER']),
  s('SRANDMEMBER extreme negative count', ['SADD s a', 'SRANDMEMBER s -9223372036854775808', 'SRANDMEMBER s 9223372036854775807']),
  s('SRANDMEMBER on big intset', [BIGINT, { cmd: 'SRANDMEMBER big 10', norm: shape }, { cmd: 'SRANDMEMBER big -10', norm: shape }, { cmd: 'SRANDMEMBER big 1000', norm: shape }]),

  // set algebra
  s('SINTER', ['SADD a 1 2 3 x', 'SADD b 2 3 x y', 'SADD c 3 x', { cmd: 'SINTER a b c', norm: sorted }, 'SINTER a nokey', 'SINTER nokey']),
  s('SINTER of intsets is ordered', ['SADD a 5 1 3 9', 'SADD b 9 3 7 1', 'SINTER a b']),
  s('SUNION', ['SADD a 1 x', 'SADD b 2 x', { cmd: 'SUNION a b nokey', norm: sorted }, 'SUNION nokey']),
  s('SDIFF', ['SADD a 1 2 3 x', 'SADD b 2', 'SADD c x', { cmd: 'SDIFF a b c', norm: sorted }, 'SDIFF nokey a', { cmd: 'SDIFF a nokey', norm: sorted }, 'SDIFF a a']),
  s('set algebra arity', ['SINTER', 'SUNION', 'SDIFF', 'SINTERSTORE d', 'SUNIONSTORE d', 'SDIFFSTORE d']),
  s('SINTERSTORE stores and overwrites', ['SADD a 1 2 3', 'SADD b 2 3 4', 'SET d old', 'SINTERSTORE d a b', 'TYPE d', 'SMEMBERS d', 'OBJECT ENCODING d']),
  s('STORE of empty result deletes destination', ['SADD d x', 'SADD a 1', 'SINTERSTORE d a nokey', 'EXISTS d', 'SADD d x', 'SDIFFSTORE d a a', 'EXISTS d', 'SADD d x', 'SUNIONSTORE d nokey', 'EXISTS d']),
  s('SUNIONSTORE and SDIFFSTORE', ['SADD a 1 2', 'SADD b 2 3', 'SUNIONSTORE u a b', 'SMEMBERS u', 'SDIFFSTORE df a b', 'SMEMBERS df']),
  s('STORE with destination as a source', ['SADD a 1 2 3', 'SADD b 3 4', 'SUNIONSTORE a a b', 'SMEMBERS a', 'SDIFFSTORE b b a', 'EXISTS b']),
  s('SINTERSTORE string result', ['SADD a x y z', 'SADD b x y', 'SINTERSTORE d a b', { cmd: 'SMEMBERS d', norm: sorted }, 'SCARD d']),

  // SINTERCARD
  s('SINTERCARD with and without LIMIT', ['SADD a 1 2 3 4', 'SADD b 2 3 4 5', 'SINTERCARD 2 a b', 'SINTERCARD 2 a b LIMIT 2', 'SINTERCARD 2 a b LIMIT 0', 'SINTERCARD 2 a nokey', 'SINTERCARD 1 a']),
  s('SINTERCARD errors', [
    'SADD a 1', 'SINTERCARD 0 a', 'SINTERCARD -1 a', 'SINTERCARD 2 a', 'SINTERCARD x a', 'SINTERCARD 1 a LIMIT -1', 'SINTERCARD 1 a LIMIT x',
    'SINTERCARD 1 a LIMIT', 'SINTERCARD 1 a FOO 1', 'SINTERCARD 1', 'SINTERCARD',
  ]),

  // SSCAN
  s('SSCAN intset in one call', ['SADD s 3 1 2', 'SSCAN s 0', 'SSCAN s 0 MATCH 1*', 'SSCAN s 0 COUNT 1']),
  s('SSCAN full iteration of a big set', [BIGINT, { scan: 'SSCAN big 0 COUNT 20' }, { scan: 'SSCAN big 0 MATCH 5* COUNT 50' }]),
  s('SSCAN string set full iteration', ['SADD s alpha beta gamma delta', { scan: 'SSCAN s 0' }, { scan: 'SSCAN s 0 MATCH *a' }]),
  s('SSCAN errors and missing key', ['SSCAN nokey 0', 'SADD s a', 'SSCAN s x', 'SSCAN s 0 COUNT 0', 'SSCAN s 0 MATCH', 'SSCAN s']),
  s('SSCAN NOVALUES is a syntax error', ['SADD s a', 'SSCAN s 0 NOVALUES', 'ZADD z 1 a', 'ZSCAN z 0 NOVALUES']),
]);
