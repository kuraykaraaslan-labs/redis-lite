import { differential, s, v } from './differential.harness';
import { shape, sorted } from './differential.normalizers';

/** Sorted sets, part 2: set operations, pops (blocking too), random members, scan. */
differential('zsets-ops', [
  // ZUNION / ZINTER / ZDIFF
  s('ZUNION default sum', ['ZADD a 1 x 2 y', 'ZADD b 3 y 4 z', 'ZUNION 2 a b WITHSCORES', 'ZUNION 2 a b', 'ZUNION 3 a b nokey WITHSCORES']),
  s('ZINTER default sum', ['ZADD a 1 x 2 y', 'ZADD b 3 y 4 z', 'ZINTER 2 a b WITHSCORES', 'ZINTER 2 a nokey']),
  s('ZUNION WEIGHTS and AGGREGATE', [
    'ZADD a 1 x 2 y', 'ZADD b 3 y 4 z', 'ZUNION 2 a b WEIGHTS 2 0.5 WITHSCORES', 'ZUNION 2 a b AGGREGATE MIN WITHSCORES',
    'ZUNION 2 a b AGGREGATE MAX WITHSCORES', 'ZINTER 2 a b WEIGHTS -1 1 AGGREGATE MAX WITHSCORES', 'ZUNION 2 a b aggregate sum weights 1 1 withscores',
  ]),
  s('ZUNION with a plain set as input', ['ZADD a 1 x', 'SADD s x y', 'ZUNION 2 a s WITHSCORES', 'ZINTER 2 a s WITHSCORES', 'ZINTERSTORE d 2 a s', 'ZRANGE d 0 -1 WITHSCORES']),
  s('ZUNION inf weights produce nan as zero', ['ZADD a 0 x', 'ZADD b inf x', 'ZUNION 2 a b WEIGHTS inf 1 WITHSCORES', 'ZADD c -inf x', 'ZUNION 2 b c WITHSCORES', 'ZINTER 2 b c AGGREGATE MIN WITHSCORES']),
  s('ZDIFF', ['ZADD a 1 x 2 y 3 z', 'ZADD b 5 y', 'ZDIFF 2 a b WITHSCORES', 'ZDIFF 2 a b', 'ZDIFF 1 a', 'ZDIFF 2 nokey a', 'ZDIFF 2 a a']),
  s('set operation numkeys errors', [
    'ZADD a 1 x', 'ZUNION 0 a', 'ZUNION -1 a', 'ZUNION 2 a', 'ZUNION x a', 'ZINTER 0 a', 'ZDIFF 0 a', 'ZDIFF 3 a b', 'ZUNIONSTORE d 0 a',
    'ZINTERSTORE d 2 a', 'ZDIFFSTORE d 0 a',
  ]),
  s('set operation option errors', [
    'ZADD a 1 x', 'ZUNION 1 a WEIGHTS', 'ZUNION 1 a WEIGHTS x', 'ZUNION 1 a WEIGHTS 1 2', 'ZUNION 1 a AGGREGATE', 'ZUNION 1 a AGGREGATE AVG',
    'ZUNION 1 a FOO', 'ZDIFF 1 a WEIGHTS 1', 'ZDIFF 1 a AGGREGATE MIN', 'ZUNIONSTORE d 1 a WITHSCORES', 'ZUNION 1 a WEIGHTS nan',
  ]),
  s('set operations with wrong type key', ['ZADD a 1 x', 'SET k v', 'ZUNION 2 a k', 'ZINTER 2 a k', 'ZDIFF 2 a k', 'ZUNIONSTORE d 2 a k', 'ZINTERCARD 2 a k']),
  s('ZUNIONSTORE ZINTERSTORE ZDIFFSTORE', [
    'ZADD a 1 x 2 y', 'ZADD b 3 y', 'ZUNIONSTORE u 2 a b', 'ZRANGE u 0 -1 WITHSCORES', 'ZINTERSTORE i 2 a b WEIGHTS 2 3', 'ZRANGE i 0 -1 WITHSCORES',
    'ZDIFFSTORE df 2 a b', 'ZRANGE df 0 -1 WITHSCORES',
  ]),
  s('STORE empty result deletes destination', ['ZADD d 1 q', 'ZADD a 1 x', 'ZINTERSTORE d 2 a nokey', 'EXISTS d', 'SET d str', 'ZDIFFSTORE d 2 a a', 'EXISTS d']),
  s('STORE with destination as input', ['ZADD a 1 x', 'ZADD b 2 x 3 y', 'ZUNIONSTORE a 2 a b', 'ZRANGE a 0 -1 WITHSCORES']),

  // ZINTERCARD
  s('ZINTERCARD with LIMIT', ['ZADD a 1 x 2 y 3 z', 'ZADD b 1 x 2 y', 'ZINTERCARD 2 a b', 'ZINTERCARD 2 a b LIMIT 1', 'ZINTERCARD 2 a b LIMIT 0', 'ZINTERCARD 2 a nokey']),
  s('ZINTERCARD errors', ['ZADD a 1 x', 'ZINTERCARD 0 a', 'ZINTERCARD 2 a', 'ZINTERCARD 1 a LIMIT -1', 'ZINTERCARD 1 a LIMIT x', 'ZINTERCARD 1 a FOO 1', 'ZINTERCARD 1']),

  // ZPOPMIN / ZPOPMAX / ZMPOP
  s('ZPOPMIN and ZPOPMAX', ['ZADD z 1 a 2 b 3 c', 'ZPOPMIN z', 'ZPOPMAX z', 'ZPOPMIN z 5', 'EXISTS z', 'ZPOPMIN nokey', 'ZPOPMAX nokey 2']),
  s('ZPOP count zero and negative', ['ZADD z 1 a 2 b', 'ZPOPMIN z 0', 'ZPOPMAX z -1', 'ZPOPMIN z x', 'ZPOPMIN z 1 2', 'ZCARD z']),
  s('ZPOPMAX with count orders by score descending', ['ZADD z 1 a 2 b 3 c 3 d', 'ZPOPMAX z 3']),
  s('ZMPOP', ['ZADD b 1 x 2 y 3 z', 'ZMPOP 2 a b MIN', 'ZMPOP 2 a b MAX COUNT 5', 'ZMPOP 2 a b MIN', 'EXISTS b']),
  s('ZMPOP errors', [
    'ZADD z 1 a', 'ZMPOP 0 z MIN', 'ZMPOP 2 z MIN', 'ZMPOP 1 z UP', 'ZMPOP 1 z MIN COUNT 0', 'ZMPOP 1 z MIN COUNT -1', 'ZMPOP 1 z MIN COUNT',
    'ZMPOP 1 z MIN COUNT 1 COUNT 1', 'ZMPOP x z MIN', 'ZMPOP 1', 'SET k v', 'ZMPOP 1 k MIN',
  ]),

  // blocking pops
  s('BZPOPMIN and BZPOPMAX immediate', ['ZADD b 1 x 2 y', 'BZPOPMIN a b 0', 'BZPOPMAX a b 0', 'EXISTS b']),
  s('BZPOPMIN short timeout', ['BZPOPMIN z 0.1', 'BZPOPMAX z1 z2 0.1', 'BZMPOP 0.1 1 z MIN']),
  s('BZPOPMIN woken by ZADD', [{ c: 1, cmd: 'BZPOPMIN z 0', wait: false }, { blocked: 1 }, 'ZADD z 2 b 1 a', { c: 1, read: 1 }, 'ZRANGE z 0 -1']),
  s('BZPOPMAX woken by ZINCRBY', [{ c: 1, cmd: 'BZPOPMAX z 0', wait: false }, { blocked: 1 }, 'ZINCRBY z 2.5 m', { c: 1, read: 1 }]),
  s('BZMPOP woken with count', [{ c: 1, cmd: 'BZMPOP 0 2 a b MAX COUNT 2', wait: false }, { blocked: 1 }, 'ZADD b 1 x 2 y 3 z', { c: 1, read: 1 }, 'ZRANGE b 0 -1']),
  s('BZPOPMIN woken by ZUNIONSTORE', [{ c: 1, cmd: 'BZPOPMIN d 0', wait: false }, { blocked: 1 }, 'ZADD a 1 x', 'ZUNIONSTORE d 1 a', { c: 1, read: 1 }]),
  s('BZPOPMIN in MULTI does not block', ['MULTI', 'BZPOPMIN z 0', 'BZMPOP 0 1 z MIN', 'EXEC']),
  s('blocking zset pop errors', [
    'BZPOPMIN z -1', 'BZPOPMIN z x', 'BZPOPMAX z', 'BZMPOP 0 0 z MIN', 'BZMPOP -1 1 z MIN', 'BZMPOP 0 1 z UP', 'BZMPOP 0 1 z MIN COUNT 0',
    'SET k v', 'BZPOPMIN k 0', 'BZMPOP 0 1 k MAX',
  ]),

  // ZRANDMEMBER
  s('ZRANDMEMBER missing key', ['ZRANDMEMBER nokey', 'ZRANDMEMBER nokey 2', 'ZRANDMEMBER nokey -2 WITHSCORES', 'ZRANDMEMBER nokey 0']),
  s('ZRANDMEMBER single member is deterministic', ['ZADD z 1.5 a', 'ZRANDMEMBER z', 'ZRANDMEMBER z 3', 'ZRANDMEMBER z -2 WITHSCORES', 'ZRANDMEMBER z 1 WITHSCORES', 'ZRANDMEMBER z 0']),
  s('ZRANDMEMBER shapes', ['ZADD z 1 a 2 b 3 c 4 d', { cmd: 'ZRANDMEMBER z', norm: shape }, { cmd: 'ZRANDMEMBER z 2 WITHSCORES', norm: shape }, { cmd: 'ZRANDMEMBER z -6', norm: shape }, { cmd: 'ZRANDMEMBER z 10', norm: sorted }]),
  s('ZRANDMEMBER errors', ['ZADD z 1 a', 'ZRANDMEMBER z x', 'ZRANDMEMBER z 1 WITHVALUES', 'ZRANDMEMBER z 1 WITHSCORES x', 'ZRANDMEMBER z -9223372036854775808', 'ZRANDMEMBER']),

  // ZSCAN
  s('ZSCAN small zset', ['ZADD z 1 a 2.5 b', 'ZSCAN z 0', 'ZSCAN z 0 MATCH a', 'ZSCAN nokey 0']),
  s('ZSCAN full iteration of a skiplist', [['ZADD big', ...Array.from({ length: 300 }, (_, i) => `${i / 4} m${i}`)].join(' '), { scan: 'ZSCAN big 0 COUNT 10' }, { scan: 'ZSCAN big 0 MATCH m1* COUNT 30' }]),
  s('ZSCAN errors', ['ZADD z 1 a', 'ZSCAN z x', 'ZSCAN z 0 COUNT 0', 'ZSCAN z 0 MATCH', 'ZSCAN z']),
  s('ZSCAN NOSCORES', ['ZADD z 1 a 2 b', 'ZSCAN z 0 NOSCORES'], v('ZSCAN NOSCORES was added in 8.0')),

  // ZCARD and misc arity
  s('ZCARD and arity errors', ['ZCARD nokey', 'ZCARD', 'ZSCORE z', 'ZMSCORE', 'ZRANGE z 0', 'ZREVRANGE z 0', 'ZRANGEBYSCORE z 0', 'ZPOPMIN', 'ZRANDMEMBER']),
]);
