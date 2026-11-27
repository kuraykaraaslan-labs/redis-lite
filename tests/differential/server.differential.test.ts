import { differential, s, v } from './differential.harness';
import { aclRules, anyNumber, debugObject, digits, shape, sorted, text } from './differential.normalizers';
import type { Normalizer } from './differential.normalizers';
import { intProbes } from './differential.probes';
import { isAggregate, parseResp, payload, serialize } from './differential.resp';
import type { RespNode } from './differential.resp';

/** ACL LOG: masks `age-seconds` (a clock) and `client-info` (a CLIENT LIST line, see clientInfo). */
const aclLogEntry: Normalizer = (reply) => {
  const mask = (node: RespNode): RespNode => {
    if (!isAggregate(node)) return node;
    const children = node.children.map(mask);
    for (let i = 0; i + 1 < children.length; i += 2) {
      if (['age-seconds', 'client-info'].includes(payload(children[i]))) children[i + 1] = { type: '+', head: 'MASKED', raw: '+MASKED\r\n', children: [] };
    }
    return { ...node, children };
  };
  return serialize(mask(parseResp(reply).node));
};

/** LOLWUT 6 draws a random skyline: every cell becomes `c` (the canvas size and the caption are compared). */
const skyline = text((r) => r.replace(/\x1b\[0;(97;107|37;47|90;100|30;40)m \x1b\[0m/g, 'c').replace(/^\$\d+/, '$N'));
/** The generic HELP footer of subcommand help replies. */
const HELP_TEXT = 'the HELP footer reads "Print this help." in newer Redis (7.0: "Prints this help.")';

// server-level commands: DBSIZE / FLUSH* / TIME / LASTSAVE / OBJECT / MEMORY / DEBUG / SLOWLOG / LATENCY / SWAPDB / WAIT
differential('server', [
  // DBSIZE / FLUSHDB / FLUSHALL
  s('DBSIZE empty and after writes', ['DBSIZE', 'MSET a 1 b 2 c 3', 'DBSIZE', 'DEL a', 'DBSIZE']),
  s('DBSIZE counts only the selected db', ['SET a 1', 'SELECT 1', 'DBSIZE', 'SET b 1', 'SET c 1', 'DBSIZE', 'SELECT 0', 'DBSIZE']),
  s('DBSIZE arity', ['DBSIZE x']),
  s('FLUSHDB plain, SYNC and ASYNC', ['SET a 1', 'FLUSHDB', 'DBSIZE', 'SET a 1', 'FLUSHDB SYNC', 'DBSIZE', 'SET a 1', 'FLUSHDB ASYNC', 'DBSIZE']),
  s('FLUSHDB lowercase modifier', ['SET a 1', 'FLUSHDB async', 'DBSIZE']),
  s('FLUSHDB invalid modifier', ['FLUSHDB bogus', 'FLUSHDB SYNC ASYNC']),
  s('FLUSHDB only flushes the selected db', ['SET a 1', 'SELECT 1', 'SET b 1', 'FLUSHDB', 'SELECT 0', 'DBSIZE']),
  s('FLUSHALL clears every db', ['SET a 1', 'SELECT 1', 'SET b 1', 'FLUSHALL', 'DBSIZE', 'SELECT 0', 'DBSIZE']),
  s('FLUSHALL modifiers', ['FLUSHALL SYNC', 'FLUSHALL ASYNC', 'FLUSHALL bogus', 'FLUSHALL SYNC x']),

  // TIME / LASTSAVE
  s('TIME returns seconds and microseconds', [{ cmd: 'TIME', norm: anyNumber }]),
  s('TIME arity', ['TIME x']),
  s('LASTSAVE is an integer', [{ cmd: 'LASTSAVE', norm: anyNumber }]),
  s('LASTSAVE arity', ['LASTSAVE x']),

  // OBJECT
  s('OBJECT ENCODING of strings', ['SET i 12345', 'SET e short', 'SET r "this string is definitely longer than forty-four bytes, so raw"',
    'OBJECT ENCODING i', 'OBJECT ENCODING e', 'OBJECT ENCODING r']),
  s('OBJECT ENCODING after APPEND', ['SET k abc', 'APPEND k def', 'OBJECT ENCODING k', 'SET n 1', 'APPEND n 2', 'OBJECT ENCODING n']),
  s('OBJECT ENCODING of integer edge values', ['SET a -1', 'SET b 9223372036854775807', 'SET c 9223372036854775808', 'SET d 01',
    'OBJECT ENCODING a', 'OBJECT ENCODING b', 'OBJECT ENCODING c', 'OBJECT ENCODING d']),
  s('OBJECT ENCODING of small collections', ['SADD si 1 2', 'HSET h f v', 'ZADD z 1 a',
    'OBJECT ENCODING si', 'OBJECT ENCODING h', 'OBJECT ENCODING z']),
  s('OBJECT ENCODING of a small list', ['RPUSH l a', 'OBJECT ENCODING l']),
  s('OBJECT ENCODING of a small string set', ['SADD ss a', 'OBJECT ENCODING ss']),
  s('OBJECT ENCODING of a large list', ['CONFIG SET list-max-listpack-size 2', 'RPUSH l a b c d e', 'OBJECT ENCODING l']),
  s('OBJECT ENCODING of a stream', ['XADD x 1-1 f v', 'OBJECT ENCODING x']),
  s('OBJECT ENCODING after growing past thresholds', [
    'CONFIG SET hash-max-listpack-entries 1', 'HSET h a 1 b 2', 'OBJECT ENCODING h',
    'CONFIG SET zset-max-listpack-entries 1', 'ZADD z 1 a 2 b', 'OBJECT ENCODING z',
  ]),
  s('OBJECT ENCODING of an intset past set-max-intset-entries', ['CONFIG SET set-max-intset-entries 2', 'SADD s 1 2 3', 'OBJECT ENCODING s']),
  s('OBJECT ENCODING of a set past both limits', ['CONFIG SET set-max-intset-entries 2', 'CONFIG SET set-max-listpack-entries 2', 'SADD s 1 2 3',
    'OBJECT ENCODING s']),
  s('OBJECT ENCODING of a long hash value', ['HSET h f "0123456789012345678901234567890123456789012345678901234567890123456789"', 'OBJECT ENCODING h']),
  s('OBJECT ENCODING missing key', ['OBJECT ENCODING nokey']),
  s('OBJECT REFCOUNT', ['SET k v', 'OBJECT REFCOUNT k', 'OBJECT REFCOUNT nokey']),
  s('OBJECT IDLETIME', ['SET k v', { cmd: 'OBJECT IDLETIME k', norm: anyNumber }, 'OBJECT IDLETIME nokey']),
  s('OBJECT FREQ without an LFU policy', ['SET k v', 'OBJECT FREQ k']),
  s('OBJECT FREQ with an LFU policy', ['CONFIG SET maxmemory-policy allkeys-lfu', 'SET k v', { cmd: 'OBJECT FREQ k', norm: anyNumber }]),
  s('OBJECT IDLETIME with an LFU policy', ['CONFIG SET maxmemory-policy allkeys-lfu', 'SET k v', 'OBJECT IDLETIME k']),
  s('OBJECT unknown subcommand', ['OBJECT bogus k', 'OBJECT']),
  s('OBJECT ENCODING arity', ['OBJECT ENCODING', 'OBJECT ENCODING a b']),
  s('OBJECT HELP', ['OBJECT HELP'], v(HELP_TEXT, 'medium')),

  // MEMORY
  s('MEMORY USAGE of an existing key', ['SET k v', { cmd: 'MEMORY USAGE k', norm: anyNumber }]),
  s('MEMORY USAGE of a missing key', ['MEMORY USAGE nokey']),
  s('MEMORY USAGE SAMPLES', ['RPUSH l a b c', { cmd: 'MEMORY USAGE l SAMPLES 0', norm: anyNumber }, { cmd: 'MEMORY USAGE l SAMPLES 2', norm: anyNumber }]),
  s('MEMORY USAGE errors', ['MEMORY USAGE', 'MEMORY USAGE k SAMPLES', 'MEMORY USAGE k SAMPLES abc', 'MEMORY USAGE k bogus 1']),
  s('MEMORY USAGE SAMPLES negative', ['SET k v', 'MEMORY USAGE k SAMPLES -1']),
  s('MEMORY DOCTOR is a string', [{ cmd: 'MEMORY DOCTOR', norm: shape }]),
  s('MEMORY DOCTOR of an empty instance', ['MEMORY DOCTOR']),
  s('MEMORY STATS shape', [{ cmd: 'MEMORY STATS', norm: shape }],
    v('MEMORY STATS gained fields after 7.0 (e.g. overhead.db.hashtable.lut, db.dict.rehashing.count in 7.4)', 'medium')),
  s('MEMORY MALLOC-STATS is a string', [{ cmd: 'MEMORY MALLOC-STATS', norm: shape }]),
  s('MEMORY PURGE', ['MEMORY PURGE']),
  s('MEMORY unknown subcommand', ['MEMORY bogus', 'MEMORY']),

  // DEBUG
  s('DEBUG SLEEP 0', ['DEBUG SLEEP 0']),
  s('DEBUG OBJECT of an embstr', ['SET k v', { cmd: 'DEBUG OBJECT k', norm: debugObject }]),
  s('DEBUG OBJECT of an int', ['SET k 123', { cmd: 'DEBUG OBJECT k', norm: debugObject }]),
  s('DEBUG OBJECT of a raw string', ['SET k "this string is definitely longer than forty-four bytes, so raw"', { cmd: 'DEBUG OBJECT k', norm: debugObject }]),
  s('DEBUG OBJECT of a small list', ['RPUSH l a b c', { cmd: 'DEBUG OBJECT l', norm: debugObject }]),
  s('DEBUG OBJECT of a quicklist', ['CONFIG SET list-max-listpack-size 2', 'RPUSH l a b c d e', { cmd: 'DEBUG OBJECT l', norm: debugObject }]),
  s('DEBUG OBJECT of a hash', ['HSET h f v g w', { cmd: 'DEBUG OBJECT h', norm: debugObject }]),
  s('DEBUG OBJECT of a set and a zset', ['SADD s 1 2 3', 'ZADD z 1 a', { cmd: 'DEBUG OBJECT s', norm: debugObject }, { cmd: 'DEBUG OBJECT z', norm: debugObject }]),
  s('DEBUG OBJECT missing key', ['DEBUG OBJECT nokey']),
  s('DEBUG unknown subcommand', ['DEBUG JMAP', 'DEBUG bogus']),
  s('DEBUG without subcommand', ['DEBUG']),
  s('DEBUG SLEEP invalid', ['DEBUG SLEEP abc']),

  // SLOWLOG
  s('SLOWLOG LEN and GET when empty', ['SLOWLOG LEN', 'SLOWLOG GET']),
  s('SLOWLOG RESET', ['SLOWLOG RESET', 'SLOWLOG LEN']),
  s('SLOWLOG GET with a count', ['SLOWLOG GET 5', 'SLOWLOG GET 0', 'SLOWLOG GET -1']),
  s('SLOWLOG GET invalid count', ['SLOWLOG GET abc', 'SLOWLOG GET -2']),
  s('SLOWLOG records every command at threshold 0', [
    'CONFIG SET slowlog-log-slower-than 0', 'SLOWLOG RESET', 'SET k v', { cmd: 'SLOWLOG LEN', norm: anyNumber },
  ]),
  s('SLOWLOG entry shape', [
    'CONFIG SET slowlog-log-slower-than 0', 'SLOWLOG RESET', 'SET k v', { cmd: 'SLOWLOG GET 1', norm: shape },
  ]),
  s('SLOWLOG unknown subcommand', ['SLOWLOG bogus', 'SLOWLOG']),
  s('SLOWLOG HELP', ['SLOWLOG HELP'], v(HELP_TEXT, 'medium')),

  // LATENCY
  s('LATENCY LATEST when empty', ['LATENCY LATEST']),
  s('LATENCY HISTORY of an unknown event', ['LATENCY HISTORY command']),
  s('LATENCY RESET', ['LATENCY RESET', 'LATENCY RESET command']),
  s('LATENCY DOCTOR is a string', [{ cmd: 'LATENCY DOCTOR', norm: shape }]),
  s('LATENCY GRAPH of an unknown event', ['LATENCY GRAPH command']),
  s('LATENCY HISTOGRAM shape', ['SET k v', { cmd: 'LATENCY HISTOGRAM set', norm: shape }]),
  s('LATENCY HISTOGRAM of a never-called command', ['LATENCY HISTOGRAM lpush']),
  s('LATENCY unknown subcommand', ['LATENCY bogus', 'LATENCY']),
  s('LATENCY DOCTOR texts', ['LATENCY DOCTOR', 'CONFIG SET latency-monitor-threshold 100', 'LATENCY DOCTOR']),
  s('LATENCY monitor records a slow command', ['CONFIG SET latency-monitor-threshold 5', 'DEBUG SLEEP 0.02',
    { cmd: 'LATENCY LATEST', norm: anyNumber }, { cmd: 'LATENCY HISTORY command', norm: anyNumber }, { cmd: 'LATENCY GRAPH command', norm: digits },
    { cmd: 'LATENCY DOCTOR', norm: digits }, 'LATENCY RESET nosuch command', 'LATENCY LATEST', 'LATENCY GRAPH command', 'LATENCY RESET']),

  // LOLWUT
  s('LOLWUT VERSION 5 banner', ['LOLWUT VERSION 5 1 1 1']),
  s('LOLWUT VERSION 5 several rows', ['LOLWUT VERSION 5 3 1 1', 'LOLWUT VERSION 5 0 0 0']),
  s('LOLWUT default output', ['LOLWUT']),
  s('LOLWUT other versions print only the version', ['LOLWUT VERSION 1', 'LOLWUT VERSION 4 x', 'LOLWUT VERSION 7']),
  s('LOLWUT VERSION 6 canvas', [{ cmd: 'LOLWUT VERSION 6 10 5', norm: skyline }, { cmd: 'LOLWUT VERSION 6 0 0', norm: skyline },
    { cmd: 'LOLWUT VERSION 6', norm: skyline }]),
  s('LOLWUT VERSION 6 invalid size', ['LOLWUT VERSION 6 abc', 'LOLWUT VERSION 6 3 x', 'LOLWUT VERSION 5 x']),
  s('LOLWUT invalid version', ['LOLWUT VERSION abc']),

  // SWAPDB
  s('SWAPDB swaps two databases', ['SET a 0', 'SELECT 1', 'SET b 1', 'SWAPDB 0 1', 'GET a', 'GET b', 'SELECT 0', 'GET a', 'GET b']),
  s('SWAPDB same index', ['SWAPDB 0 0']),
  s('SWAPDB out of range', ['SWAPDB 0 16', 'SWAPDB -1 0']),
  s('SWAPDB non-integer', ['SWAPDB a 0', 'SWAPDB 0 b']),
  s('SWAPDB arity', ['SWAPDB 0', 'SWAPDB 0 1 2']),

  // WAIT / WAITAOF
  s('WAIT without replicas', ['WAIT 0 0', 'WAIT 1 1']),
  s('WAIT invalid arguments', ['WAIT abc 0', 'WAIT 0 abc', 'WAIT 0 -1']),
  s('WAIT arity', ['WAIT 0']),
  s('WAITAOF without appendonly', ['WAITAOF 1 0 0'], v('WAITAOF was added in 7.2')),

  // ACL (every scenario restarts the oracle: users are server state FLUSHALL does not reset)
  s('ACL WHOAMI', ['ACL WHOAMI']),
  s('ACL CAT lists categories', [{ cmd: 'ACL CAT', norm: sorted }], v('Redis 8 bundles RedisTimeSeries, which registers the @timeseries ACL category', 'medium')),
  s('ACL CAT of a category', [{ cmd: 'ACL CAT hyperloglog', norm: sorted }]),
  s('ACL CAT of an unknown category', ['ACL CAT bogus']),
  s('ACL LIST of the default user', ['ACL LIST']),
  s('ACL USERS', ['ACL USERS']),
  s('ACL GETUSER default', ['ACL GETUSER default']),
  s('ACL GETUSER unknown user', ['ACL GETUSER nouser']),
  s('ACL SETUSER creates a user', ['ACL SETUSER alice', 'ACL GETUSER alice', 'ACL LIST', 'ACL USERS'], { fresh: true }),
  s('ACL SETUSER with rules', ['ACL SETUSER alice on >pw ~k* +get', 'ACL LIST'], { fresh: true }),
  s('ACL SETUSER with categories and channels', ['ACL SETUSER bob on nopass ~* &news:* +@read -@dangerous',
    { cmd: 'ACL GETUSER bob', norm: aclRules }], { fresh: true }),
  s('ACL SETUSER with an invalid rule', ['ACL SETUSER x bogus', 'ACL SETUSER x +nosuchcmd', 'ACL SETUSER x +@nosuchcat', 'ACL USERS'], { fresh: true }),
  s('ACL SETUSER with a bad password hash', ['ACL SETUSER x #abc'], { fresh: true }),
  s('ACL SETUSER reset and resetkeys', ['ACL SETUSER alice on ~a* +get', 'ACL SETUSER alice resetkeys ~b*', 'ACL LIST',
    'ACL SETUSER alice reset', 'ACL LIST'], { fresh: true }),
  s('ACL DELUSER', ['ACL SETUSER alice', 'ACL DELUSER alice nouser', 'ACL DELUSER alice', 'ACL USERS'], { fresh: true }),
  s('ACL DELUSER default is refused', ['ACL DELUSER default']),
  s('AUTH as a new user and run allowed commands', ['ACL SETUSER alice on >pw ~k* +get +acl|whoami', 'SET k1 v', 'AUTH alice pw',
    'ACL WHOAMI', 'GET k1'], { fresh: true }),
  s('AUTH with a wrong password for a new user', ['ACL SETUSER alice on >pw', 'AUTH alice bad', 'ACL WHOAMI'], { fresh: true }),
  s('AUTH as a disabled user', ['ACL SETUSER alice off >pw', 'AUTH alice pw'], { fresh: true }),
  s('NOPERM for a denied command', ['ACL SETUSER alice on >pw ~* +get', 'AUTH alice pw', 'SET k v'], { fresh: true }),
  s('NOPERM for a denied key', ['ACL SETUSER alice on >pw ~k* +get', 'AUTH alice pw', 'GET other'], { fresh: true }),
  s('NOPERM for a denied channel and inside MULTI', ['ACL SETUSER alice on >pw ~k* &ch* +publish +set +multi +exec', 'AUTH alice pw',
    'PUBLISH other m', 'MULTI', 'SET other v', 'EXEC'], { fresh: true }),
  s('NOPERM inside a script', ['ACL SETUSER alice on >pw ~k* +eval +set', 'AUTH alice pw',
    'EVAL "return redis.call(\'set\',\'other\',\'v\')" 0', 'EVAL "return redis.call(\'del\',\'k1\')" 0',
    'EVAL "return redis.pcall(\'del\',\'k1\')" 0'], { fresh: true }),
  s('ACL DRYRUN', ['ACL SETUSER alice on ~k* +get', 'ACL DRYRUN alice get k1', 'ACL DRYRUN alice set k1 v', 'ACL DRYRUN nouser get k'],
    { fresh: true }),
  s('ACL DRYRUN keys, channels, subcommands and arity', ['ACL SETUSER alice on ~k* &ch* +get +publish', 'ACL DRYRUN alice get other',
    'ACL DRYRUN alice publish other m', 'ACL DRYRUN alice publish ch1 m', 'ACL DRYRUN alice client id', 'ACL DRYRUN alice get k1 extra',
    'ACL DRYRUN alice nosuch'], { fresh: true }),
  s('ACL describes command rules from the command bitmap', ['ACL SETUSER u1 +@hash +@set', 'ACL SETUSER u2 +@list +@set +@sortedset +@string +@hash',
    'ACL SETUSER u3 +@read +@write -@keyspace', 'ACL SETUSER u4 +@all -@dangerous +flushdb -debug +config|get', 'ACL SETUSER u5 +@admin +@dangerous',
    'ACL SETUSER u6 +@blocking +@list', 'ACL SETUSER u7 +@all -flushall -@admin', 'ACL SETUSER u8 -@all +@string -@write +set',
    'ACL SETUSER u9 +@hash -hget -hset -hdel -hlen -hkeys -hvals -hmget', 'ACL SETUSER u10 +@hash -hget -hset -hdel -hlen -hkeys -hvals -hmget -hmset',
    { cmd: 'ACL LIST', norm: aclRules }], { fresh: true }),
  s('ACL describes containers and first arguments', ['ACL SETUSER f1 +@all -select +select|0 +select|1', 'ACL SETUSER f2 -@all +get +select|0 +set',
    'ACL SETUSER f3 -@all +select|0 +select', 'ACL SETUSER f4 -@all +select|0 -select', 'ACL SETUSER f5 allkeys allcommands -client +client|setname',
    'ACL SETUSER f6 +@all -client|kill', 'ACL SETUSER f7 -@all +client -client|kill', 'ACL SETUSER f8 +@all -@slow',
    { cmd: 'ACL LIST', norm: aclRules }, { cmd: 'ACL GETUSER f1', norm: aclRules }], { fresh: true }),
  s('ACL sanitize-payload flags', ['ACL SETUSER s1 on skip-sanitize-payload +@all', 'ACL SETUSER s2 on sanitize-payload',
    'ACL SETUSER s3 reset', 'ACL SETUSER s4 nopass resetpass', 'ACL LIST', 'ACL GETUSER s1'], { fresh: true }),
  s('ACL GETUSER with passwords and selectors', ['ACL SETUSER fi on >a >b <a #0000000000000000000000000000000000000000000000000000000000000000 ~a ~b &x &y (~c +get) (+@read %W~d)',
    'ACL GETUSER fi', 'ACL LIST'], { fresh: true }),
  s('ACL LOG when empty', ['ACL LOG', 'ACL LOG RESET', 'ACL LOG 1']),
  s('ACL LOG records a denied command', ['ACL SETUSER alice on >pw ~* +get', 'AUTH alice pw', 'SET k v', 'AUTH default x',
    { cmd: 'ACL LOG', norm: shape }], { fresh: true }),
  s('ACL LOG entry fields', ['ACL SETUSER alice on >pw ~k* &ch* +get +publish +multi +exec +set', 'AUTH alice pw', 'PUBLISH other m',
    'MULTI', 'SET other v', 'EXEC', 'GET other', 'GET other', 'AUTH alice bad', 'AUTH default x',
    { cmd: 'ACL LOG', norm: shape }, { cmd: 'ACL LOG 3', norm: aclLogEntry }],
    { fresh: true }),
  s('ACL LOG invalid count', ['ACL LOG abc', 'ACL LOG -1']),
  s('ACL GENPASS', [{ cmd: 'ACL GENPASS', norm: shape }, { cmd: 'ACL GENPASS 32', norm: shape }, 'ACL GENPASS 0', 'ACL GENPASS abc']),
  s('ACL unknown subcommand', ['ACL bogus', 'ACL']),

  // misc
  s('ROLE of a master', ['ROLE']),
  s('ECHO in MULTI', ['MULTI', 'ECHO x', 'TIME', 'EXEC'], { norm: anyNumber }),
  s('SAVE and BGSAVE are not tested; LASTSAVE stable twice', [{ cmd: 'LASTSAVE', norm: anyNumber }, { cmd: 'LASTSAVE', norm: anyNumber }]),
  s('READONLY and READWRITE outside cluster mode', ['READONLY', 'READWRITE']),
  s('MONITOR is not sent; COMMAND on unknown subcommand', ['COMMAND bogus']),

  // integer arguments at the int64 and int32 edges (see differential.probes)
  ...intProbes('SLOWLOG GET', ['SLOWLOG GET $N']),
  ...intProbes('ACL LOG and GENPASS', ['ACL LOG $N', 'ACL GENPASS $N']),
  ...intProbes('LOLWUT', [{ cmd: 'LOLWUT VERSION $N', norm: shape }, { cmd: 'LOLWUT VERSION 5 $N', norm: shape }, { cmd: 'LOLWUT VERSION 6 1 $N', norm: shape }]),
  ...intProbes('FAILOVER TIMEOUT', ['FAILOVER TIMEOUT $N']),
  ...intProbes('FAILOVER TO port', ['FAILOVER TO localhost $N']),
  ...intProbes('WAIT', ['WAIT $N 1', 'WAIT 0 $N']),
  ...intProbes('OBJECT and MEMORY', ['SET k v', 'MEMORY USAGE k SAMPLES $N']),
]);
