import { differential, s, v } from './differential.harness';
import type { ScenarioOptions } from './differential.harness';
import { anyNumber, shape, sorted, sortedConfig, sortedDeep } from './differential.normalizers';

const R3: ScenarioOptions = { proto: 3 };

const SHORTEST_DOUBLE = 'doubles are printed in their shortest round-trip form since 7.2 (fpconv); 7.0 uses %.17g (0.10000000000000001)';

/** A Lua script run with EVAL 0 (the script is quoted for the tokenizer). */
const lua = (body: string, ...args: string[]): string => `EVAL "${body.replace(/"/g, '\\"')}" ${args.length ? args.join(' ') : '0'}`;

// RESP3 reply types: map, set, double, null, boolean, big number, verbatim and push, across many commands
differential('resp3', [
  // maps
  s('HGETALL is a map', ['HSET h a 1 b 2 c 3', 'HGETALL h', 'HGETALL nokey'], R3),
  s('HGETALL of a hashtable hash is a map', ['CONFIG SET hash-max-listpack-entries 1', 'HSET h a 1 b 2 c 3', { cmd: 'HGETALL h', norm: sorted }], R3),
  s('CONFIG GET is a map', [{ cmd: 'CONFIG GET maxmemory*', norm: sortedConfig }, 'CONFIG GET nosuch'], R3),
  s('CLIENT TRACKINGINFO is a map', ['CLIENT TRACKINGINFO', 'CLIENT TRACKING ON BCAST PREFIX a', 'CLIENT TRACKINGINFO'], R3),
  s('XINFO STREAM is a map', ['XADD s 1-1 f v', 'XADD s 2-1 g w', 'XINFO STREAM s'], R3),
  s('XINFO STREAM FULL is a map', ['XADD s 1-1 f v', 'XGROUP CREATE s g 0', 'XINFO STREAM s FULL'], R3),
  s('XINFO GROUPS is an array of maps', ['XADD s 1-1 f v', 'XGROUP CREATE s g 0', 'XINFO GROUPS s'], R3),
  s('XINFO CONSUMERS is an array of maps', ['XADD s 1-1 f v', 'XGROUP CREATE s g 0', 'XREADGROUP GROUP g c COUNT 1 STREAMS s >',
    { cmd: 'XINFO CONSUMERS s g', norm: anyNumber }], { ...R3, ...v('XINFO CONSUMERS gained the inactive field in 7.2') }),
  s('XREAD is a map of streams', ['XADD a 1-1 f v', 'XADD b 1-1 g w', 'XREAD STREAMS a b 0 0', 'XREAD STREAMS a 9-9'], R3),
  s('XREADGROUP is a map of streams', ['XADD s 1-1 f v', 'XGROUP CREATE s g 0', 'XREADGROUP GROUP g c STREAMS s >', 'XREADGROUP GROUP g c STREAMS s 0'], R3),
  s('XREAD BLOCK timeout is null', ['XREAD BLOCK 10 STREAMS s $'], R3),
  s('LCS IDX is a map', ['SET a ohmytext', 'SET b mynewtext', 'LCS a b IDX', 'LCS a b IDX MINMATCHLEN 4 WITHMATCHLEN'], R3),
  s('FUNCTION STATS is a map', ['FUNCTION STATS'], R3),
  s('FUNCTION LIST is an array of maps', [lua("return 1"), 'FUNCTION LOAD "#!lua name=lib\\nredis.register_function(\'f\', function() return 1 end)"',
    'FUNCTION LIST'], R3),
  s('ACL GETUSER is a map', ['ACL GETUSER default'], { ...R3, ...v('ACL users list the sanitize-payload flag in newer Redis (7.0 does not show it); version unconfirmed', 'medium') }),
  s('PUBSUB NUMSUB in RESP3', ['PUBSUB NUMSUB x y'], R3),
  s('MEMORY STATS is a map', [{ cmd: 'MEMORY STATS', norm: shape }], { ...R3, ...v('MEMORY STATS gained fields after 7.0', 'medium') }),
  s('COMMAND DOCS is a map', ['COMMAND DOCS echo'], { ...R3, ...v('command summaries were rewritten in 7.2') }),

  // sets
  s('SMEMBERS is a set', ['SADD s 1 2 3', 'SMEMBERS s', 'SMEMBERS nokey'], R3),
  s('SMEMBERS of a hashtable set is a set', ['SADD s a b c', { cmd: 'SMEMBERS s', norm: sorted }], R3),
  s('SINTER, SUNION and SDIFF are sets', ['SADD a 1 2 3', 'SADD b 2 3 4', 'SINTER a b', { cmd: 'SUNION a b', norm: sorted }, 'SDIFF a b'], R3),
  s('SPOP with a count', ['SADD s 1', 'SPOP s 1', 'SPOP s 1', 'SPOP nokey 2'], R3),
  s('SRANDMEMBER with a count is an array', ['SADD s 1', 'SRANDMEMBER s 1', 'SRANDMEMBER s -2'], R3),
  s('SMISMEMBER is an array of integers', ['SADD s a', 'SMISMEMBER s a b'], R3),
  s('KEYS is an array', ['SET a 1', 'KEYS *'], R3),
  s('CLIENT INFO is verbatim', [{ cmd: 'CLIENT LIST TYPE pubsub' }], R3),

  // doubles
  s('ZSCORE is a double', ['ZADD z 1 a 1.5 b -2.25 c', 'ZSCORE z a', 'ZSCORE z b', 'ZSCORE z c', 'ZSCORE z missing', 'ZSCORE nokey a'], R3),
  s('ZSCORE of infinities', ['ZADD z inf a -inf b', 'ZSCORE z a', 'ZSCORE z b'], R3),
  s('ZSCORE double formatting', ['ZADD z 0.1 a 1e300 b 1.5e-7 c 123456789012345678 d 3.0 e', 'ZSCORE z a', 'ZSCORE z b', 'ZSCORE z c', 'ZSCORE z d', 'ZSCORE z e'],
    { ...R3, ...v(SHORTEST_DOUBLE, 'medium') }),
  s('ZSCORE of an exactly representable double', ['ZADD z 0.5 a 3.0 c -2.25 d 1024 e', 'ZSCORE z a', 'ZSCORE z c', 'ZSCORE z d', 'ZSCORE z e'], R3),
  s('ZSCORE of negative zero', ['ZADD z -0 a', 'ZSCORE z a']),
  s('ZINCRBY and ZADD INCR are doubles', ['ZINCRBY z 2.5 a', 'ZADD z INCR 1 a', 'ZADD z NX INCR 1 a'], R3),
  s('ZRANGE WITHSCORES pairs', ['ZADD z 1 a 2 b 3.5 c', 'ZRANGE z 0 -1 WITHSCORES', 'ZREVRANGE z 0 0 WITHSCORES', 'ZRANGE z 0 -1'], R3),
  s('ZRANGEBYSCORE WITHSCORES pairs', ['ZADD z 1 a 2 b', 'ZRANGEBYSCORE z -inf +inf WITHSCORES LIMIT 0 1'], R3),
  s('ZPOPMIN and ZPOPMAX', ['ZADD z 1 a 2 b 3 c', 'ZPOPMIN z', 'ZPOPMAX z 2', 'ZPOPMIN z', 'ZPOPMIN nokey 2'], R3),
  s('BZPOPMIN reply', ['ZADD z 1 a', 'BZPOPMIN z 0', 'BZPOPMIN z 0.01'], R3),
  s('ZMPOP and BZMPOP', ['ZADD z 1 a 2 b', 'ZMPOP 1 z MIN COUNT 2', 'ZMPOP 1 z MIN', 'BZMPOP 0.01 1 z MAX'], R3),
  s('ZMSCORE with a missing member', ['ZADD z 1 a', 'ZMSCORE z a b', 'ZMSCORE nokey a'], R3),
  s('ZUNION and ZINTER WITHSCORES', ['ZADD a 1 x 2 y', 'ZADD b 3 x', 'ZUNION 2 a b WITHSCORES', 'ZINTER 2 a b WITHSCORES AGGREGATE MAX'], R3),
  s('ZRANDMEMBER WITHSCORES shape', ['ZADD z 1 a 2 b', { cmd: 'ZRANDMEMBER z 2 WITHSCORES', norm: shape }], R3),
  s('ZRANK WITHSCORE', ['ZADD z 1 a', 'ZRANK z a WITHSCORE'], { ...R3, ...v('ZRANK / ZREVRANK WITHSCORE was added in 7.2') }),
  s('INCRBYFLOAT stays a bulk string', ['INCRBYFLOAT k 1.5', 'HINCRBYFLOAT h f 2.5'], R3),
  s('GEODIST and GEOPOS', ['GEOADD g 13.361389 38.115556 a 15.087269 37.502669 b', 'GEODIST g a b km', 'GEOPOS g a nope', 'GEODIST g a nope'], R3),
  s('GEOSEARCH WITHDIST WITHCOORD', ['GEOADD g 13.361389 38.115556 a 15.087269 37.502669 b',
    'GEOSEARCH g FROMLONLAT 15 37 BYRADIUS 200 km ASC WITHDIST WITHCOORD WITHHASH'], R3),
  s('HRANDFIELD WITHVALUES shape', ['HSET h a 1 b 2', { cmd: 'HRANDFIELD h 2 WITHVALUES', norm: shape }], R3),

  // nulls
  s('GET, HGET and LPOP of missing keys are null', ['GET nokey', 'HGET nokey f', 'LPOP nokey', 'LPOP nokey 2', 'RPOP nokey 1', 'LINDEX nokey 0'], R3),
  s('MGET with missing keys', ['SET a 1', 'MGET a nokey'], R3),
  s('BLPOP timeout is null', ['BLPOP nokey 0.01', 'BRPOPLPUSH nokey dst 0.01', 'BLMPOP 0.01 1 nokey LEFT'], R3),
  s('LPOS without a match is null', ['RPUSH l a', 'LPOS l b', 'LPOS l b COUNT 0'], R3),
  s('SET GET of a missing key is null', ['SET k v GET'], R3),
  s('OBJECT ENCODING of a missing key is null', ['OBJECT ENCODING nokey'], R3),
  s('SRANDMEMBER and SPOP of a missing key', ['SRANDMEMBER nokey', 'SPOP nokey', 'RANDOMKEY'], R3),
  s('EXEC aborted by WATCH is null', ['WATCH k', { c: 1, cmd: 'SET k v' }, 'MULTI', 'GET k', 'EXEC'], R3),

  // Lua conversions
  s('EVAL returns a Lua table as an array', [lua("return {1, 'two', {3}}")]),
  s('EVAL returns true and false', [lua('return true'), lua('return false')]),
  s('EVAL returns nil', [lua('return nil')]),
  s('EVAL returns a status and an error table', [lua("return {ok='fine'}"), lua("return {err='My error'}"), lua("return redis.error_reply('E2 custom')")]),
  s('EVAL truncates a float', [lua('return 3.99'), lua('return -2.5')]),
  s('EVAL with setresp(3) returns a map', [lua("redis.setresp(3); return {map={a=1}}")]),
  s('EVAL with setresp(3) returns a set', [lua("redis.setresp(3); return {set={x=true}}")]),
  s('EVAL with setresp(3) returns a double', [lua("redis.setresp(3); return {double=3.14}")], v(SHORTEST_DOUBLE, 'medium')),
  s('EVAL with setresp(3) returns an exact double', [lua("redis.setresp(3); return {double=2.5}")]),
  s('EVAL with setresp(3) returns a big number', [lua("redis.setresp(3); return {big_number='123456789012345678901234567890'}")]),
  s('EVAL converts HGETALL through setresp(3)', ['HSET h a 1', lua("redis.setresp(3); return redis.call('HGETALL', KEYS[1])", '1', 'h')]),
  s('EVAL converts ZSCORE through setresp(3)', ['ZADD z 1.5 a', lua("redis.setresp(3); return redis.call('ZSCORE', KEYS[1], 'a')", '1', 'z')]),
  s('EVAL converts SMEMBERS through setresp(3)', ['SADD s 1', lua("redis.setresp(3); return redis.call('SMEMBERS', KEYS[1])", '1', 's')]),
  s('EVAL converts a null through setresp(3)', [lua("redis.setresp(3); return redis.call('GET', 'nokey')")]),
  s('EVAL sees RESP3 types in Lua', ['HSET h a 1', 'ZADD z 2.5 m',
    lua("redis.setresp(3); local m = redis.call('HGETALL', 'h'); local d = redis.call('ZSCORE', 'z', 'm'); return {type(m), type(m.map), d.double, type(redis.call('GET', 'x'))}")]),
  s('EVAL in RESP2 sees RESP2 types in Lua', ['HSET h a 1', lua("local m = redis.call('HGETALL', 'h'); return {type(m), #m, tostring(redis.call('GET', 'x'))}")]),
  s('EVAL setresp with an invalid version', [lua('redis.setresp(4)'), lua('redis.setresp()')]),
  s('EVAL returns a boolean through setresp(3)', [lua("redis.setresp(3); return redis.call('EVAL', 'return true', 0)")]),
  s('EVAL returns a verbatim string through setresp(3)', [lua("redis.setresp(3); local v = redis.call('INFO', 'cluster'); return type(v) == 'table' and v.verbatim_string.format or v")]),

  // booleans and integers
  s('EXISTS and SISMEMBER stay integers', ['SET k v', 'EXISTS k', 'SADD s a', 'SISMEMBER s a'], R3),
  s('SCRIPT EXISTS is an array of integers', ['SCRIPT EXISTS ffffffffffffffffffffffffffffffffffffffff'], R3),

  // verbatim strings
  s('INFO is a verbatim string', ['INFO cluster', 'INFO bogus'], R3),
  s('LATENCY DOCTOR and MEMORY DOCTOR are verbatim', [{ cmd: 'MEMORY DOCTOR', norm: shape }, { cmd: 'LATENCY DOCTOR', norm: shape }], R3),
  s('CLIENT LIST is a verbatim string', ['CLIENT LIST ID 999999'], R3),
  s('LOLWUT is a verbatim string', ['LOLWUT'], { ...R3, ...v('LOLWUT prints the server version (7.0.15 vs 8.x)') }),

  // push messages
  s('SUBSCRIBE confirmations are pushes', ['SUBSCRIBE a b', 'UNSUBSCRIBE a', 'UNSUBSCRIBE'], R3),
  s('PSUBSCRIBE and published messages are pushes', ['PSUBSCRIBE n*', { c: 1, cmd: 'PUBLISH news hi' }, { read: 1 }, 'PUNSUBSCRIBE n*'], R3),
  s('published message to a channel is a push', ['SUBSCRIBE ch', { c: 1, cmd: 'PUBLISH ch hello' }, { read: 1 }, 'PING'], R3),
  s('SSUBSCRIBE and SPUBLISH pushes', ['SSUBSCRIBE sc', { c: 1, cmd: 'SPUBLISH sc m' }, { read: 1 }, 'SUNSUBSCRIBE sc'], R3),
  s('unsubscribe without subscriptions', ['UNSUBSCRIBE', 'PUNSUBSCRIBE', 'SUNSUBSCRIBE'], R3),
  s('CLIENT TRACKING invalidation push', ['CLIENT TRACKING ON', 'GET k', { c: 1, cmd: 'SET k v' }, { read: 1 }, 'GET k'], R3),
  s('CLIENT TRACKING invalidation of several keys', ['CLIENT TRACKING ON', 'MGET a b', { c: 1, cmd: 'MSET a 1 b 2' }, { read: 2, norm: sortedDeep }], R3),
  s('CLIENT TRACKING BCAST invalidation', ['CLIENT TRACKING ON BCAST PREFIX user:', { c: 1, cmd: 'SET user:1 x' }, { read: 1 },
    { c: 1, cmd: 'SET other y' }, 'PING'], R3),
  s('CLIENT TRACKING invalidation on FLUSHALL', ['CLIENT TRACKING ON', 'GET k', { c: 1, cmd: 'FLUSHALL' }, { read: 1 }], R3),
  s('CLIENT TRACKING NOLOOP skips own writes', ['CLIENT TRACKING ON NOLOOP', 'GET k', 'SET k v', 'PING', { c: 1, cmd: 'SET k w' }, 'GET k', { read: 1 }], R3),
  s('CLIENT TRACKING OPTIN tracks only after CACHING YES', ['CLIENT TRACKING ON OPTIN', 'GET a', 'CLIENT CACHING YES', 'GET b',
    { c: 1, cmd: 'MSET a 1' }, { c: 1, cmd: 'MSET b 1' }, { read: 1 }], R3),
  s('CLIENT TRACKING OPTOUT with CACHING NO', ['CLIENT TRACKING ON OPTOUT', 'CLIENT CACHING NO', 'GET a', 'GET b',
    { c: 1, cmd: 'MSET a 1' }, { c: 1, cmd: 'MSET b 1' }, { read: 1 }], R3),
  s('CLIENT TRACKING invalidation by expiry-free DEL', ['SET k v', 'CLIENT TRACKING ON', 'GET k', { c: 1, cmd: 'DEL k' }, { read: 1 }], R3),
  s('CLIENT TRACKING invalidation inside MULTI', ['CLIENT TRACKING ON', 'GET k', { c: 1, cmd: 'MULTI' }, { c: 1, cmd: 'SET k 1' },
    { c: 1, cmd: 'EXEC' }, { read: 1 }], R3),
  s('CLIENT TRACKING push interleaves with a reply', ['CLIENT TRACKING ON', 'GET k', 'SET k mine', 'GET k'], R3),
  s('CLIENT TRACKING OFF stops pushes', ['CLIENT TRACKING ON', 'GET k', 'CLIENT TRACKING OFF', { c: 1, cmd: 'SET k v' }, 'PING'], R3),
]);
