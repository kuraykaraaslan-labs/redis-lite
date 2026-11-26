import { differential, s, v } from './differential.harness';

differential('bitmaps', [
  // SETBIT / GETBIT
  s('SETBIT and GETBIT', ['SETBIT k 7 1', 'GETBIT k 7', 'GETBIT k 0', 'GET k', 'SETBIT k 7 0', 'GET k', 'SETBIT k 100 1', 'STRLEN k', 'GETBIT k 1000']),
  s('SETBIT returns the old bit', ['SETBIT k 1 1', 'SETBIT k 1 1', 'SETBIT k 1 0', 'SETBIT k 1 0']),
  s('SETBIT value errors', ['SETBIT k 1 2', 'SETBIT k 1 -1', 'SETBIT k 1 x', 'SETBIT k 1 ""', 'SETBIT k 1 01', 'EXISTS k']),
  s('SETBIT offset errors', ['SETBIT k -1 1', 'SETBIT k x 1', 'SETBIT k 4294967296 1', 'SETBIT k 1.5 1', 'SETBIT k 9223372036854775808 1', 'EXISTS k']),
  s('SETBIT large offset', ['SETBIT k 8388607 1', 'STRLEN k', 'GETBIT k 8388607', 'BITCOUNT k', 'BITPOS k 1', 'DEL k']),
  s('GETBIT errors', ['SET k a', 'GETBIT k -1', 'GETBIT k x', 'GETBIT k 4294967296', 'GETBIT missing 5', 'GETBIT k', 'GETBIT']),
  s('SETBIT GETBIT on wrong type', ['RPUSH l a', 'SETBIT l 0 1', 'GETBIT l 0']),
  s('SETBIT on integer encoded string', ['SET k 1', 'SETBIT k 7 0', 'GET k', 'OBJECT ENCODING k', 'GETBIT k 2']),
  s('SETBIT arity', ['SETBIT k 1', 'SETBIT k', 'SETBIT k 1 1 1']),

  // BITCOUNT
  s('BITCOUNT whole string', ['SET k foobar', 'BITCOUNT k', 'BITCOUNT missing', 'SET e ""', 'BITCOUNT e']),
  s('BITCOUNT byte ranges', ['SET k foobar', 'BITCOUNT k 0 0', 'BITCOUNT k 1 1', 'BITCOUNT k 0 -1', 'BITCOUNT k -2 -1', 'BITCOUNT k 5 1', 'BITCOUNT k -100 100', 'BITCOUNT k 10 20', 'BITCOUNT k 0 0 BYTE']),
  s('BITCOUNT bit ranges', ['SET k foobar', 'BITCOUNT k 5 30 BIT', 'BITCOUNT k 0 -1 BIT', 'BITCOUNT k -9 -1 BIT', 'BITCOUNT k 1 1 bit', 'BITCOUNT k 47 47 BIT', 'BITCOUNT k 48 100 BIT', 'BITCOUNT k 7 2 BIT']),
  s('BITCOUNT range errors', ['SET k foobar', 'BITCOUNT k 0', 'BITCOUNT k 0 1 FOO', 'BITCOUNT k a 1', 'BITCOUNT k 0 b', 'BITCOUNT k 0 9223372036854775808']),
  s('BITCOUNT trailing argument after the unit', ['SET k foobar', 'BITCOUNT k 0 1 BIT extra', 'BITCOUNT k 0 1 BYTE BYTE']),
  s('BITCOUNT huge ranges', ['SET k foobar', 'BITCOUNT k -9223372036854775808 9223372036854775807', 'BITCOUNT k 0 9223372036854775807 BIT', 'BITCOUNT k -9223372036854775808 -1 BIT']),
  s('BITCOUNT on missing key with bad range', ['BITCOUNT missing 0', 'BITCOUNT missing 0 1 FOO', 'BITCOUNT missing a b'], v('BITCOUNT/BITPOS on a missing key validate their arguments since 7.2 (7.0 replies 0)', 'medium')),
  s('BITCOUNT wrong type and arity', ['RPUSH l a', 'BITCOUNT l', 'BITCOUNT']),

  // BITPOS
  s('BITPOS basics', ['SET k "\\xff\\xf0\\x00"', 'BITPOS k 0', 'BITPOS k 1', 'BITPOS k 0 1', 'BITPOS k 1 2', 'BITPOS k 0 2 -1', 'BITPOS k 1 -1']),
  s('BITPOS all ones and all zeros', ['SET o "\\xff\\xff"', 'BITPOS o 0', 'BITPOS o 0 0 -1', 'BITPOS o 0 0', 'BITPOS o 1', 'SET z "\\x00\\x00"', 'BITPOS z 1', 'BITPOS z 0', 'BITPOS z 1 0 -1']),
  s('BITPOS on missing key', ['BITPOS missing 0', 'BITPOS missing 1', 'BITPOS missing 0 5', 'BITPOS missing 1 0 -1 BIT']),
  s('BITPOS BIT ranges', ['SET k "\\x00\\xff\\xf0"', 'BITPOS k 1 7 15 BIT', 'BITPOS k 1 0 7 BIT', 'BITPOS k 0 8 15 BIT', 'BITPOS k 0 9 -1 BIT', 'BITPOS k 1 -5 -1 BIT', 'BITPOS k 0 20 23 BIT']),
  s('BITPOS BYTE ranges', ['SET k "\\x00\\xff\\xf0"', 'BITPOS k 1 0 0 BYTE', 'BITPOS k 1 1 1 BYTE', 'BITPOS k 0 1 1 BYTE', 'BITPOS k 0 1 2 BYTE', 'BITPOS k 1 2 1 BYTE']),
  s('BITPOS errors', ['SET k a', 'BITPOS k 2', 'BITPOS k -1', 'BITPOS k 1 x', 'BITPOS k 1 0 x', 'BITPOS k 1 0 1 FOO', 'BITPOS k', 'BITPOS']),
  s('BITPOS non-integer bit argument', ['SET k a', 'BITPOS k x', 'BITPOS k 1.0']),
  s('BITPOS trailing argument after the unit', ['SET k a', 'BITPOS k 1 0 1 BIT x', 'BITPOS k 1 0 1 BYTE BIT']),
  s('BITPOS on missing key with bad range', ['BITPOS missing 1 x', 'BITPOS missing 1 0 1 FOO', 'BITPOS missing 2']),
  s('BITPOS wrong type', ['RPUSH l a', 'BITPOS l 1']),
  s('BITPOS empty string', ['SET e ""', 'BITPOS e 0', 'BITPOS e 1']),

  // BITOP
  s('BITOP AND OR XOR', ['SET a "\\xff\\x0f"', 'SET b "\\xf0"', 'BITOP AND d a b', 'GET d', 'BITOP OR d a b', 'GET d', 'BITOP XOR d a b', 'GET d', 'BITOP and d a', 'GET d']),
  s('BITOP NOT', ['SET a "\\x0f\\xff"', 'BITOP NOT d a', 'GET d', 'BITOP NOT d a b', 'BITOP NOT d missing', 'EXISTS d']),
  s('BITOP with missing sources', ['SET a "\\xff"', 'BITOP AND d a missing', 'GET d', 'BITOP OR d missing a', 'GET d', 'BITOP XOR d missing missing2', 'EXISTS d']),
  s('BITOP empty result deletes destination', ['SET d v', 'BITOP OR d missing', 'EXISTS d', 'SET e ""', 'SET d v', 'BITOP AND d e', 'EXISTS d']),
  s('BITOP different lengths', ['SET a "\\xff\\xff\\xff"', 'SET b "\\x01"', 'SET c ""', 'BITOP AND d a b c', 'GET d', 'BITOP OR d c b a', 'GET d', 'BITOP XOR d a a b', 'GET d']),
  s('BITOP long strings', ['SET a ' + 'ab'.repeat(40), 'SET b ' + 'cd'.repeat(20), 'BITOP AND d a b', 'GET d', 'BITOP XOR d a b', 'GET d', 'BITOP NOT d a', 'STRLEN d']),
  s('BITOP errors', ['SET a x', 'BITOP FOO d a', 'BITOP AND d', 'BITOP AND', 'RPUSH l x', 'BITOP AND d a l', 'BITOP NOT d l', 'EXISTS d']),
  s('BITOP onto wrong-type destination', ['SET a x', 'RPUSH d y', 'BITOP OR d a', 'TYPE d', 'GET d']),
  s('BITOP with integer encoded source', ['SET a 12', 'SET b 3', 'BITOP OR d a b', 'GET d']),
  s('BITOP DIFF', ['SET a "\\xff"', 'SET b "\\x0f"', 'BITOP DIFF d a b', 'GET d'], v('BITOP DIFF added in 8.2')),
  s('BITOP DIFF1', ['SET a "\\xff"', 'SET b "\\x0f"', 'BITOP DIFF1 d a b', 'GET d'], v('BITOP DIFF1 added in 8.2')),
  s('BITOP ANDOR', ['SET a "\\xff"', 'SET b "\\x0f"', 'BITOP ANDOR d a b', 'GET d'], v('BITOP ANDOR added in 8.2')),
  s('BITOP ONE', ['SET a "\\xff"', 'SET b "\\x0f"', 'BITOP ONE d a b', 'GET d'], v('BITOP ONE added in 8.2')),
  s('BITOP DIFF needs two keys', ['SET a "\\xff"', 'BITOP DIFF d a'], v('BITOP DIFF added in 8.2 (7.0: unknown op syntax error)', 'medium')),
]);
