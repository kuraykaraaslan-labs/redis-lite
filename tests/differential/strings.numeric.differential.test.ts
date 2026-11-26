import { differential, s } from './differential.harness';

differential('strings numeric', [
  // INCR / DECR / INCRBY / DECRBY
  s('INCR DECR basics', ['INCR k', 'INCR k', 'DECR k', 'DECR k', 'DECR k', 'GET k', 'INCRBY k 10', 'DECRBY k 25', 'GET k']),
  s('INCR on non-integer texts', [
    'SET a abc', 'INCR a', 'SET b 1.5', 'INCR b', 'SET c " 1"', 'INCR c', 'SET d "1 "', 'INCR d', 'SET e 01', 'INCR e',
    'SET f +1', 'INCR f', 'SET g ""', 'INCR g', 'SET i 1e3', 'INCR i',
  ]),
  s('INCR on integer limits', [
    'SET k 9223372036854775806', 'INCR k', 'INCR k', 'GET k', 'SET m -9223372036854775807', 'DECR m', 'DECR m', 'GET m',
  ]),
  s('INCR on out-of-range text', ['SET k 9223372036854775808', 'INCR k', 'SET m -9223372036854775809', 'DECR m', 'SET n 99999999999999999999', 'INCR n']),
  s('INCRBY overflow', ['SET k 9223372036854775000', 'INCRBY k 1000', 'INCRBY k 807', 'GET k', 'SET n -5', 'INCRBY n -9223372036854775804', 'INCRBY n -9223372036854775803']),
  s('INCRBY argument errors', ['INCRBY k abc', 'INCRBY k 1.5', 'INCRBY k 9223372036854775808', 'INCRBY k ""', 'INCRBY k " 1"', 'EXISTS k']),
  s('DECRBY with the minimum integer', ['SET k 0', 'DECRBY k -9223372036854775808', 'DECRBY k 9223372036854775807', 'GET k', 'DECRBY k 1', 'DECRBY k 1']),
  s('INCR on wrong type', ['RPUSH l a', 'INCR l', 'DECR l', 'INCRBY l 1', 'DECRBY l 1', 'INCRBYFLOAT l 1']),
  s('INCR arity', ['INCR', 'INCR a b', 'INCRBY a', 'DECRBY a', 'DECR', 'INCRBYFLOAT a', 'INCRBY a 1 2']),
  s('INCR keeps TTL and encoding', ['SET k 10 EX 100', 'INCR k', 'TTL k', 'OBJECT ENCODING k', 'SET big 12345678901234567', 'INCR big', 'OBJECT ENCODING big']),
  s('INCR on negative zero text', ['SET k -0', 'INCR k', 'INCRBY k 0', 'DECR k']),
  s('INCRBY with negative zero increment', ['SET k 5', 'INCRBY k -0', 'DECRBY k -0', 'GET k']),
  s('INCR on leading zeros', ['SET z 007', 'DECR z', 'SET y 00', 'INCR y']),

  // INCRBYFLOAT
  s('INCRBYFLOAT formatting', ['SET f 10.5', 'INCRBYFLOAT f 0.1', 'INCRBYFLOAT f 5.0e3', 'INCRBYFLOAT f -10050.6']),
  s('INCRBYFLOAT basics', ['INCRBYFLOAT k 1', 'INCRBYFLOAT k 0.5', 'INCRBYFLOAT k -1.5', 'GET k', 'INCRBYFLOAT k 3', 'GET k']),
  s('INCRBYFLOAT exponents', ['SET k 0', 'INCRBYFLOAT k 1e5', 'INCRBYFLOAT k 1.5E-3', 'INCRBYFLOAT k 2e+2', 'INCRBYFLOAT k -1e10', 'SET e 3e2', 'INCRBYFLOAT e 1']),
  s('INCRBYFLOAT long double precision', [
    'SET k 0.1', 'INCRBYFLOAT k 0.2', 'INCRBYFLOAT k 0.3', 'SET a 1', 'INCRBYFLOAT a 0.0000001', 'SET b 3', 'INCRBYFLOAT b 0.1',
    'SET c 5.0e3', 'INCRBYFLOAT c 0', 'SET d 1.10', 'INCRBYFLOAT d 0',
  ]),
  s('INCRBYFLOAT large values', ['SET k 1e300', 'INCRBYFLOAT k 1', 'SET m 123456789012345678', 'INCRBYFLOAT m 1', 'SET n 1e20', 'INCRBYFLOAT n 0', 'INCRBYFLOAT x 1e17']),
  s('INCRBYFLOAT inf and nan', ['SET k 1', 'INCRBYFLOAT k inf', 'INCRBYFLOAT k -inf', 'INCRBYFLOAT k nan', 'INCRBYFLOAT k +inf', 'SET i inf', 'INCRBYFLOAT i 1', 'GET k']),
  s('INCRBYFLOAT overflow to infinity', ['SET k 1.7e308', 'INCRBYFLOAT k 1.7e308', 'GET k', 'SET l 1e4932', 'INCRBYFLOAT l 1']),
  s('INCRBYFLOAT invalid texts', [
    'INCRBYFLOAT k abc', 'INCRBYFLOAT k ""', 'INCRBYFLOAT k " 1"', 'INCRBYFLOAT k "1 "', 'INCRBYFLOAT k 1.2.3', 'INCRBYFLOAT k 0x10',
    'SET s abc', 'INCRBYFLOAT s 1', 'SET t " 2"', 'INCRBYFLOAT t 1', 'SET u 1,5', 'INCRBYFLOAT u 1', 'EXISTS k',
  ]),
  s('INCRBYFLOAT exact binary fractions', ['SET k 10.5', 'INCRBYFLOAT k 0.25', 'INCRBYFLOAT k -0.75', 'INCRBYFLOAT k 1e2', 'INCRBYFLOAT k -110', 'INCRBYFLOAT k 0.125', 'INCRBYFLOAT k 2.5e-1']),
  s('INCRBYFLOAT keeps TTL', ['SET k 1 EX 100', 'INCRBYFLOAT k 1.5', 'TTL k']),
  s('INCRBYFLOAT negative zero and trailing zeros', ['SET k 0', 'INCRBYFLOAT k -0', 'SET m 1.5', 'INCRBYFLOAT m -1.5', 'SET n 2.50', 'INCRBYFLOAT n 0.50', 'INCRBYFLOAT p -0.0']),
  s('INCRBYFLOAT on integer text and back to INCR', ['SET k 5', 'INCRBYFLOAT k 1', 'INCR k', 'INCRBYFLOAT k 0.5', 'INCR k']),

  // SETRANGE / GETRANGE
  s('SETRANGE basics', ['SET k "Hello World"', 'SETRANGE k 6 Redis', 'GET k', 'SETRANGE k 0 ""', 'SETRANGE k 20 x', 'GET k', 'STRLEN k']),
  s('SETRANGE on missing key pads with zeros', ['SETRANGE k 5 ab', 'GET k', 'SETRANGE m 0 ""', 'EXISTS m', 'SETRANGE n 10 ""', 'EXISTS n']),
  s('SETRANGE offset errors', ['SETRANGE k -1 x', 'SETRANGE k abc x', 'SETRANGE k 1.5 x', 'SETRANGE k 9223372036854775808 x', 'EXISTS k']),
  s('SETRANGE huge offset', ['SETRANGE k 536870912 x', 'SETRANGE k 536870911 ""', 'SETRANGE k 4294967296 x', 'EXISTS k']),
  s('SETRANGE on wrong type and arity', ['RPUSH l a', 'SETRANGE l 0 x', 'SETRANGE k 0', 'SETRANGE k']),
  s('SETRANGE on integer encoded value', ['SET k 12345', 'SETRANGE k 1 x', 'GET k', 'OBJECT ENCODING k']),
  s('GETRANGE edges', [
    'SET k "This is a string"', 'GETRANGE k 0 3', 'GETRANGE k -3 -1', 'GETRANGE k 0 -1', 'GETRANGE k 10 100', 'GETRANGE k 5 3',
    'GETRANGE k -100 2', 'GETRANGE k -1 -5', 'GETRANGE k 100 200', 'GETRANGE k -100 -50', 'GETRANGE k 0 0',
  ]),
  s('GETRANGE huge and invalid offsets', [
    'SET k abc', 'GETRANGE k 0 9223372036854775808', 'GETRANGE k 0 4294967296', 'GETRANGE k -4294967296 -1', 'GETRANGE k a 1', 'GETRANGE k 0 1.0', 'GETRANGE missing 0 -1', 'GETRANGE missing 5 2',
  ]),
  s('GETRANGE with int64 extremes', ['SET k abc', 'GETRANGE k 0 9223372036854775807', 'GETRANGE k -9223372036854775808 -1', 'GETRANGE k -9223372036854775808 9223372036854775807']),
  s('GETRANGE on empty string and integers', ['SET e ""', 'GETRANGE e 0 -1', 'GETRANGE e -1 0', 'SET n 1234', 'GETRANGE n 1 2', 'GETRANGE n -2 -1']),
  s('GETRANGE on wrong type and arity', ['SADD s a', 'GETRANGE s 0 1', 'GETRANGE k 0', 'GETRANGE k']),

  // APPEND / STRLEN
  s('APPEND', ['APPEND k Hello', 'APPEND k " World"', 'GET k', 'APPEND k ""', 'SET n 10', 'APPEND n 5', 'GET n', 'OBJECT ENCODING n']),
  s('APPEND keeps TTL and wrong type', ['SET k a EX 100', 'APPEND k b', 'TTL k', 'RPUSH l a', 'APPEND l x', 'APPEND x', 'APPEND x a b']),
  s('APPEND empty to missing key', ['APPEND k ""', 'EXISTS k', 'GET k', 'TYPE k']),
  s('STRLEN', ['STRLEN missing', 'SET k abc', 'STRLEN k', 'SET n -123', 'STRLEN n', 'RPUSH l a', 'STRLEN l', 'STRLEN', 'STRLEN a b']),

  // LCS
  s('LCS basics', ['MSET key1 ohmytext key2 mynewtext', 'LCS key1 key2', 'LCS key1 key2 LEN', 'LCS key1 missing', 'LCS missing1 missing2 LEN']),
  s('LCS IDX', ['MSET key1 ohmytext key2 mynewtext', 'LCS key1 key2 IDX', 'LCS key1 key2 IDX MINMATCHLEN 4', 'LCS key1 key2 IDX MINMATCHLEN 4 WITHMATCHLEN', 'LCS key1 key2 IDX WITHMATCHLEN']),
  s('LCS IDX RESP3 map and empty', ['MSET a abc b xyz', 'LCS a b IDX', 'LCS a b', 'LCS a b LEN', 'LCS a missing IDX WITHMATCHLEN']),
  s('LCS LEN and IDX conflict', ['MSET a abc b abd', 'LCS a b LEN IDX', 'LCS a b IDX LEN', 'LCS a b FOO', 'LCS a b MINMATCHLEN x']),
  s('LCS MINMATCHLEN without a value', ['MSET a abc b abd', 'LCS a b MINMATCHLEN', 'LCS a b IDX MINMATCHLEN']),
  s('LCS negative MINMATCHLEN', ['MSET a abcdef b abcxyzdef', 'LCS a b IDX MINMATCHLEN -1', 'LCS a b IDX MINMATCHLEN 0 WITHMATCHLEN', 'LCS a b MINMATCHLEN 2']),
  s('LCS wrong type and arity', ['RPUSH l a', 'SET s abc', 'LCS l s', 'LCS s l', 'LCS s', 'LCS']),
  s('LCS same key and repeated', ['SET a abcabc', 'LCS a a', 'LCS a a IDX WITHMATCHLEN', 'MSET x aaaa y aa', 'LCS x y IDX']),
  s('LCS options repeated', ['MSET a ohmytext b mynewtext', 'LCS a b IDX IDX', 'LCS a b LEN LEN', 'LCS a b WITHMATCHLEN', 'LCS a b IDX MINMATCHLEN 2 MINMATCHLEN 3']),
  s('LCS integer encoded values', ['MSET a 12345 b 2345', 'LCS a b', 'LCS a b IDX WITHMATCHLEN']),
]);
