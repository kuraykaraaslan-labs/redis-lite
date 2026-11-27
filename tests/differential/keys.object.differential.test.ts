import { differential, s, v } from './differential.harness';
import { anyNumber } from './differential.normalizers';

const many = (cmd: string, n: number, item: (i: number) => string): string => `${cmd} ${Array.from({ length: n }, (_, i) => item(i)).join(' ')}`;
const LONG = 'x'.repeat(65);

differential('keys object', [
  // strings: int / embstr / raw
  s('OBJECT ENCODING strings', [
    'SET i 12345', 'SET neg -5', 'SET big 9223372036854775807', 'SET over 9223372036854775808', 'SET lead 0123', 'SET e44 ' + 'a'.repeat(44),
    'SET e45 ' + 'a'.repeat(45), 'SET f 1.5', 'SET sp " 1"', 'SET z 0', 'SET mz -0',
    'OBJECT ENCODING i', 'OBJECT ENCODING neg', 'OBJECT ENCODING big', 'OBJECT ENCODING over', 'OBJECT ENCODING lead',
    'OBJECT ENCODING e44', 'OBJECT ENCODING e45', 'OBJECT ENCODING f', 'OBJECT ENCODING sp', 'OBJECT ENCODING z', 'OBJECT ENCODING mz',
  ]),
  s('OBJECT ENCODING after string writes', [
    'SET a abc', 'APPEND a d', 'OBJECT ENCODING a', 'SET b 10', 'APPEND b 0', 'OBJECT ENCODING b', 'SET c abc', 'SETRANGE c 0 x',
    'OBJECT ENCODING c', 'INCR n', 'OBJECT ENCODING n', 'INCRBYFLOAT fl 1.5', 'OBJECT ENCODING fl', 'SETBIT bm 1 1', 'OBJECT ENCODING bm',
    'GETRANGE b 0 -1', 'OBJECT ENCODING b',
  ]),
  s('OBJECT ENCODING after INCRBYFLOAT', ['SET d 10', 'INCRBYFLOAT d 1', 'OBJECT ENCODING d', 'INCRBYFLOAT e 1.5', 'OBJECT ENCODING e']),
  s('OBJECT ENCODING large integer-looking strings', ['SET k 12345678901234567890', 'OBJECT ENCODING k', 'SET m 10000', 'OBJECT ENCODING m', 'SET n 10001', 'OBJECT ENCODING n']),

  // hashes
  s('OBJECT ENCODING hash default entries threshold is 512', [many('HSET h', 512, (i) => `f${i} v`), 'OBJECT ENCODING h', 'HSET h f512 v', 'OBJECT ENCODING h']),
  s('OBJECT ENCODING hash listpack to hashtable by count', [
    'CONFIG SET hash-max-listpack-entries 128', many('HSET h', 128, (i) => `f${i} v`), 'OBJECT ENCODING h', 'HSET h f128 v', 'OBJECT ENCODING h', 'HDEL h f0 f1', 'OBJECT ENCODING h',
  ]),
  s('OBJECT ENCODING hash listpack to hashtable by value size', ['HSET h f ' + 'v'.repeat(64), 'OBJECT ENCODING h', 'HSET h g ' + LONG, 'OBJECT ENCODING h', 'HSET k ' + LONG + ' v', 'OBJECT ENCODING k']),

  // lists
  s('OBJECT ENCODING list small', ['RPUSH l a b c', 'OBJECT ENCODING l']),
  s('OBJECT ENCODING list of short items', [many('RPUSH l', 200, (i) => `e${i}`), 'OBJECT ENCODING l']),
  s('OBJECT ENCODING list with a big item', ['RPUSH m ' + 'y'.repeat(9000), 'OBJECT ENCODING m', many('RPUSH n', 2000, (i) => `item${i}`), 'OBJECT ENCODING n']),

  // sets
  s('OBJECT ENCODING set intset', ['SADD s 1 2 3', 'OBJECT ENCODING s', 'SADD n -5 9223372036854775807', 'OBJECT ENCODING n']),
  s('OBJECT ENCODING set intset to hashtable by count', [many('SADD s', 512, (i) => String(i)), 'OBJECT ENCODING s', 'SADD s 512', 'OBJECT ENCODING s']),
  s('OBJECT ENCODING set with strings', ['SADD s a b', 'OBJECT ENCODING s', 'SADD t 1 2', 'SADD t x', 'OBJECT ENCODING t']),
  s('OBJECT ENCODING set big strings', [many('SADD s', 129, (i) => `m${i}`), 'OBJECT ENCODING s', 'SADD t ' + LONG, 'OBJECT ENCODING t']),
  s('OBJECT ENCODING set out of int64 range', ['SADD s 9223372036854775808', 'OBJECT ENCODING s']),

  // sorted sets
  s('OBJECT ENCODING zset listpack to skiplist', [
    many('ZADD z', 128, (i) => `${i} m${i}`), 'OBJECT ENCODING z', 'ZADD z 999 m128', 'OBJECT ENCODING z', 'ZADD y 1 ' + LONG, 'OBJECT ENCODING y',
    'ZADD x 1 ' + 'm'.repeat(64), 'OBJECT ENCODING x',
  ]),

  // streams and HLL
  s('OBJECT ENCODING stream and hll', ['XADD x 1-1 f v', 'OBJECT ENCODING x', 'PFADD h a', 'OBJECT ENCODING h']),

  // threshold configs
  s('OBJECT ENCODING follows config thresholds', [
    'CONFIG SET hash-max-listpack-entries 2', 'HSET h a 1 b 2', 'OBJECT ENCODING h', 'HSET h c 3', 'OBJECT ENCODING h',
    'CONFIG SET zset-max-listpack-entries 1', 'ZADD z 1 a', 'OBJECT ENCODING z', 'ZADD z 2 b', 'OBJECT ENCODING z',
  ]),
  s('OBJECT ENCODING set-max-intset-entries', ['CONFIG SET set-max-intset-entries 2', 'SADD s 1 2', 'OBJECT ENCODING s', 'SADD s 3', 'OBJECT ENCODING s']),
  s('OBJECT ENCODING zset-max-listpack-value', ['CONFIG SET zset-max-listpack-value 3', 'ZADD z 1 abc', 'OBJECT ENCODING z', 'ZADD z 2 abcd', 'OBJECT ENCODING z']),
  s('OBJECT ENCODING after conversion stays', [many('HSET h', 600, (i) => `f${i} v`), 'OBJECT ENCODING h', 'HDEL h ' + Array.from({ length: 599 }, (_, i) => `f${i}`).join(' '), 'OBJECT ENCODING h', 'HLEN h']),

  // OBJECT subcommands
  s('OBJECT ENCODING missing and errors', ['OBJECT ENCODING missing', 'OBJECT ENCODING', 'OBJECT ENCODING a b', 'OBJECT FOO k', 'OBJECT']),
  s('OBJECT REFCOUNT', ['SET k v', 'OBJECT REFCOUNT k', 'SET n 100', 'OBJECT REFCOUNT n', 'SET big 100000', 'OBJECT REFCOUNT big', 'OBJECT REFCOUNT missing', 'RPUSH l a', 'OBJECT REFCOUNT l']),
  s('OBJECT REFCOUNT shared integers boundary', ['SET a 9999', 'SET b 10000', 'SET c -1', 'SET d 0', 'OBJECT REFCOUNT a', 'OBJECT REFCOUNT b', 'OBJECT REFCOUNT c', 'OBJECT REFCOUNT d']),
  s('OBJECT FREQ without LFU', ['SET k v', 'OBJECT FREQ k', 'OBJECT FREQ missing']),
  s('OBJECT FREQ with LFU', ['CONFIG SET maxmemory-policy allkeys-lfu', 'SET k v', 'OBJECT FREQ k', 'OBJECT FREQ missing', 'OBJECT IDLETIME k']),
  s('OBJECT IDLETIME', ['SET k v', { cmd: 'OBJECT IDLETIME k', norm: anyNumber }, 'OBJECT IDLETIME missing', 'OBJECT IDLETIME']),
  s('OBJECT IDLETIME with LFU policy', ['CONFIG SET maxmemory-policy volatile-lfu', 'SET k v', 'OBJECT IDLETIME k']),
  s('OBJECT arity per subcommand', ['OBJECT FREQ', 'OBJECT REFCOUNT', 'OBJECT IDLETIME a b', 'OBJECT REFCOUNT a b', 'OBJECT FREQ a b']),
  s('OBJECT HELP', ['OBJECT HELP'], v('the HELP footer line reads "Print this help." after 7.0 (7.0: "Prints this help.")', 'low')),
]);
