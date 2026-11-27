import { differential, s } from './differential.harness';
import { pttlSeconds } from './differential.normalizers';
import { intProbes } from './differential.probes';

const FAR = '4102444800'; // 2100-01-01, seconds
const FAR_MS = '4102444800000';

differential('keys expire', [
  // EXPIRE family basics
  s('EXPIRE then TTL and PTTL', ['SET k v', 'EXPIRE k 100', 'TTL k', 'EXPIRE missing 100', 'TTL missing', 'PTTL missing', 'SET p v', 'TTL p', 'PTTL p']),
  s('EXPIREAT and PEXPIREAT', ['SET k v', `EXPIREAT k ${FAR}`, 'EXPIRETIME k', 'PEXPIRETIME k', `PEXPIREAT k ${FAR_MS}7`, 'PEXPIRETIME k', 'EXPIRETIME k']),
  s('PEXPIRE rounds EXPIRETIME', ['SET k v', `PEXPIREAT k ${FAR}999`, 'EXPIRETIME k', `PEXPIREAT k ${FAR}500`, 'EXPIRETIME k', `PEXPIREAT k ${FAR}499`, 'EXPIRETIME k']),
  s('EXPIRETIME on missing and persistent', ['EXPIRETIME missing', 'PEXPIRETIME missing', 'SET k v', 'EXPIRETIME k', 'PEXPIRETIME k', 'EXPIRETIME', 'PEXPIRETIME a b']),
  s('EXPIRE with zero or negative deletes', ['SET a v', 'EXPIRE a 0', 'EXISTS a', 'SET b v', 'EXPIRE b -10', 'EXISTS b', 'SET c v', 'PEXPIRE c -1', 'EXISTS c', 'SET d v', 'EXPIREAT d 1', 'EXISTS d']),
  s('EXPIRE argument not an integer', ['SET k v', 'EXPIRE k abc', 'EXPIRE k 1.5', 'PEXPIRE k ""', 'EXPIREAT k 1e10', 'PEXPIREAT k " 1"', 'TTL k']),
  s('EXPIRE overflow', [
    'SET k v', 'EXPIRE k 9223372036854775807', 'EXPIRE k 9223372036854775', 'PEXPIRE k 9223372036854775807', 'EXPIREAT k 9223372036854775807',
    'EXPIRE k 9223372036854775808', 'PEXPIREAT k 9223372036854775808', 'TTL k', 'EXPIRE k -9223372036854775808', 'EXISTS k', 'SET m v',
    'PEXPIRE m -9223372036854775808', 'EXISTS m', 'SET n v', 'EXPIREAT n -9223372036854775808', 'EXISTS n',
  ]),
  s('EXPIRE big but valid', ['SET k v', 'EXPIRE k 922337203685477', 'TTL k', 'EXPIREAT k 922337203685477', 'EXPIRETIME k']),
  s('PEXPIREAT near the int64 limit keeps precision', ['SET k v', 'PEXPIREAT k 9223372036854775806', 'PEXPIRETIME k', 'PEXPIREAT k 9223372036854775807', 'PEXPIRETIME k', 'EXPIREAT k 9223372036854775', 'PEXPIRETIME k']),
  s('EXPIRE arity', ['EXPIRE k', 'EXPIRE', 'PEXPIRE k', 'EXPIREAT k', 'PEXPIREAT k', 'TTL', 'PTTL a b']),

  // NX / XX / GT / LT
  s('EXPIRE NX', ['SET k v', `EXPIREAT k ${FAR} NX`, `EXPIREAT k 4102444900 NX`, 'EXPIRETIME k', 'EXPIRE missing 10 NX']),
  s('EXPIRE XX', ['SET k v', `EXPIREAT k ${FAR} XX`, 'EXPIRETIME k', `EXPIREAT k ${FAR}`, `EXPIREAT k 4102444900 XX`, 'EXPIRETIME k']),
  s('EXPIRE GT', ['SET k v', `EXPIREAT k ${FAR} GT`, 'EXPIRETIME k', `EXPIREAT k ${FAR}`, 'EXPIREAT k 4102444700 GT', 'EXPIREAT k 4102444900 GT', 'EXPIRETIME k', 'EXPIREAT k 4102444900 GT']),
  s('EXPIRE LT', ['SET k v', `EXPIREAT k ${FAR} LT`, 'EXPIRETIME k', 'EXPIREAT k 4102444900 LT', 'EXPIREAT k 4102444700 LT', 'EXPIRETIME k']),
  s('EXPIRE LT on persistent key and past time', ['SET k v', 'EXPIRE k 0 LT', 'EXISTS k', 'SET m v', 'EXPIRE m 0 GT', 'EXISTS m', 'SET n v', 'EXPIRE n -1 NX', 'EXISTS n']),
  s('EXPIRE option conflicts', [
    'SET k v', 'EXPIRE k 10 NX XX', 'EXPIRE k 10 GT LT', 'EXPIRE k 10 NX GT', 'EXPIRE k 10 NX LT', 'EXPIRE k 10 XX GT', 'EXPIRE k 10 FOO',
    `EXPIREAT k ${FAR} NX NX`, `EXPIREAT k ${FAR} GT GT`, 'EXPIREAT k 4102444900 GT GT XX', 'EXPIRETIME k', 'EXPIREAT k 4102444700 LT LT', 'EXPIRETIME k',
  ]),
  s('EXPIRE option conflicts on other commands', ['SET k v', 'PEXPIRE k 10 NX GT', 'EXPIREAT k 10 GT LT', 'PEXPIREAT k 10 XX NX', 'PEXPIRE k 10 BAR', 'TTL k']),
  s('EXPIRE options lowercase', ['SET k v', `expireat k ${FAR} nx`, `expireat k 4102444900 gt`, 'EXPIRETIME k', `pexpireat k ${FAR_MS} lt`, 'PEXPIRETIME k']),
  s('EXPIRE options on missing key', ['EXPIRE missing 10 XX', 'EXPIRE missing 10 GT', 'EXPIRE missing 10 LT', 'EXPIRE missing 10 NX GT']),
  s('EXPIRE options checked before integer', ['SET k v', 'EXPIRE k abc NX XX', 'EXPIRE k abc FOO', 'EXPIRE k 10 XX FOO']),

  // PERSIST / TTL
  s('PERSIST', ['SET k v EX 100', 'PERSIST k', 'TTL k', 'PERSIST k', 'PERSIST missing', 'PERSIST', 'PERSIST a b']),
  s('TTL on every type with expiry', ['RPUSH l a', `EXPIREAT l ${FAR}`, 'SADD s a', `PEXPIREAT s ${FAR_MS}`, 'HSET h f v', 'EXPIRE h 100', 'EXPIRETIME l', 'PEXPIRETIME s', 'TTL h']),
  s('SET removes TTL and other writes keep it', ['SET k v EX 100', 'APPEND k x', 'TTL k', 'SETRANGE k 0 y', 'TTL k', 'SET k z', 'TTL k', 'RPUSH l a', 'EXPIRE l 100', 'RPUSH l b', 'TTL l']),

  // actual expiry
  s('key expires after PX', ['SET k v PX 50', 'EXISTS k', { sleep: 200 }, 'EXISTS k', 'GET k', 'TTL k', 'PTTL k', 'EXPIRETIME k']),
  s('PEXPIRE then expiry of a list', ['RPUSH l a b', 'PEXPIRE l 50', { sleep: 200 }, 'LLEN l', 'TYPE l', 'DBSIZE']),
  s('expired key behaves as missing for writes', ['SET k 5 PX 50', { sleep: 200 }, 'INCR k', 'TTL k', 'SET n v PX 50', { sleep: 200 }, 'SET n w NX', 'GET n']),
  s('GETEX and expiry in the same flow', ['SET k v', 'GETEX k PX 50', { sleep: 200 }, 'GETEX k', 'EXISTS k']),

  // integer arguments at the int64 and int32 edges (see differential.probes)
  ...intProbes('EXPIRE family', ['SET k v', 'EXPIRE k $N', 'TTL k', 'PEXPIRE k $N', 'TTL k', 'EXPIREAT k $N', 'TTL k', 'SET k v', 'PEXPIREAT k $N', 'EXISTS k']),
  ...intProbes('EXPIRE on a missing key', ['EXPIRE nokey $N', 'PEXPIRE nokey $N', 'EXPIREAT nokey $N', 'PEXPIREAT nokey $N']),
  ...intProbes('EXPIRE then TTL', ['SET k v', 'EXPIRE k $N', 'TTL k', { cmd: 'PTTL k', norm: pttlSeconds }, 'PEXPIRE k $N', 'TTL k', { cmd: 'PTTL k', norm: pttlSeconds }]),
]);
