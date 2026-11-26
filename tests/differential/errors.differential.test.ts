import { expect, it } from 'vitest';

import { differential, s } from './differential.harness';
import type { Scenario } from './differential.harness';
import { parseResp } from './differential.resp';

/** One representative key of every type and a command of each type to run against the others. */
const TYPES: Record<string, { create: string; probe: string }> = {
  string: { create: 'SET k v', probe: 'APPEND k x' },
  list: { create: 'RPUSH k a', probe: 'LPUSH k x' },
  hash: { create: 'HSET k f v', probe: 'HGET k f' },
  set: { create: 'SADD k a', probe: 'SISMEMBER k a' },
  zset: { create: 'ZADD k 1 a', probe: 'ZSCORE k a' },
  stream: { create: 'XADD k 1-1 f v', probe: 'XLEN k' },
};

function wrongType(): Scenario[] {
  const out: Scenario[] = [];
  for (const [have, { create }] of Object.entries(TYPES)) {
    for (const [want, { probe }] of Object.entries(TYPES)) {
      if (have !== want) out.push(s(`WRONGTYPE: ${want} command on a ${have}`, [create, probe, 'TYPE k']));
    }
  }
  return out;
}

/** Commands called with too few (and, where fixed, too many) arguments. */
const ARITY = ['GET', 'GET a b', 'SET k', 'SETNX k', 'SETEX k 10', 'GETSET k', 'MSET a', 'MSET a 1 b', 'MGET', 'INCR', 'INCR a b',
  'INCRBY k', 'DECRBY k', 'APPEND k', 'STRLEN', 'GETRANGE k 0', 'SETRANGE k 0', 'DEL', 'EXISTS', 'EXPIRE k', 'TTL', 'PERSIST',
  'TYPE', 'RENAME a', 'LPUSH l', 'RPOP', 'LRANGE l 0', 'LINDEX l', 'LSET l 0', 'LREM l 0', 'LINSERT l BEFORE a', 'LMOVE a b left',
  'BLPOP l', 'HSET h f', 'HSET h f v g', 'HGET h', 'HMGET h', 'HDEL h', 'HINCRBY h f', 'HGETALL', 'SADD s', 'SREM s', 'SMOVE a b',
  'SINTERCARD', 'ZADD z 1', 'ZADD z', 'ZSCORE z', 'ZRANGE z 0', 'ZINCRBY z 1', 'ZRANGEBYSCORE z 0', 'XADD s', 'XADD s *', 'XLEN',
  'XRANGE s -', 'XREAD', 'PFADD', 'PFCOUNT', 'GEOADD g 1 2', 'SETBIT k 0', 'GETBIT k', 'BITOP and', 'PUBLISH ch', 'SUBSCRIBE',
  'EVAL', 'EVALSHA', 'WATCH', 'EXPIREAT k', 'OBJECT', 'SORT', 'RANDOMKEY x', 'KEYS', 'SCAN', 'DUMP', 'RESTORE k 0', 'COPY a'];

/** Commands with a syntax error in their options. */
const SYNTAX = ['SET k v bogus', 'SET k v EX 10 PX 10', 'SET k v NX XX', 'SET k v EX', 'SET k v KEEPTTL EX 10', 'SET k v GET GET',
  'GETEX k EX 1 PX 1', 'GETEX k bogus', 'ZADD z NX XX 1 a', 'ZADD z GT LT 1 a', 'ZADD z NX GT 1 a', 'ZADD z INCR 1 a 2 b',
  'ZADD z 1 a 2', 'ZRANGE z 0 1 bogus', 'ZRANGE z 0 1 LIMIT 0 1', 'LPOS l a RANK 0', 'LPOS l a bogus', 'SORT k bogus',
  'EXPIRE k 10 NX XX', 'EXPIRE k 10 GT LT', 'EXPIRE k 10 bogus', 'BITCOUNT k 0', 'BITCOUNT k 0 1 bogus', 'SCAN 0 bogus 1',
  'SCAN 0 COUNT 0', 'SCAN 0 TYPE', 'HSCAN h 0 COUNT', 'XADD s NOMKSTREAM', 'XADD s MAXLEN abc * f v', 'XREAD STREAMS s',
  'XREAD COUNT 1 s 0', 'GEOADD g NX XX 1 2 m', 'LMPOP 1 l bogus', 'LMPOP 0 l left', 'ZINTERSTORE d 0 a', 'ZUNION 2 a b WEIGHTS 1',
  'SINTERCARD 2 a b LIMIT -1', 'SRANDMEMBER s 1 2', 'HRANDFIELD h 1 bogus', 'GETRANGE k a b', 'RESTORE k 0 bad bogus', 'COPY a b DB'];

/** Integer / float parse errors. */
const NUMBERS = ['INCRBY k abc', 'INCRBY k 1.5', 'INCRBY k ""', 'DECRBY k 9223372036854775808', 'EXPIRE k abc', 'LRANGE l a b',
  'SETRANGE k abc v', 'SETRANGE k -1 v', 'LINDEX l x', 'HINCRBY h f abc', 'HINCRBY h f 1e3', 'INCRBYFLOAT k abc', 'INCRBYFLOAT k ""',
  'HINCRBYFLOAT h f abc', 'ZADD z abc a', 'ZADD z nan a', 'ZINCRBY z abc a', 'ZRANGEBYSCORE z a b', 'ZRANGEBYSCORE z (a 1',
  'ZRANGEBYLEX z a b', 'ZCOUNT z 1 x', 'SETBIT k -1 1', 'SETBIT k 0 2', 'SETBIT k 4294967296 1', 'GETBIT k abc', 'LPOS l a COUNT -1',
  'LPOS l a MAXLEN -1', 'SRANDMEMBER s abc', 'SPOP s -1', 'OBJECT FREQ', 'BITPOS k 2', 'GEOADD g 200 100 m', 'GEOADD g abc 1 m',
  'PEXPIRE k 1.5', 'SELECT 1e1', 'LRANGE l 0 9223372036854775808', 'RESTORE k abc x', 'XADD s 1-x f v', 'XRANGE s x +', 'XTRIM s MAXLEN x'];

// error texts: WRONGTYPE, arity, unknown commands / subcommands, syntax and number parsing
differential('errors', [
  ...wrongType(),
  s('WRONGTYPE for a string command on a list', ['RPUSH k a', 'GET k', 'INCR k', 'STRLEN k']),
  s('WRONGTYPE for SINTER with a mixed key', ['SADD a x', 'SET b y', 'SINTER a b', 'SINTER b a']),
  s('WRONGTYPE for RPOPLPUSH destination', ['RPUSH a x', 'SET b y', 'RPOPLPUSH a b', 'LRANGE a 0 -1']),
  s('WRONGTYPE for SMOVE destination', ['SADD a x', 'SET b y', 'SMOVE a b x', 'SMEMBERS a']),
  s('WRONGTYPE for MSETNX is not raised', ['RPUSH a x', 'MSETNX a 1 b 2', 'GET b']),
  s('WRONGTYPE for PFADD on a plain string', ['SET k notahll', 'PFADD k a', 'PFCOUNT k']),
  ...ARITY.map((cmd) => s(`arity: ${cmd}`, [cmd])),
  ...SYNTAX.map((cmd) => s(`syntax: ${cmd}`, ['SET k 1', 'RPUSH l a', 'ZADD z 1 a', 'SADD s a', 'HSET h f 1', cmd])),
  ...NUMBERS.map((cmd) => s(`number: ${cmd}`, ['SET k 1', 'RPUSH l a', 'ZADD z 1 a', 'SADD s a', 'HSET h f 1', cmd])),

  // integer / float semantics
  s('INCR of a non-integer string', ['SET k abc', 'INCR k', 'SET k 1.5', 'INCR k', 'SET k " 1"', 'INCR k']),
  s('INCR overflow', ['SET k 9223372036854775807', 'INCR k', 'SET k -9223372036854775808', 'DECR k', 'INCRBY k -1']),
  s('INCRBYFLOAT to infinity', ['SET k 1', 'INCRBYFLOAT k inf', 'SET k 1e308', 'INCRBYFLOAT k 1e308']),
  s('HINCRBY overflow', ['HSET h f 9223372036854775807', 'HINCRBY h f 1']),
  s('HINCRBY on a non-integer field', ['HSET h f abc', 'HINCRBY h f 1', 'HINCRBYFLOAT h f 1']),
  s('ZINCRBY producing NaN', ['ZADD z inf a', 'ZINCRBY z -inf a']),

  // expire times
  s('SET with an invalid expire', ['SET k v EX 0', 'SET k v EX -1', 'SET k v PX 0', 'SET k v EXAT 0', 'SET k v PXAT -5']),
  s('SET with an overflowing expire', ['SET k v EX 9223372036854775807', 'SET k v PX 9223372036854775807']),
  s('SETEX and PSETEX with an invalid expire', ['SETEX k 0 v', 'SETEX k -1 v', 'PSETEX k 0 v', 'PSETEX k abc v']),
  s('GETEX with an invalid expire', ['SET k v', 'GETEX k EX 0', 'GETEX k PX -1', 'GETEX k EXAT abc']),
  s('EXPIRE with an overflowing time', ['SET k v', 'EXPIRE k 9223372036854775807', 'PEXPIRE k 9223372036854775807', 'EXPIREAT k 9223372036854775807']),
  s('EXPIRE with a negative time deletes', ['SET k v', 'EXPIRE k -1', 'EXISTS k']),

  // unknown commands and subcommands
  s('unknown command without arguments', ['NOSUCH']),
  s('unknown command with arguments', ['NOSUCH a b c']),
  s('unknown command with a long argument', ['NOSUCH aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbb']),
  s('unknown command with many arguments', ['NOSUCH a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 a12 a13 a14 a15 a16 a17 a18 a19 a20 a21 a22 a23 a24 a25 a26 a27 a28 a29 a30 a31 a32 a33 a34 a35 a36 a37 a38 a39 a40']),
  s('unknown command with special characters', ['"NO SUCH" "a b" "c\\nd"', '"bad\\r\\n" x']),
  s('unknown command named with a quote', ["\"it's\" \"x'y\""]),
  s('empty command name', ['""', '"" a']),
  s('empty multibulk is ignored', [{ cmd: [], replies: 0 }, 'PING']),
  s('unknown subcommands', ['CONFIG bogus', 'XINFO bogus', 'OBJECT bogus x', 'SCRIPT bogus', 'FUNCTION bogus', 'MEMORY bogus',
    'XGROUP bogus', 'PUBSUB bogus', 'ACL bogus', 'LATENCY bogus', 'MODULE bogus', 'CLIENT bogus', 'SLOWLOG bogus', 'COMMAND bogus']),
  s('unknown subcommand with arguments', ['CONFIG bogus a b']),
  s('subcommand arity', ['CONFIG GET', 'OBJECT ENCODING', 'XINFO STREAM', 'SCRIPT EXISTS', 'CLIENT KILL', 'MEMORY USAGE']),
  s('container command without subcommand', ['CONFIG', 'XINFO', 'SCRIPT', 'FUNCTION', 'MEMORY', 'XGROUP', 'PUBSUB', 'ACL']),
  s('CLUSTER without cluster support', ['CLUSTER INFO', 'CLUSTER bogus', 'READONLY']),

  // transactions
  s('nested MULTI', ['MULTI', 'MULTI', 'EXEC']),
  s('EXEC and DISCARD without MULTI', ['EXEC', 'DISCARD']),
  s('WATCH inside MULTI', ['MULTI', 'WATCH k', 'EXEC']),
  s('EXECABORT after a queued error', ['MULTI', 'SET k v', 'NOSUCH', 'GET', 'EXEC', 'GET k']),
  s('runtime error inside EXEC', ['SET k v', 'MULTI', 'INCR k', 'SET k w', 'EXEC', 'GET k']),

  // pub/sub context
  s('commands not allowed in RESP2 subscriber context', ['SUBSCRIBE ch', 'GET k', 'PING', 'PING x'], { proto: 2 }),
  s('commands allowed in RESP3 subscriber context', ['SUBSCRIBE ch', 'SET k v', 'GET k'], { proto: 3 }),
], ({ env }) => {
  // HELP replies: same number of lines and the same RESP type for every line (the text of the footer changed in 7.2)
  for (const cmd of ['XINFO', 'CONFIG', 'OBJECT', 'MEMORY', 'SCRIPT', 'FUNCTION', 'XGROUP', 'PUBSUB', 'SLOWLOG', 'LATENCY', 'ACL', 'COMMAND']) {
    it(`${cmd} HELP: line count and reply types`, async () => {
      const p = await env().pair(2);
      try {
        const types = async (c: typeof p.oracle): Promise<string[]> =>
          parseResp(await c.call([cmd, 'HELP'])).node.children.map((n) => n.type);
        expect(await types(p.lite)).toEqual(await types(p.oracle));
      } finally {
        await p.close();
      }
    });
  }
});
