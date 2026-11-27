import { differential, s, v } from './differential.harness';
import { shape, sorted } from './differential.normalizers';
import { INT_PROBES_NO_NEGATIVE_COUNT, intProbes } from './differential.probes';

/** Sorted sets, part 1: ZADD flags, scores and their formatting, ranges, ranks, removal. Small zsets are listpack. */
const BIG = ['ZADD big', ...Array.from({ length: 200 }, (_, i) => `${i} m${i}`)].join(' ');

differential('zsets', [
  // ZADD basics and flags
  s('ZADD new and updated members', ['ZADD z 1 a 2 b', 'ZADD z 3 a 4 c', 'ZRANGE z 0 -1 WITHSCORES', 'ZCARD z']),
  s('ZADD CH counts changed scores', ['ZADD z 1 a 2 b', 'ZADD z CH 1 a 5 b 6 c', 'ZADD z ch 6 c']),
  s('ZADD NX only adds', ['ZADD z 1 a', 'ZADD z NX 5 a 2 b', 'ZRANGE z 0 -1 WITHSCORES']),
  s('ZADD XX only updates', ['ZADD z 1 a', 'ZADD z XX 5 a 2 b', 'ZRANGE z 0 -1 WITHSCORES', 'ZADD nokey XX 1 a', 'EXISTS nokey']),
  s('ZADD GT and LT', ['ZADD z 5 a 5 b', 'ZADD z GT CH 3 a 7 b 1 c', 'ZADD z LT CH 1 a 9 b 0 d', 'ZRANGE z 0 -1 WITHSCORES']),
  s('ZADD XX GT combination', ['ZADD z 5 a', 'ZADD z XX GT CH 6 a 1 b', 'ZADD z XX LT CH 7 a', 'ZRANGE z 0 -1 WITHSCORES']),
  s('ZADD flag conflicts', ['ZADD z NX XX 1 a', 'ZADD z NX GT 1 a', 'ZADD z NX LT 1 a', 'ZADD z GT LT 1 a', 'EXISTS z']),
  s('ZADD INCR', ['ZADD z INCR 1.5 a', 'ZADD z INCR -0.5 a', 'ZADD z NX INCR 5 a', 'ZADD z XX INCR 5 b', 'ZADD z GT INCR -1 a', 'ZADD z LT INCR -1 a']),
  s('ZADD INCR with several pairs', ['ZADD z INCR 1 a 2 b', 'EXISTS z']),
  s('ZADD syntax and arity errors', ['ZADD z', 'ZADD z 1', 'ZADD z 1 a 2', 'ZADD z NX', 'ZADD z FOO 1 a', 'ZADD z CH', 'ZADD']),
  s('ZADD score parsing', ['ZADD z abc a', 'ZADD z 1.5.5 a', 'ZADD z "" a', 'ZADD z 0x10 a', 'ZADD z " 1" a', 'ZADD z 1e3 a 1E-2 b .5 c', 'ZRANGE z 0 -1 WITHSCORES']),
  s('ZADD inf and nan scores', ['ZADD z inf a -inf b +inf c', 'ZADD z nan x', 'ZADD z NaN x', 'ZRANGE z 0 -1 WITHSCORES', 'ZSCORE z a', 'ZSCORE z b']),
  s('ZADD INCR producing nan', ['ZADD z inf a', 'ZADD z INCR -inf a', 'ZINCRBY z -inf a', 'ZSCORE z a']),
  s('ZADD one bad score adds nothing', ['ZADD z 1 a x b', 'EXISTS z']),
  s('zset commands against a string key', [
    'SET k v', 'ZADD k 1 a', 'ZSCORE k a', 'ZCARD k', 'ZRANGE k 0 -1', 'ZRANK k a', 'ZREM k a', 'ZINCRBY k 1 a', 'ZCOUNT k 0 1',
    'ZPOPMIN k', 'ZRANDMEMBER k', 'ZUNIONSTORE d 1 k', 'ZRANGESTORE d k 0 -1', 'ZMSCORE k a', 'ZLEXCOUNT k - +', 'ZSCAN k 0',
  ]),

  // score formatting
  s('ZSCORE integral and fractional', ['ZADD z 1 a 1.5 b -2.25 c 0 d 100 e', 'ZSCORE z a', 'ZSCORE z b', 'ZSCORE z c', 'ZSCORE z d', 'ZSCORE z e', 'ZSCORE z x', 'ZSCORE nokey a']),
  s('ZSCORE shortest round trip', ['ZADD z 0.1 a 1.1 b 3.0000000000000004 c 0.30000000000000004 d', 'ZSCORE z a', 'ZSCORE z b', 'ZSCORE z c', 'ZSCORE z d']),
  s('double replies are %.17g', [
    'ZADD z 0.1 a 5e-324 b 1e-5 c 0.0001 d 1e15 e 1e16 f 1e17 g 123.456 h 1.7976931348623157e308 i -0.3 j 2.5e-310 k',
    'ZSCORE z a', 'ZSCORE z b', 'ZSCORE z c', 'ZSCORE z d', 'ZSCORE z e', 'ZSCORE z f', 'ZSCORE z g', 'ZSCORE z h', 'ZSCORE z i', 'ZSCORE z j', 'ZSCORE z k',
    'ZRANGE z 0 -1 WITHSCORES', 'ZINCRBY z 0.2 a', 'ZADD z INCR 0.1 h', 'ZMSCORE z a b c', 'ZPOPMIN z 2', 'ZRANGEBYSCORE z 0 1 WITHSCORES LIMIT 0 3',
  ]),
  s('ZSCAN prints scores as the encoding stores them', [
    'ZADD z 1e17 a 1e18 b 9.2e18 c 1e19 d -1e17 e 9007199254740993 f 4611686018427387904 g 4611686018427387905 h 0.5 i 0.1 j -0.0 k', 'ZSCAN z 0',
    'CONFIG SET zset-max-listpack-entries 0', 'ZADD s 1e17 a 1e18 b 0.1 c 1e15 d', { scan: 'ZSCAN s 0' },
  ]),
  s('ZSCORE exponent formatting', ['ZADD z 1e20 a 9.5367431640625e-07 b 1152921504606846976 c -1e20 d', 'ZSCORE z a', 'ZSCORE z b', 'ZSCORE z c', 'ZSCORE z d', 'ZRANGE z 0 -1 WITHSCORES']),
  s('negative zero score', ['ZADD z -0 a', 'ZSCORE z a', 'ZINCRBY z -0 b', 'ZADD big 1 x 2 y 3 q -0 c', 'CONFIG SET zset-max-listpack-entries 0', 'ZADD sk -0 a', 'OBJECT ENCODING sk', 'ZSCORE sk a']),
  s('ZINCRBY results', ['ZINCRBY z 1 a', 'ZINCRBY z 0.5 a', 'ZINCRBY z -10 a', 'ZINCRBY z 1e20 b', 'ZINCRBY z abc a', 'ZINCRBY z 1', 'ZINCRBY z inf c', 'ZINCRBY z nan c']),
  s('ZMSCORE mixes results', ['ZADD z 1 a 2.5 b', 'ZMSCORE z a x b', 'ZMSCORE nokey a b', 'ZMSCORE z']),

  // ZRANGE by rank
  s('ZRANGE rank ranges', ['ZADD z 1 a 2 b 3 c 4 d', 'ZRANGE z 0 1', 'ZRANGE z -2 -1', 'ZRANGE z 2 1', 'ZRANGE z 0 100 WITHSCORES', 'ZRANGE z -100 -3']),
  s('ZRANGE REV by rank', ['ZADD z 1 a 2 b 3 c', 'ZRANGE z 0 1 REV', 'ZRANGE z 0 -1 REV WITHSCORES', 'ZREVRANGE z 0 0', 'ZREVRANGE z 0 -1 WITHSCORES']),
  s('ZRANGE equal scores ordered by member', ['ZADD z 1 c 1 a 1 b 0 z', 'ZRANGE z 0 -1', 'ZRANGE z 0 -1 REV']),
  s('ZRANGE rank with LIMIT is an error', ['ZADD z 1 a', 'ZRANGE z 0 -1 LIMIT 0 1', 'ZRANGE z 0 1 WITHSCORES BYLEX', 'ZRANGE z 0 1 BYSCORE BYLEX']),

  // BYSCORE
  s('ZRANGE BYSCORE inclusive exclusive and inf', [
    'ZADD z 1 a 2 b 3 c 4 d', 'ZRANGE z 2 3 BYSCORE', 'ZRANGE z (2 3 BYSCORE', 'ZRANGE z (2 (4 BYSCORE', 'ZRANGE z -inf +inf BYSCORE WITHSCORES',
    'ZRANGE z (1 inf BYSCORE', 'ZRANGE z 5 1 BYSCORE',
  ]),
  s('ZRANGE BYSCORE REV and LIMIT', ['ZADD z 1 a 2 b 3 c 4 d', 'ZRANGE z 4 1 BYSCORE REV', 'ZRANGE z 1 4 BYSCORE REV', 'ZRANGE z -inf inf BYSCORE LIMIT 1 2', 'ZRANGE z +inf -inf BYSCORE REV LIMIT 0 2 WITHSCORES', 'ZRANGE z -inf inf BYSCORE LIMIT 1 -1', 'ZRANGE z -inf inf BYSCORE LIMIT -1 2']),
  s('ZRANGEBYSCORE and ZREVRANGEBYSCORE', ['ZADD z 1 a 2 b 3 c', 'ZRANGEBYSCORE z (1 3 WITHSCORES', 'ZRANGEBYSCORE z -inf 2 LIMIT 0 1', 'ZREVRANGEBYSCORE z 3 (1', 'ZREVRANGEBYSCORE z +inf -inf WITHSCORES LIMIT 1 1']),
  s('BYSCORE range errors', ['ZADD z 1 a', 'ZRANGEBYSCORE z a 1', 'ZRANGEBYSCORE z 1 (b', 'ZRANGEBYSCORE z ((1 2', 'ZRANGEBYSCORE z nan 1', 'ZRANGEBYSCORE z 0 1 LIMIT 0', 'ZRANGEBYSCORE z 0 1 LIMIT a b', 'ZRANGEBYSCORE z 0 1 FOO', 'ZRANGE z 0 1 BYSCORE LIMIT 0 x']),
  s('ZCOUNT ranges', ['ZADD z 1 a 2 b 3 c', 'ZCOUNT z 1 2', 'ZCOUNT z (1 +inf', 'ZCOUNT z -inf (1', 'ZCOUNT z 3 1', 'ZCOUNT nokey 0 1', 'ZCOUNT z x 1', 'ZCOUNT z 0']),

  // BYLEX
  s('ZRANGE BYLEX ranges', ['ZADD z 0 a 0 b 0 c 0 d', 'ZRANGE z [b [c BYLEX', 'ZRANGE z (a (d BYLEX', 'ZRANGE z - + BYLEX', 'ZRANGE z + - BYLEX REV', 'ZRANGE z [c - BYLEX REV LIMIT 0 2', 'ZRANGE z - + BYLEX LIMIT 1 1']),
  s('ZRANGEBYLEX and ZREVRANGEBYLEX', ['ZADD z 0 apple 0 banana 0 cherry', 'ZRANGEBYLEX z [b +', 'ZRANGEBYLEX z (apple [cherry LIMIT 0 1', 'ZREVRANGEBYLEX z + [b', 'ZRANGEBYLEX z [z +']),
  s('BYLEX invalid ranges', ['ZADD z 0 a', 'ZRANGEBYLEX z a b', 'ZRANGEBYLEX z [a b', 'ZRANGEBYLEX z "" +', 'ZRANGE z a [b BYLEX', 'ZLEXCOUNT z a +', 'ZREMRANGEBYLEX z x +', 'ZRANGE z [a [b BYLEX WITHSCORES']),
  s('ZLEXCOUNT', ['ZADD z 0 a 0 b 0 c', 'ZLEXCOUNT z - +', 'ZLEXCOUNT z [b +', 'ZLEXCOUNT z (a (c', 'ZLEXCOUNT nokey - +', 'ZLEXCOUNT z + -']),

  // ZRANGESTORE
  s('ZRANGESTORE variants', ['ZADD z 1 a 2 b 3 c', 'ZRANGESTORE d z 0 1', 'ZRANGE d 0 -1 WITHSCORES', 'ZRANGESTORE d z (1 +inf BYSCORE', 'ZRANGESTORE d z [b + BYLEX', 'ZRANGESTORE d z 0 -1 REV', 'ZRANGE d 0 -1']),
  s('ZRANGESTORE empty result deletes destination', ['ZADD d 1 x', 'ZADD z 1 a', 'ZRANGESTORE d z 5 10', 'EXISTS d', 'ZRANGESTORE d nokey 0 -1', 'EXISTS d']),
  s('ZRANGESTORE errors', ['ZADD z 1 a', 'ZRANGESTORE d z 0 -1 WITHSCORES', 'ZRANGESTORE d z 0', 'SET k v', 'ZRANGESTORE d k 0 -1', 'ZRANGESTORE k z 0 -1', 'TYPE k']),

  // ZRANK / ZREVRANK
  s('ZRANK and ZREVRANK', ['ZADD z 1 a 2 b 3 c', 'ZRANK z a', 'ZRANK z c', 'ZREVRANK z a', 'ZRANK z x', 'ZRANK nokey a', 'ZRANK z']),
  s('ZRANK WITHSCORE', ['ZADD z 1 a 2.5 b', 'ZRANK z b WITHSCORE', 'ZREVRANK z b WITHSCORE', 'ZRANK z x WITHSCORE', 'ZRANK z a b', 'ZREVRANK z a b'], v('ZRANK / ZREVRANK WITHSCORE were added in 7.2 (an extra argument is a syntax error since, an arity error before)')),

  // ZREM / ZREMRANGEBY*
  s('ZREM present and missing', ['ZADD z 1 a 2 b', 'ZREM z a x a', 'ZREM z b', 'EXISTS z', 'ZREM nokey a', 'ZREM z']),
  s('ZREMRANGEBYRANK', ['ZADD z 1 a 2 b 3 c 4 d', 'ZREMRANGEBYRANK z 1 2', 'ZRANGE z 0 -1', 'ZREMRANGEBYRANK z 5 10', 'ZREMRANGEBYRANK z 0 -1', 'EXISTS z', 'ZREMRANGEBYRANK z x 1']),
  s('ZREMRANGEBYSCORE and BYLEX', ['ZADD z 1 a 2 b 3 c', 'ZREMRANGEBYSCORE z (1 2', 'ZRANGE z 0 -1', 'ZADD l 0 a 0 b 0 c', 'ZREMRANGEBYLEX l [a (c', 'ZRANGE l 0 -1', 'ZREMRANGEBYSCORE z x 1', 'ZREMRANGEBYLEX l a b']),

  // encodings
  s('small zset is listpack', ['ZADD z 1 a', 'OBJECT ENCODING z']),
  s('entry count past the limit converts to skiplist', [BIG, 'OBJECT ENCODING big', 'ZRANGE big 125 130 WITHSCORES', 'ZRANK big m150', 'ZCARD big']),
  s('long member converts to skiplist', ['ZADD z 1 a', `ZADD z 2 ${'x'.repeat(65)}`, 'OBJECT ENCODING z', 'ZCARD z']),
  s('CONFIG zset-max-listpack-entries', ['CONFIG SET zset-max-listpack-entries 1', 'ZADD z 1 a', 'OBJECT ENCODING z', 'ZADD z 2 b', 'OBJECT ENCODING z', 'ZRANGE z 0 -1 WITHSCORES']),
  s('default zset listpack limits', ['CONFIG GET zset-max-listpack-entries', 'CONFIG GET zset-max-listpack-value']),
  s('skiplist ranges and removal', [BIG, 'ZRANGE big (10 15 BYSCORE', 'ZREMRANGEBYSCORE big 0 99', 'ZRANGE big 0 2', 'ZRANGE big -2 -1 REV WITHSCORES', 'ZCOUNT big -inf +inf']),

  // integer arguments at the int64 and int32 edges (see differential.probes)
  ...intProbes('ZRANGE start stop', ['ZADD z 1 a 2 b 3 c', 'ZRANGE z $N 1', 'ZRANGE z 0 $N', 'ZREVRANGE z $N 1', 'ZREVRANGE z 0 $N']),
  ...intProbes('ZRANGE LIMIT', ['ZADD z 1 a 2 b 3 c', 'ZRANGE z -inf +inf BYSCORE LIMIT $N 1', 'ZRANGE z -inf +inf BYSCORE LIMIT 0 $N', 'ZRANGE z - + BYLEX LIMIT 1 $N']),
  ...intProbes('ZRANGEBYSCORE LIMIT', ['ZADD z 1 a 2 b 3 c', 'ZRANGEBYSCORE z -inf +inf LIMIT $N 1', 'ZRANGEBYSCORE z -inf +inf LIMIT 0 $N', 'ZREVRANGEBYSCORE z +inf -inf LIMIT 1 $N']),
  ...intProbes('ZRANGEBYLEX LIMIT', ['ZADD z 0 a 0 b 0 c', 'ZRANGEBYLEX z - + LIMIT $N 1', 'ZRANGEBYLEX z - + LIMIT 0 $N', 'ZREVRANGEBYLEX z + - LIMIT 1 $N']),
  ...intProbes('ZREMRANGEBYRANK', ['ZADD z 1 a 2 b 3 c', 'ZREMRANGEBYRANK z $N -1', 'ZREMRANGEBYRANK z 5 $N', 'ZRANGE z 0 -1']),
  ...intProbes('ZRANGESTORE', ['ZADD z 1 a 2 b 3 c', 'ZRANGESTORE d z $N -1', 'ZRANGESTORE d z 0 $N', 'ZRANGE d 0 -1']),
  ...intProbes('ZRANDMEMBER count', ['ZADD z 1 a 2 b 3 c', { cmd: 'ZRANDMEMBER z $N', norm: sorted }, { cmd: 'ZRANDMEMBER z $N WITHSCORES', norm: shape }], {}, INT_PROBES_NO_NEGATIVE_COUNT),
  ...intProbes('ZPOPMIN count', ['ZADD z 1 a 2 b 3 c', 'ZPOPMIN z $N', 'ZADD z 1 a', 'ZPOPMAX z $N']),
  ...intProbes('ZMPOP', ['ZADD z 1 a 2 b 3 c', 'ZMPOP $N z MIN', 'ZMPOP 1 z MIN COUNT $N', 'ZADD z 1 a', 'BZMPOP 0 1 z MIN COUNT $N', 'BZMPOP 0 $N z MIN']),
  ...intProbes('blocking zset timeouts', ['ZADD z 1 a 2 b 3 c', 'BZPOPMIN z $N', 'BZPOPMAX z $N', 'BZMPOP $N 1 z MIN']),
  ...intProbes('zset numkeys', ['ZADD z 1 a', 'ZUNIONSTORE d $N z', 'ZUNION $N z', 'ZINTER $N z', 'ZDIFF $N z', 'ZINTERCARD $N z', 'ZINTERSTORE d $N z', 'ZDIFFSTORE d $N z']),
  ...intProbes('ZINTERCARD LIMIT', ['ZADD z 1 a', 'ZINTERCARD 1 z LIMIT $N']),
  ...intProbes('ZSCAN COUNT', ['ZADD z 1 a', 'ZSCAN z 0 COUNT $N']),
]);
