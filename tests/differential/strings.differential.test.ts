import { differential, s } from './differential.harness';

const FAR = '4102444800'; // 2100-01-01, seconds
const FAR_MS = '4102444800000';

differential('strings', [
  // GET / SET basics
  s('SET then GET', ['SET k v', 'GET k', 'GET missing']),
  s('SET empty value and binary value', ['SET k ""', 'GET k', 'STRLEN k', 'SET b "\\x00\\xff\\r\\n"', 'GET b', 'STRLEN b']),
  s('SET overwrites any type', ['RPUSH l a', 'SET l v', 'TYPE l', 'GET l']),
  s('GET on wrong type', ['RPUSH l a', 'GET l', 'HSET h f v', 'GET h']),
  s('GET and SET arity', ['GET', 'GET a b', 'SET', 'SET k', 'SET k v extra']),
  s('SET unknown option is a syntax error', ['SET k v FOO', 'SET k v EX', 'SET k v PX', 'GET k']),

  // SET expiry options
  s('SET EX PX EXAT PXAT set absolute expiry', [
    `SET a v EXAT ${FAR}`, 'EXPIRETIME a', `SET b v PXAT ${FAR_MS}`, 'PEXPIRETIME b', 'SET c v EX 100', 'TTL c',
    'SET d v PX 100000', 'PERSIST d', 'TTL d',
  ]),
  s('SET expiry values must be positive', ['SET k v EX 0', 'SET k v EX -1', 'SET k v PX 0', 'SET k v PX -5', 'SET k v EXAT 0', 'SET k v PXAT -1', 'GET k']),
  s('SET expiry value not an integer', ['SET k v EX abc', 'SET k v PX 1.5', 'SET k v EXAT 1e3', 'SET k v PXAT ""', 'GET k']),
  s('SET expiry value overflow', ['SET k v EX 9223372036854775807', 'SET k v PX 9223372036854775807', 'SET k v EX 9223372036854775808', 'SET k v EXAT 9223372036854775807', 'GET k']),
  s('SET with an expiry in the past deletes', ['SET k v', 'SET k v2 EXAT 1', 'EXISTS k', 'SET k v3 PXAT 1', 'GET k']),
  s('SET conflicting expiry options', [
    'SET k v EX 10 PX 100', 'SET k v EXAT 10 PXAT 20', 'SET k v KEEPTTL EX 10', 'SET k v PX 10 KEEPTTL',
    'SET k v EXAT 4102444800 EX 5', 'GET k',
  ]),
  s('SET repeated EX is accepted', ['SET k v EX 10 EX 20', 'TTL k', 'SET k v PX 10 PX 100000', 'TTL k']),
  s('SET KEEPTTL keeps an existing TTL', [`SET k v EXAT ${FAR}`, 'SET k v2 KEEPTTL', 'EXPIRETIME k', 'GET k', 'SET k v3', 'EXPIRETIME k']),
  s('SET KEEPTTL on a missing key', ['SET k v KEEPTTL', 'TTL k', 'GET k']),
  s('SET options are case-insensitive', [`SET k v ex 100 nx`, 'TTL k', `set k v2 xx keepttl get`, 'TTL k', `SeT k v3 PxAt ${FAR_MS}`, 'PEXPIRETIME k']),

  // NX / XX
  s('SET NX and XX', ['SET k v XX', 'GET k', 'SET k v NX', 'SET k v2 NX', 'GET k', 'SET k v3 XX', 'GET k']),
  s('SET NX XX conflict', ['SET k v NX XX', 'SET k v XX NX', 'SET k v NX NX', 'GET k']),
  s('SET NX with expiry', [`SET k v NX EXAT ${FAR}`, 'EXPIRETIME k', `SET k v2 NX EX 5`, 'EXPIRETIME k']),
  s('SET XX resets TTL without KEEPTTL', [`SET k v EXAT ${FAR}`, 'SET k v2 XX', 'TTL k', `SET k v3 XX KEEPTTL`, 'TTL k']),

  // SET GET
  s('SET GET returns the old value', ['SET k v GET', 'SET k v2 GET', 'GET k', 'SET k "" GET', 'SET k v4 GET']),
  s('SET GET on wrong type is an error and leaves the key', ['RPUSH l a', 'SET l v GET', 'TYPE l', 'LRANGE l 0 -1']),
  s('SET GET with NX', ['SET k v NX GET', 'SET k v2 NX GET', 'GET k']),
  s('SET GET with XX', ['SET k v XX GET', 'EXISTS k', 'SET k v', 'SET k v2 XX GET', 'GET k']),
  s('SET GET with KEEPTTL and EXAT', [`SET k v EXAT ${FAR}`, 'SET k v2 GET KEEPTTL', 'EXPIRETIME k', `SET k v3 GET PXAT ${FAR_MS}1`, 'PEXPIRETIME k']),
  s('SET GET twice', ['SET k v GET GET', 'SET k v', 'SET k v2 GET GET']),
  s('SET GET NX on wrong type', ['SADD s a', 'SET s v NX GET', 'SET s v XX GET', 'TYPE s']),

  // SETNX / SETEX / PSETEX
  s('SETNX', ['SETNX k v', 'SETNX k v2', 'GET k', 'SETNX k', 'SETNX k v x']),
  s('SETEX and PSETEX', ['SETEX k 100 v', 'TTL k', 'GET k', 'PSETEX p 100000 v', 'TTL p', 'GET p']),
  s('SETEX invalid expire', ['SETEX k 0 v', 'SETEX k -1 v', 'SETEX k abc v', 'SETEX k 1.5 v', 'EXISTS k']),
  s('PSETEX invalid expire', ['PSETEX k 0 v', 'PSETEX k -10 v', 'PSETEX k x v', 'EXISTS k']),
  s('SETEX overflow', ['SETEX k 9223372036854775807 v', 'SETEX k 9223372036854775 v', 'PSETEX k 9223372036854775807 v', 'EXISTS k']),
  s('SETEX PSETEX arity', ['SETEX k 10', 'SETEX k', 'PSETEX k 10', 'SETEX k 10 v x']),
  s('SETEX overwrites wrong type', ['RPUSH k a', 'SETEX k 100 v', 'TYPE k']),

  // GETEX
  s('GETEX without options', ['SET k v', 'GETEX k', 'GETEX missing', 'TTL k']),
  s('GETEX sets expiry', [
    'SET k v', `GETEX k EXAT ${FAR}`, 'EXPIRETIME k', `GETEX k PXAT ${FAR_MS}5`, 'PEXPIRETIME k', 'GETEX k EX 100', 'TTL k',
    'GETEX k PX 100000', 'TTL k',
  ]),
  s('GETEX PERSIST', ['SET k v EX 100', 'GETEX k PERSIST', 'TTL k', 'GETEX k PERSIST', 'GETEX missing PERSIST']),
  s('GETEX invalid expire', ['SET k v', 'GETEX k EX 0', 'GETEX k EX -1', 'GETEX k PX 0', 'GETEX k EXAT 0', 'GETEX k PXAT -1', 'GETEX k EX x', 'TTL k']),
  s('GETEX overflow', ['SET k v', 'GETEX k EX 9223372036854775807', 'GETEX k PX 9223372036854775807', 'GETEX k EXAT 9223372036854775807', 'TTL k']),
  s('GETEX syntax errors', ['SET k v', 'GETEX k EX', 'GETEX k EX 10 PX 10', 'GETEX k PERSIST EX 10', 'GETEX k EX 10 PERSIST', 'GETEX k FOO', 'GETEX k KEEPTTL', 'GETEX']),
  s('GETEX on wrong type', ['RPUSH l a', 'GETEX l', 'GETEX l PERSIST', 'GETEX l EX 10']),
  s('GETEX with past absolute time deletes', ['SET k v', 'GETEX k EXAT 1', 'EXISTS k', 'SET k v', 'GETEX k PXAT 1', 'GET k']),
  s('GETEX syntax errors on missing key', ['GETEX missing EX', 'GETEX missing FOO', 'GETEX missing EX 0']),

  // GETDEL / GETSET
  s('GETDEL', ['SET k v', 'GETDEL k', 'EXISTS k', 'GETDEL k', 'GETDEL', 'GETDEL a b']),
  s('GETDEL on wrong type', ['SADD s a', 'GETDEL s', 'EXISTS s']),
  s('GETSET', ['GETSET k v', 'GETSET k v2', 'GET k', 'SET t v EX 100', 'GETSET t x', 'TTL t']),
  s('GETSET on wrong type and arity', ['LPUSH l a', 'GETSET l v', 'GETSET k', 'GETSET k v x']),

  // MSET / MSETNX / MGET
  s('MSET and MGET', ['MSET a 1 b 2 c 3', 'MGET a b c d', 'MSET a x a y', 'GET a']),
  s('MSET odd arguments', ['MSET a', 'MSET a 1 b', 'MSET', 'EXISTS a b']),
  s('MSET clears TTL', ['SET a v EX 100', 'MSET a 1', 'TTL a']),
  s('MSETNX all or nothing', ['MSETNX a 1 b 2', 'MSETNX b 3 c 4', 'MGET a b c', 'MSETNX', 'MSETNX a', 'MSETNX x 1 y']),
  s('MSETNX same key twice', ['MSETNX a 1 a 2', 'GET a']),
  s('MGET with wrong type returns nil', ['RPUSH l x', 'SET s v', 'MGET l s nope']),
  s('MGET arity', ['MGET']),

  // SUBSTR (alias of GETRANGE)
  s('SUBSTR', ['SET k "Hello World"', 'SUBSTR k 0 4', 'SUBSTR k -5 -1', 'SUBSTR k 5 1', 'SUBSTR missing 0 1', 'SUBSTR k a 1', 'SUBSTR k 0']),
]);
