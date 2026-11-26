import { differential, s, v } from './differential.harness';
import { anyNumber } from './differential.normalizers';

/**
 * Hash field expiration. The oracle is 7.0: HEXPIRE & co. arrived in 7.4 and HGETDEL / HGETEX / HSETEX in 8.0, so on
 * 7.0 every one of these is an unknown command. The scenarios are kept as a corpus for a newer oracle.
 */
const V74 = v('hash field expiration commands (HEXPIRE, HTTL, HPERSIST…) were added in 7.4');
const V80 = v('HGETDEL / HGETEX / HSETEX were added in 8.0');

differential('hashes-ttl', [
  // HEXPIRE family
  s('HEXPIRE on present and missing fields', ['HSET h a 1 b 2', 'HEXPIRE h 100 FIELDS 2 a x', 'HTTL h FIELDS 2 a b'], V74),
  s('HEXPIRE on a missing key', ['HEXPIRE nokey 100 FIELDS 1 a', 'HTTL nokey FIELDS 1 a'], V74),
  s('HEXPIRE NX XX GT LT conditions', [
    'HSET h a 1 b 2', 'HEXPIRE h 100 NX FIELDS 1 a', 'HEXPIRE h 200 NX FIELDS 1 a', 'HEXPIRE h 50 XX FIELDS 2 a b',
    'HEXPIRE h 500 GT FIELDS 1 a', 'HEXPIRE h 10 LT FIELDS 1 a', 'HEXPIRE h 10 GT FIELDS 1 b',
  ], V74),
  s('HEXPIRE zero deletes the field', ['HSET h a 1 b 2', 'HEXPIRE h 0 FIELDS 1 a', 'HEXISTS h a', 'HLEN h'], V74),
  s('HEXPIRE numfields mismatch and errors', [
    'HSET h a 1', 'HEXPIRE h 100 FIELDS 2 a', 'HEXPIRE h 100 FIELDS 0', 'HEXPIRE h 100 FIELDS -1 a', 'HEXPIRE h abc FIELDS 1 a',
    'HEXPIRE h -1 FIELDS 1 a', 'HEXPIRE h 100 a', 'HEXPIRE h 100 NX XX FIELDS 1 a',
  ], V74),
  s('HPEXPIRE and HPTTL', ['HSET h a 1', 'HPEXPIRE h 100000 FIELDS 1 a', { cmd: 'HPTTL h FIELDS 1 a', norm: anyNumber }], V74),
  s('HEXPIREAT and HEXPIRETIME', ['HSET h a 1', 'HEXPIREAT h 4102444800 FIELDS 1 a', 'HEXPIRETIME h FIELDS 1 a', 'HPEXPIRETIME h FIELDS 1 a'], V74),
  s('HPEXPIREAT in the past deletes', ['HSET h a 1 b 2', 'HPEXPIREAT h 1000 FIELDS 1 a', 'HGETALL h'], V74),
  s('HPERSIST removes a field TTL', ['HSET h a 1 b 2', 'HEXPIRE h 100 FIELDS 1 a', 'HPERSIST h FIELDS 3 a b x', 'HTTL h FIELDS 1 a'], V74),
  s('field expires after its TTL', ['HSET h a 1 b 2', 'HPEXPIRE h 50 FIELDS 1 a', { sleep: 300 }, 'HGETALL h', 'HLEN h'], V74),
  s('HTTL on a field without TTL and WRONGTYPE', ['HSET h a 1', 'HTTL h FIELDS 1 a', 'SET k v', 'HTTL k FIELDS 1 a', 'HEXPIRE k 10 FIELDS 1 a'], V74),

  // 8.0 commands
  s('HGETDEL removes the returned fields', ['HSET h a 1 b 2 c 3', 'HGETDEL h FIELDS 2 a x', 'HGETALL h', 'HGETDEL h FIELDS 2 b c', 'EXISTS h'], V80),
  s('HGETDEL errors', ['HSET h a 1', 'HGETDEL h FIELDS 2 a', 'HGETDEL h FIELDS 0', 'HGETDEL h a', 'HGETDEL nokey FIELDS 1 a'], V80),
  s('HGETEX sets and clears field TTL', [
    'HSET h a 1 b 2', 'HGETEX h EX 100 FIELDS 1 a', 'HTTL h FIELDS 1 a', 'HGETEX h PERSIST FIELDS 1 a', 'HTTL h FIELDS 1 a',
    'HGETEX h FIELDS 2 a b',
  ], V80),
  s('HGETEX errors', ['HSET h a 1', 'HGETEX h EX 0 FIELDS 1 a', 'HGETEX h EX 10 PX 10 FIELDS 1 a', 'HGETEX h EX abc FIELDS 1 a', 'HGETEX h FIELDS 3 a'], V80),
  s('HSETEX FNX FXX and KEEPTTL', [
    'HSETEX h FNX EX 100 FIELDS 2 a 1 b 2', 'HSETEX h FNX FIELDS 1 a 9', 'HSETEX h FXX KEEPTTL FIELDS 1 a 5', 'HTTL h FIELDS 1 a',
    'HGETALL h', 'HSETEX h FXX FIELDS 1 z 1',
  ], V80),
  s('HSETEX errors', ['HSETEX h FIELDS 2 a 1', 'HSETEX h EX 0 FIELDS 1 a 1', 'HSETEX h FNX FXX FIELDS 1 a 1', 'HSETEX h FIELDS 1 a', 'SET k v', 'HSETEX k FIELDS 1 a 1'], V80),
]);
