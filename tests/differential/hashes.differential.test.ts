import { differential, s, v } from './differential.harness';
import { shape, sorted, sortedFieldValues } from './differential.normalizers';
import { INT_PROBES_NO_NEGATIVE_COUNT, intProbes } from './differential.probes';

/** A hash with 600 fields: past the default listpack limit (512), so it is hashtable-encoded. */
const BIG = ['HSET big', ...Array.from({ length: 600 }, (_, i) => `f${i} v${i}`)].join(' ');
/** 130 fields: above 128 but within the default limit of 512, so still listpack. */
const MID = ['HSET mid', ...Array.from({ length: 130 }, (_, i) => `f${i} v${i}`)].join(' ');

differential('hashes', [
  // HSET / HMSET / HSETNX / HGET / HMGET
  s('HSET new and updated fields counts only new ones', ['HSET h a 1 b 2', 'HSET h a 10 c 3', 'HGET h a', 'HLEN h']),
  s('HSET same field twice in one call', ['HSET h a 1 a 2', 'HGET h a', 'HLEN h']),
  s('HSET odd number of arguments', ['HSET h a', 'HSET h a 1 b', 'EXISTS h']),
  s('HSET arity error', ['HSET h', 'HSET']),
  s('HMSET returns OK and its arity errors', ['HMSET h a 1 b 2', 'HMSET h a', 'HMSET h', 'HGETALL h']),
  s('HSETNX existing and new field', ['HSETNX h a 1', 'HSETNX h a 2', 'HGET h a', 'HSETNX h', 'HSETNX h a 1 2']),
  s('HGET missing key and missing field', ['HGET nokey f', 'HSET h a 1', 'HGET h nofield', 'HGET h']),
  s('HMGET mixes present and missing fields', ['HSET h a 1 b 2', 'HMGET h a x b', 'HMGET nokey a b', 'HMGET h']),
  s('empty field name and empty value', ['HSET h "" ""', 'HGET h ""', 'HSTRLEN h ""', 'HEXISTS h ""', 'HGETALL h']),
  s('binary field and value round trip', ['HSET h "\\x00\\xff" "a\\r\\nb"', 'HGET h "\\x00\\xff"', 'HKEYS h']),

  // WRONGTYPE
  s('hash commands against a string key', [
    'SET k v', 'HSET k a 1', 'HGET k a', 'HMGET k a', 'HDEL k a', 'HLEN k', 'HSTRLEN k a', 'HEXISTS k a', 'HKEYS k',
    'HVALS k', 'HGETALL k', 'HINCRBY k a 1', 'HINCRBYFLOAT k a 1', 'HSETNX k a 1', 'HRANDFIELD k', 'HSCAN k 0',
  ]),
  s('string command against a hash key', ['HSET h a 1', 'GET h', 'LPUSH h x', 'SADD h x', 'TYPE h']),

  // HDEL / HLEN / HSTRLEN / HEXISTS
  s('HDEL several fields with duplicates and missing ones', ['HSET h a 1 b 2 c 3', 'HDEL h a a x b', 'HLEN h', 'HDEL h']),
  s('HDEL last field removes the key', ['HSET h a 1', 'HDEL h a', 'EXISTS h', 'HDEL h a', 'HLEN h']),
  s('HSTRLEN of integer, float and string values', ['HSET h i 12345 n -7 f 1.5 s hello', 'HSTRLEN h i', 'HSTRLEN h n', 'HSTRLEN h f', 'HSTRLEN h s', 'HSTRLEN h x', 'HSTRLEN nokey x', 'HSTRLEN h']),
  s('HEXISTS present, missing, no key, arity', ['HSET h a 1', 'HEXISTS h a', 'HEXISTS h b', 'HEXISTS nokey a', 'HEXISTS h', 'HEXISTS h a b']),
  s('HLEN arity and missing key', ['HLEN nokey', 'HLEN', 'HLEN a b']),

  // HKEYS / HVALS / HGETALL (listpack order is insertion order)
  s('HKEYS HVALS HGETALL keep insertion order on listpack', ['HSET h z 1 a 2 m 3', 'HKEYS h', 'HVALS h', 'HGETALL h']),
  s('HKEYS HVALS HGETALL of a missing key', ['HKEYS nokey', 'HVALS nokey', 'HGETALL nokey']),
  s('updating a listpack field keeps its position', ['HSET h a 1 b 2 c 3', 'HSET h a 9', 'HGETALL h', 'HDEL h b', 'HSET h b 7', 'HGETALL h']),
  s('HKEYS arity', ['HKEYS', 'HKEYS a b', 'HVALS', 'HGETALL', 'HGETALL a b']),

  // encodings
  s('small hash is listpack', ['HSET h a 1', 'OBJECT ENCODING h']),
  s('default hash listpack limits', ['CONFIG GET hash-max-listpack-entries', 'CONFIG GET hash-max-listpack-value']),
  s('130-field hash is still listpack and ordered', [MID, 'OBJECT ENCODING mid', 'HRANDFIELD mid 1000', 'HSET mid extra 1', 'OBJECT ENCODING mid']),
  s('field count past the limit converts to hashtable', [BIG, 'OBJECT ENCODING big', 'HLEN big', { cmd: 'HKEYS big', norm: sorted }, { cmd: 'HGETALL big', norm: sortedFieldValues }]),
  s('long value converts to hashtable', ['HSET h a 1', `HSET h b ${'x'.repeat(65)}`, 'OBJECT ENCODING h', { cmd: 'HGETALL h', norm: sortedFieldValues }]),
  s('64-byte value stays listpack', [`HSET h b ${'x'.repeat(64)}`, 'OBJECT ENCODING h']),
  s('long field name converts to hashtable', [`HSET h ${'k'.repeat(65)} 1`, 'OBJECT ENCODING h']),
  s('hashtable does not convert back after deletes', [BIG, ['HDEL big', ...Array.from({ length: 598 }, (_, i) => `f${i}`)].join(' '), 'HLEN big', 'OBJECT ENCODING big', { cmd: 'HGETALL big', norm: sortedFieldValues }]),
  s('CONFIG hash-max-listpack-entries lowers the limit', ['CONFIG SET hash-max-listpack-entries 2', 'HSET h a 1 b 2', 'OBJECT ENCODING h', 'HSET h c 3', 'OBJECT ENCODING h', { cmd: 'HVALS h', norm: sorted }]),
  s('CONFIG hash-max-listpack-value lowers the limit', ['CONFIG SET hash-max-listpack-value 3', 'HSET h a 123', 'OBJECT ENCODING h', 'HSET h b 1234', 'OBJECT ENCODING h']),
  s('HINCRBY on a hashtable hash', [BIG, 'HINCRBY big n 5', 'HINCRBY big f1 1', 'HGET big n']),

  // HINCRBY
  s('HINCRBY creates key and field', ['HINCRBY h a 5', 'HINCRBY h a -7', 'HGET h a', 'HINCRBY h b 0']),
  s('HINCRBY on a non-integer value', ['HSET h a 1.5 b abc c " 1" d 01', 'HINCRBY h a 1', 'HINCRBY h b 1', 'HINCRBY h c 1', 'HINCRBY h d 1', 'HGET h d']),
  s('HINCRBY non-integer increment', ['HINCRBY h a 1.5', 'HINCRBY h a abc', 'HINCRBY h a ""', 'HINCRBY h a 99999999999999999999', 'EXISTS h']),
  s('HINCRBY overflow both ways', ['HSET h a 9223372036854775806 b -9223372036854775807', 'HINCRBY h a 1', 'HINCRBY h a 1', 'HINCRBY h b -1', 'HINCRBY h b -1', 'HGET h a', 'HGET h b']),
  s('HINCRBY extreme increments', ['HINCRBY h a 9223372036854775807', 'HINCRBY h b -9223372036854775808', 'HINCRBY h b 1', 'HINCRBY h c 9223372036854775808']),
  s('HINCRBY arity', ['HINCRBY h a', 'HINCRBY h a 1 2', 'HINCRBY']),

  // HINCRBYFLOAT
  s('HINCRBYFLOAT basic formatting', ['HINCRBYFLOAT h a 10.5', 'HINCRBYFLOAT h a 0.1', 'HINCRBYFLOAT h a -5', 'HINCRBYFLOAT h b 3', 'HINCRBYFLOAT h c 1.0e3', 'HGETALL h']),
  s('HINCRBYFLOAT long double precision', ['HINCRBYFLOAT h a 0.1', 'HINCRBYFLOAT h a 0.2', 'HINCRBYFLOAT h b 1.1', 'HINCRBYFLOAT h b 2.2', 'HINCRBYFLOAT h c 3.0000000000000004', 'HINCRBYFLOAT h d 0.30000000000000004']),
  s('HINCRBYFLOAT very large and very small values', ['HINCRBYFLOAT h a 1e20', 'HINCRBYFLOAT h b 1e-10', 'HINCRBYFLOAT h c 123456789012345678', 'HINCRBYFLOAT h d -0.0', 'HINCRBYFLOAT h e 5e300']),
  s('HINCRBYFLOAT to zero and negative', ['HINCRBYFLOAT h a 1.5', 'HINCRBYFLOAT h a -1.5', 'HINCRBYFLOAT h a -2.25']),
  s('HINCRBYFLOAT on integer value', ['HSET h a 10', 'HINCRBYFLOAT h a 0.5', 'HINCRBYFLOAT h a 0.5', 'HGET h a']),
  s('HINCRBYFLOAT inf and nan increments', ['HINCRBYFLOAT h a inf', 'HINCRBYFLOAT h a -inf', 'HINCRBYFLOAT h a nan', 'HINCRBYFLOAT h a +inf', 'EXISTS h']),
  s('HINCRBYFLOAT overflow to infinity', ['HSET h a 1e308', 'HINCRBYFLOAT h a 1e308', 'HGET h a']),
  s('HINCRBYFLOAT invalid increment and value', ['HSET h s abc', 'HINCRBYFLOAT h s 1', 'HINCRBYFLOAT h a abc', 'HINCRBYFLOAT h a "1 "', 'HINCRBYFLOAT h a ""', 'HSET h x inf', 'HINCRBYFLOAT h x 1']),
  s('HINCRBYFLOAT hex and leading spaces', ['HINCRBYFLOAT h a 0x10', 'HINCRBYFLOAT h a " 1"', 'HINCRBYFLOAT h a 1e', 'HINCRBYFLOAT h a .5', 'HINCRBYFLOAT h a 5.']),
  s('HINCRBYFLOAT arity', ['HINCRBYFLOAT h a', 'HINCRBYFLOAT h a 1 2']),

  // HRANDFIELD
  s('HRANDFIELD no count on missing and present key', ['HRANDFIELD nokey', 'HSET h a 1', 'HRANDFIELD h']),
  s('HRANDFIELD count on missing key', ['HRANDFIELD nokey 3', 'HRANDFIELD nokey 3 WITHVALUES', 'HRANDFIELD nokey -3', 'HRANDFIELD nokey 0']),
  s('HRANDFIELD count zero', ['HSET h a 1 b 2', 'HRANDFIELD h 0', 'HRANDFIELD h 0 WITHVALUES']),
  s('HRANDFIELD single-field hash is deterministic', ['HSET h a 1', 'HRANDFIELD h 1', 'HRANDFIELD h -3', 'HRANDFIELD h -2 WITHVALUES', 'HRANDFIELD h 5 WITHVALUES']),
  s('HRANDFIELD positive count shapes', ['HSET h a 1 b 2 c 3 d 4 e 5', { cmd: 'HRANDFIELD h 2', norm: shape }, { cmd: 'HRANDFIELD h 3 WITHVALUES', norm: shape }, { cmd: 'HRANDFIELD h', norm: shape }]),
  s('HRANDFIELD count at least size returns all', ['HSET h a 1 b 2 c 3', { cmd: 'HRANDFIELD h 3', norm: sorted }, { cmd: 'HRANDFIELD h 10', norm: sorted }, { cmd: 'HRANDFIELD h 10 WITHVALUES', norm: shape }]),
  s('HRANDFIELD count at least size keeps listpack order', ['HSET h a 1 b 2 c 3', 'HRANDFIELD h 3', 'HRANDFIELD h 10', 'HRANDFIELD h 10 WITHVALUES']),
  s('HRANDFIELD negative count may repeat', ['HSET h a 1 b 2', { cmd: 'HRANDFIELD h -5', norm: shape }, { cmd: 'HRANDFIELD h -4 WITHVALUES', norm: shape }]),
  s('HRANDFIELD on hashtable hash', [BIG, { cmd: 'HRANDFIELD big 5', norm: shape }, { cmd: 'HRANDFIELD big -5 WITHVALUES', norm: shape }, { cmd: 'HRANDFIELD big 200', norm: shape }]),
  s('HRANDFIELD syntax errors', ['HSET h a 1', 'HRANDFIELD h abc', 'HRANDFIELD h 1 WITHSCORES', 'HRANDFIELD h 1 WITHVALUES x', 'HRANDFIELD h 1.5', 'HRANDFIELD', 'HRANDFIELD h WITHVALUES']),
  s('HRANDFIELD huge counts', ['HSET h a 1', 'HRANDFIELD h -9223372036854775808', 'HRANDFIELD h -9223372036854775807 WITHVALUES', 'HRANDFIELD h 9223372036854775807']),

  // HSCAN
  s('HSCAN small hash returns all in one call', ['HSET h a 1 b 2 c 3', 'HSCAN h 0', 'HSCAN h 0 COUNT 1']),
  s('HSCAN NOVALUES on small hash', ['HSET h a 1 b 2', 'HSCAN h 0 NOVALUES'], v('HSCAN NOVALUES was added in 7.4')),
  s('HSCAN MATCH and missing key', ['HSET h aa 1 ab 2 b 3', 'HSCAN h 0 MATCH a*', 'HSCAN nokey 0', 'HSCAN h 0 MATCH x*']),
  s('HSCAN full iteration of a hashtable hash', [BIG, { scan: 'HSCAN big 0 COUNT 7' }, { scan: 'HSCAN big 0 MATCH f1* COUNT 3' }]),
  s('HSCAN option errors', ['HSET h a 1', 'HSCAN h abc', 'HSCAN h 0 COUNT 0', 'HSCAN h 0 COUNT -1', 'HSCAN h 0 COUNT x', 'HSCAN h 0 MATCH', 'HSCAN h 0 FOO bar', 'HSCAN h']),
  s('HSCAN cursor out of range', ['HSET h a 1', 'HSCAN h 18446744073709551615', 'HSCAN h 18446744073709551616']),
  s('HSCAN negative cursor wraps like strtoul', ['HSET h a 1', 'HSCAN h -1', 'HSCAN h " 0"', 'HSCAN h 0x1']),
  s('HSCAN TYPE option is not accepted', ['HSET h a 1', 'HSCAN h 0 TYPE string']),

  // integer arguments at the int64 and int32 edges (see differential.probes)
  ...intProbes('HRANDFIELD count', ['HSET h a 1 b 2', { cmd: 'HRANDFIELD h $N', norm: sorted }, { cmd: 'HRANDFIELD h $N WITHVALUES', norm: shape }], {}, INT_PROBES_NO_NEGATIVE_COUNT),
  ...intProbes('HSCAN COUNT', ['HSET h a 1', 'HSCAN h 0 COUNT $N']),
  ...intProbes('HINCRBY', ['HSET h a 1', 'HINCRBY h a $N', 'HGET h a', 'HINCRBY h b $N', 'HINCRBY h b $N', 'HGET h b']),
]);
