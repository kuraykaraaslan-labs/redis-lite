import { differential, s } from './differential.harness';
import { shape, sorted } from './differential.normalizers';

differential('keys', [
  // DEL / UNLINK / EXISTS / TOUCH
  s('DEL with duplicate keys', ['MSET a 1 b 2', 'DEL a a b missing', 'EXISTS a b', 'DEL', 'DEL missing']),
  s('UNLINK with duplicate keys', ['MSET a 1 b 2', 'RPUSH l x', 'UNLINK a a l missing', 'EXISTS a b l', 'UNLINK']),
  s('EXISTS counts duplicates', ['SET a 1', 'EXISTS a a a', 'EXISTS a missing a', 'EXISTS', 'EXISTS missing']),
  s('TOUCH', ['MSET a 1 b 2', 'TOUCH a b c a', 'TOUCH', 'TOUCH missing']),
  s('DEL every type', ['SET s v', 'RPUSH l a', 'SADD set a', 'HSET h f v', 'ZADD z 1 a', 'XADD x 1-1 f v', 'DEL s l set h z x', 'DBSIZE']),

  // TYPE
  s('TYPE of every type', [
    'SET s v', 'RPUSH l a', 'SADD set a', 'HSET h f v', 'ZADD z 1 a', 'XADD x 1-1 f v', 'PFADD hll a', 'SETBIT bm 3 1',
    'TYPE s', 'TYPE l', 'TYPE set', 'TYPE h', 'TYPE z', 'TYPE x', 'TYPE hll', 'TYPE bm', 'TYPE missing', 'TYPE', 'TYPE a b',
  ]),

  // RENAME / RENAMENX
  s('RENAME basics', ['SET a 1', 'RENAME a b', 'GET a', 'GET b', 'RENAME missing x', 'SET c 3', 'RENAME b c', 'GET c']),
  s('RENAME to the same key', ['SET a 1', 'RENAME a a', 'GET a', 'RENAME missing missing', 'RENAMENX a a', 'RENAMENX missing missing']),
  s('RENAME keeps TTL', ['SET a 1 EXAT 4102444800', 'RENAME a b', 'EXPIRETIME b', 'SET c 1', 'RENAME c b', 'TTL b']),
  s('RENAME overwrites other type', ['RPUSH l x', 'SET s v', 'RENAME l s', 'TYPE s', 'LRANGE s 0 -1']),
  s('RENAMENX', ['MSET a 1 b 2', 'RENAMENX a b', 'RENAMENX a c', 'MGET a b c', 'RENAMENX missing z']),
  s('RENAME arity', ['RENAME a', 'RENAME', 'RENAME a b c', 'RENAMENX a']),

  // COPY / MOVE / SELECT / SWAPDB
  s('COPY basics', ['SET a v EXAT 4102444800', 'COPY a b', 'GET b', 'EXPIRETIME b', 'COPY a b', 'COPY a b REPLACE', 'COPY missing c']),
  s('COPY every type', [
    'RPUSH l a b', 'SADD s x y', 'HSET h f v', 'ZADD z 1 m', 'XADD x 1-1 f v', 'COPY l l2', 'COPY s s2', 'COPY h h2', 'COPY z z2',
    'COPY x x2', 'LRANGE l2 0 -1', { cmd: 'SMEMBERS s2', norm: sorted }, 'HGETALL h2', 'ZRANGE z2 0 -1 WITHSCORES', 'XRANGE x2 - +',
  ]),
  s('COPY to another DB', ['SET a v', 'COPY a a DB 1', 'SELECT 1', 'GET a', 'COPY a a DB 0', 'COPY a a DB 0 REPLACE', 'SELECT 0', 'GET a']),
  s('COPY same key same DB', ['SET a v', 'COPY a a', 'COPY a a REPLACE', 'COPY a a DB 0']),
  s('COPY option errors', ['SET a v', 'COPY a b DB', 'COPY a b DB x', 'COPY a b DB 16', 'COPY a b DB -1', 'COPY a b FOO', 'COPY a', 'COPY a b REPLACE REPLACE', 'EXISTS b']),
  s('MOVE', ['SET a v', 'MOVE a 1', 'EXISTS a', 'SELECT 1', 'GET a', 'SET a x', 'SELECT 0', 'SET a y', 'MOVE a 1', 'MOVE missing 1']),
  s('MOVE errors', ['SET a v', 'MOVE a 0', 'MOVE a 16', 'MOVE a -1', 'MOVE a x', 'MOVE a', 'MOVE']),
  s('MOVE keeps TTL', ['SET a v EXAT 4102444800', 'MOVE a 2', 'SELECT 2', 'EXPIRETIME a']),
  s('SELECT', ['SELECT 15', 'SELECT 16', 'SELECT -1', 'SELECT x', 'SELECT 1.5', 'SELECT', 'SELECT 0 1']),
  s('SELECT isolates databases', ['SET a 0', 'SELECT 3', 'EXISTS a', 'SET a 3', 'DBSIZE', 'SELECT 0', 'GET a', 'DBSIZE']),
  s('SWAPDB', ['SET a 0', 'SELECT 1', 'SET b 1', 'SWAPDB 0 1', 'GET a', 'GET b', 'SELECT 0', 'GET b', 'SWAPDB 0 0', 'GET b']),
  s('SWAPDB errors', ['SWAPDB 0 16', 'SWAPDB -1 0', 'SWAPDB x 0', 'SWAPDB 0 y', 'SWAPDB 0', 'SWAPDB 0 1 2']),
  s('FLUSHDB and DBSIZE per database', ['SET a 1', 'SELECT 1', 'SET b 1', 'FLUSHDB', 'DBSIZE', 'SELECT 0', 'DBSIZE', 'FLUSHDB ASYNC', 'DBSIZE', 'FLUSHDB FOO']),

  // KEYS patterns
  s('KEYS star and question mark', ['MSET hello 1 hallo 1 hxllo 1 hllo 1 heeeello 1', { cmd: 'KEYS h?llo', norm: sorted }, { cmd: 'KEYS h*llo', norm: sorted }, { cmd: 'KEYS *', norm: sorted }]),
  s('KEYS character classes and ranges', [
    'MSET hello 1 hallo 1 hbllo 1 hxllo 1', { cmd: 'KEYS h[ae]llo', norm: sorted }, { cmd: 'KEYS h[^e]llo', norm: sorted },
    { cmd: 'KEYS h[a-b]llo', norm: sorted }, { cmd: 'KEYS h[!e]llo', norm: sorted },
  ]),
  s('KEYS reversed range', ['MSET hallo 1 hbllo 1 hcllo 1', { cmd: 'KEYS h[b-a]llo', norm: sorted }, { cmd: 'KEYS h[c-b]llo', norm: sorted }]),
  s('KEYS escapes', [
    'MSET "a*b" 1 axb 1 "a?b" 1 "a[b" 1 "a\\\\b" 1', { cmd: 'KEYS a\\*b', norm: sorted }, { cmd: 'KEYS a\\?b', norm: sorted },
    { cmd: 'KEYS a\\[b', norm: sorted }, { cmd: 'KEYS a\\\\b', norm: sorted }, { cmd: 'KEYS a[\\]]b', norm: sorted },
  ]),
  s('KEYS unterminated and odd patterns', [
    'MSET "a[" 1 ab 1 "a]" 1 "a-" 1 "a\\\\" 1', { cmd: 'KEYS a[]', norm: sorted }, { cmd: 'KEYS a\\', norm: sorted }, { cmd: 'KEYS a[-]', norm: sorted },
    { cmd: 'KEYS ***b', norm: sorted }, { cmd: 'KEYS ""', norm: sorted },
  ]),
  s('KEYS unterminated character class', ['MSET "a[" 1 ab 1 "a]" 1 "a-" 1', { cmd: 'KEYS a[', norm: sorted }, { cmd: 'KEYS a[b', norm: sorted }, { cmd: 'KEYS a[a-]', norm: sorted }]),
  s('KEYS skips expired and arity', ['SET a 1 PX 1', { sleep: 30 }, 'SET b 1', 'KEYS *', 'KEYS', 'KEYS a b']),

  // SCAN
  s('SCAN full iteration', ['MSET a 1 b 2 c 3 d 4 e 5', 'RPUSH l x', { scan: 'SCAN 0' }, { scan: 'SCAN 0 COUNT 1' }, { scan: 'SCAN 0 MATCH [a-c]' }]),
  s('SCAN TYPE filter', ['MSET a 1 b 2', 'RPUSH l x', 'SADD s m', 'ZADD z 1 m', 'HSET h f v', { scan: 'SCAN 0 TYPE string' }, { scan: 'SCAN 0 TYPE list' }, { scan: 'SCAN 0 TYPE zset MATCH z' }, { scan: 'SCAN 0 TYPE nosuchtype' }, { scan: 'SCAN 0 TYPE STRING' }]),
  s('SCAN many keys', [...Array.from({ length: 10 }, (_, i) => `MSET k${i}0 1 k${i}1 1 k${i}2 1 k${i}3 1 k${i}4 1 k${i}5 1 k${i}6 1 k${i}7 1 k${i}8 1 k${i}9 1`), { scan: 'SCAN 0 COUNT 7' }, { scan: 'SCAN 0 MATCH k1*' }]),
  s('SCAN argument errors', ['SCAN x', 'SCAN 0 COUNT 0', 'SCAN 0 COUNT -1', 'SCAN 0 COUNT x', 'SCAN 0 MATCH', 'SCAN 0 FOO bar', 'SCAN 0 TYPE', 'SCAN', 'SCAN 1.5', 'SCAN " 1"']),
  s('SCAN cursor is parsed as unsigned 64-bit', ['SCAN -1', 'SCAN 18446744073709551615', 'SCAN 18446744073709551616']),
  s('SCAN on empty database', ['SCAN 0', 'SCAN 0 MATCH x* COUNT 100 TYPE string']),

  // RANDOMKEY / DBSIZE
  s('RANDOMKEY', ['RANDOMKEY', 'SET only 1', 'RANDOMKEY', 'MSET a 1 b 2', { cmd: 'RANDOMKEY', norm: shape }, 'RANDOMKEY x']),
  s('DBSIZE', ['DBSIZE', 'MSET a 1 b 2', 'DBSIZE', 'DBSIZE x']),

  // unknown / arity errors around the keyspace
  s('unknown command text', ['NOSUCHCMD a b', 'nosuchcmd', 'GETT k "a b"']),
]);
