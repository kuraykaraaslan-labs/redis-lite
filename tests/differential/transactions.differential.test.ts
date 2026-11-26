import { differential, s } from './differential.harness';
import { all, anyNumber, text } from './differential.normalizers';

/** HELLO's reply carries the server version and the client id: both differ by construction. */
const hello = all(anyNumber, text((t) => (/^\d+\.\d+\.\d+$/.test(t) ? 'VERSION' : t)));

differential('transactions', [
  // MULTI / EXEC / DISCARD
  s('MULTI EXEC basic', ['MULTI', 'SET k v', 'INCR n', 'GET k', 'EXEC', 'GET k']),
  s('MULTI EXEC empty', ['MULTI', 'EXEC']),
  s('MULTI EXEC mixed reply types', ['MULTI', 'SET k 1', 'GET missing', 'RPUSH l a b', 'LRANGE l 0 -1', 'HSET h f v', 'HGETALL h', 'INCRBYFLOAT f 1.5', 'SADD st x', 'SMEMBERS st', 'ZADD z 1 m', 'ZSCORE z m', 'PING', 'ECHO hi', 'EXEC']),
  s('DISCARD', ['MULTI', 'SET k v', 'DISCARD', 'GET k', 'DISCARD', 'EXEC']),
  s('nested MULTI', ['MULTI', 'SET k v', 'MULTI', 'EXEC', 'GET k']),
  s('EXEC without MULTI', ['EXEC']),
  s('DISCARD without MULTI', ['DISCARD']),
  s('MULTI arity', ['MULTI x', 'EXEC x', 'DISCARD x']),
  s('EXEC with arguments inside MULTI', ['MULTI', 'EXEC x', 'EXEC', 'DISCARD x', 'DISCARD']),
  s('queued replies are QUEUED', ['MULTI', 'SET a 1', 'GET a', 'DEL a', 'EXEC']),

  // queued errors and runtime errors
  s('unknown command aborts EXEC', ['MULTI', 'SET k v', 'NOSUCH a', 'SET k2 v', 'EXEC', 'GET k']),
  s('wrong arity aborts EXEC', ['MULTI', 'SET k', 'EXEC', 'EXISTS k']),
  s('EXECABORT then new MULTI works', ['MULTI', 'GET', 'EXEC', 'MULTI', 'SET k v', 'EXEC']),
  s('DISCARD after queued error', ['MULTI', 'GET', 'DISCARD', 'SET k v']),
  s('runtime error inside EXEC', ['SET s str', 'MULTI', 'INCR s', 'SET k v', 'LPUSH s x', 'GET k', 'EXEC']),
  s('syntax error detected at EXEC time', ['MULTI', 'SET k v EX notanumber', 'SET k2 v NX XX', 'ZADD z NX XX 1 m', 'EXEC']),
  s('WRONGTYPE inside EXEC', ['RPUSH l a', 'MULTI', 'GET l', 'LLEN l', 'EXEC']),
  s('commands not allowed in MULTI', ['MULTI', 'WATCH k', 'EXEC']),
  s('WATCH inside MULTI does not abort', ['MULTI', 'WATCH k', 'SET k v', 'EXEC']),
  s('UNWATCH inside MULTI', ['MULTI', 'UNWATCH', 'EXEC']),
  s('SELECT inside MULTI', ['MULTI', 'SELECT 1', 'SET k v', 'SELECT 0', 'EXISTS k', 'EXEC', 'EXISTS k']),
  s('MULTI with PING and ECHO', ['MULTI', 'PING', 'ECHO x', 'EXEC']),
  s('RESET inside MULTI', ['MULTI', 'SET k v', 'RESET', 'EXEC', 'GET k']),
  s('HELLO inside MULTI', ['MULTI', 'HELLO 3', { cmd: 'EXEC', norm: hello }]),
  s('EVAL inside MULTI', ['MULTI', { cmd: ['EVAL', "return redis.call('SET', KEYS[1], 'x')", '1', 'k'] }, 'GET k', 'EXEC']),
  s('script error inside EXEC', ['SET s str', 'MULTI', { cmd: ['EVAL', "return redis.call('INCR', 's')", '0'] }, 'SET k v', 'EXEC']),

  // WATCH
  s('WATCH then modification from another connection', ['SET k 1', 'WATCH k', { c: 1, cmd: 'SET k 2' }, 'MULTI', 'SET k 3', 'EXEC', 'GET k']),
  s('WATCH without modification', ['SET k 1', 'WATCH k', 'MULTI', 'SET k 3', 'EXEC', 'GET k']),
  s('WATCH own modification before MULTI', ['SET k 1', 'WATCH k', 'SET k 2', 'MULTI', 'SET k 3', 'EXEC', 'GET k']),
  s('WATCH missing key then created', ['WATCH k', { c: 1, cmd: 'SET k v' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH missing key stays missing', ['WATCH k', { c: 1, cmd: 'DEL k' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH key deleted by other', ['SET k v', 'WATCH k', { c: 1, cmd: 'DEL k' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH key touched with same value', ['SET k v', 'WATCH k', { c: 1, cmd: 'SET k v' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH failed command does not invalidate', ['SET k v', 'WATCH k', { c: 1, cmd: 'INCR k' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH no-op write does not invalidate', ['SADD s a', 'WATCH s', { c: 1, cmd: 'SADD s a' }, { c: 1, cmd: 'SREM s zz' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH multiple keys', ['WATCH a b c', { c: 1, cmd: 'SET c 1' }, 'MULTI', 'PING', 'EXEC']),
  s('UNWATCH clears watches', ['SET k 1', 'WATCH k', { c: 1, cmd: 'SET k 2' }, 'UNWATCH', 'MULTI', 'SET k 3', 'EXEC', 'GET k']),
  s('EXEC clears watches', ['WATCH k', 'MULTI', 'EXEC', { c: 1, cmd: 'SET k 2' }, 'MULTI', 'PING', 'EXEC']),
  s('DISCARD clears watches', ['WATCH k', { c: 1, cmd: 'SET k 2' }, 'MULTI', 'DISCARD', 'MULTI', 'PING', 'EXEC']),
  s('WATCH arity', ['WATCH', 'UNWATCH x', 'UNWATCH']),
  // active expiry off: only EXEC's own check may notice the expired key (deterministic on both servers)
  s('WATCH on expired key', ['DEBUG SET-ACTIVE-EXPIRE 0', 'SET k v PX 30', 'WATCH k', { sleep: 80 }, 'MULTI', 'PING', 'EXEC'], { fresh: true }),
  s('WATCH key that expires before access', ['SET k v PX 30', { sleep: 80 }, 'WATCH k', 'MULTI', 'PING', 'EXEC']),
  s('WATCH then FLUSHALL by other', ['SET k v', 'WATCH k', { c: 1, cmd: 'FLUSHALL' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH then FLUSHALL on missing key', ['WATCH k', { c: 1, cmd: 'FLUSHALL' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH then FLUSHDB other db', ['SET k v', 'WATCH k', { c: 1, cmd: 'SELECT 1' }, { c: 1, cmd: 'FLUSHDB' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH then SWAPDB', ['SET k v', 'WATCH k', { c: 1, cmd: 'SWAPDB 0 1' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH then EXPIRE by other', ['SET k v', 'WATCH k', { c: 1, cmd: 'EXPIRE k 100' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH then RENAME onto key', ['SET a 1', 'WATCH b', { c: 1, cmd: 'RENAME a b' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH in other db not affected', ['SET k v', 'WATCH k', { c: 1, cmd: 'SELECT 2' }, { c: 1, cmd: 'SET k x' }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH then modification inside MULTI queue', ['WATCH k', 'MULTI', 'SET k v', { c: 1, cmd: 'SET k other' }, 'EXEC', 'GET k']),
  s('WATCH with aborted EXEC returns nil after error', ['SET k 1', 'WATCH k', { c: 1, cmd: 'SET k 2' }, 'MULTI', 'NOSUCH', 'EXEC']),
  s('WATCH from Lua modification', ['SET k 1', 'WATCH k', { c: 1, cmd: ['EVAL', "return redis.call('SET', KEYS[1], '9')", '1', 'k'] }, 'MULTI', 'PING', 'EXEC']),
  s('WATCH then expiry via other connection', ['SET k v', 'WATCH k', { c: 1, cmd: 'PEXPIRE k 1' }, { sleep: 30 }, 'MULTI', 'PING', 'EXEC']),

  // blocking commands inside MULTI
  s('BLPOP inside MULTI does not block', ['MULTI', 'BLPOP l 0', 'BRPOP l 1', 'BLMOVE a b LEFT RIGHT 0', 'EXEC']),
  s('BLPOP inside MULTI with data', ['RPUSH l a b', 'MULTI', 'BLPOP l 0', 'EXEC']),
  s('BZPOPMIN inside MULTI', ['MULTI', 'BZPOPMIN z 0', 'BZMPOP 0 1 z MIN', 'BLMPOP 0 1 l LEFT', 'EXEC']),
  s('XREAD BLOCK inside MULTI', ['MULTI', 'XREAD BLOCK 0 STREAMS s $', 'XADD s 1-0 f v', 'XREAD BLOCK 0 STREAMS s 0', 'EXEC']),
  s('XREADGROUP BLOCK inside MULTI', ['XGROUP CREATE s g $ MKSTREAM', 'MULTI', 'XREADGROUP GROUP g c BLOCK 0 STREAMS s >', 'EXEC']),
  s('WAIT inside MULTI', ['MULTI', 'WAIT 0 0', 'EXEC']),
  s('BRPOPLPUSH inside MULTI', ['MULTI', 'BRPOPLPUSH a b 0', 'EXEC']),

  // misc
  s('MULTI with INFO-like commands', ['MULTI', 'DBSIZE', 'EXISTS a', 'TYPE a', 'EXEC']),
  s('TTL and PERSIST inside MULTI', ['MULTI', 'SET k v PX 10000', 'TTL k', 'PERSIST k', 'TTL k', 'EXEC']),
  s('MULTI inside subscribed RESP3', ['SUBSCRIBE ch', 'MULTI', 'SET k v', 'EXEC'], { proto: 3 }),
  s('long transaction', ['MULTI', ...Array.from({ length: 50 }, (_, i) => `RPUSH l ${i}`), 'LLEN l', 'EXEC']),
  s('CLIENT commands inside MULTI', ['MULTI', 'CLIENT SETNAME x', 'CLIENT GETNAME', 'EXEC']),
  s('MULTI with FLUSHALL', ['SET a 1', 'MULTI', 'FLUSHALL', 'DBSIZE', 'EXEC']),
]);
