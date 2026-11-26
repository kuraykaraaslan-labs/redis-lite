import { differential, s } from './differential.harness';

/** Blocking list commands: timeouts (short, so they expire quickly), wake-ups from another connection, errors. */
differential('lists-blocking', [
  // timeouts
  s('BLPOP short timeout returns nil', ['BLPOP l 0.1', 'BRPOP l1 l2 0.1']),
  s('BLMOVE and BRPOPLPUSH short timeout', ['BLMOVE a b LEFT RIGHT 0.1', 'BRPOPLPUSH a b 0.1', 'EXISTS b']),
  s('BLMPOP short timeout', ['BLMPOP 0.1 2 a b LEFT', 'BLMPOP 0.1 1 a RIGHT COUNT 3']),
  s('integer timeout is seconds', ['RPUSH l a', 'BLPOP l 1', 'BLPOP l 0.05']),

  // immediate data
  s('BLPOP returns at once when data exists', ['RPUSH b x y', 'BLPOP a b 0', 'BRPOP a b 0', 'EXISTS b']),
  s('BLPOP takes the first non-empty key in order', ['RPUSH b b1', 'RPUSH c c1', 'BLPOP a c b 0', 'BLPOP a c b 0']),
  s('BLMOVE immediate and same list', ['RPUSH l a b c', 'BLMOVE l l LEFT RIGHT 0', 'LRANGE l 0 -1', 'BRPOPLPUSH l l 0', 'LRANGE l 0 -1']),
  s('BLMPOP immediate with count', ['RPUSH l a b c', 'BLMPOP 0 2 x l RIGHT COUNT 2', 'BLMPOP 0 1 l LEFT COUNT 9', 'EXISTS l']),

  // wake-ups from another connection
  s('BLPOP woken by RPUSH', [{ c: 1, cmd: 'BLPOP l 0', wait: false }, { blocked: 1 }, 'RPUSH l x y', { c: 1, read: 1 }, 'LRANGE l 0 -1']),
  s('BRPOP woken by LPUSH of several', [{ c: 1, cmd: 'BRPOP l 0', wait: false }, { blocked: 1 }, 'LPUSH l a b c', { c: 1, read: 1 }, 'LRANGE l 0 -1']),
  s('BLPOP on several keys woken by the second key', [{ c: 1, cmd: 'BLPOP a b c 0', wait: false }, { blocked: 1 }, 'RPUSH b v', { c: 1, read: 1 }]),
  s('two blocked clients served in FIFO order', [
    { c: 1, cmd: 'BLPOP l 0', wait: false }, { blocked: 1 }, { c: 2, cmd: 'BLPOP l 0', wait: false }, { blocked: 2 },
    'RPUSH l first', { c: 1, read: 1 }, 'RPUSH l second', { c: 2, read: 1 }, 'EXISTS l',
  ]),
  s('one push of two elements serves two clients', [
    { c: 1, cmd: 'BLPOP l 0', wait: false }, { blocked: 1 }, { c: 2, cmd: 'BRPOP l 0', wait: false }, { blocked: 2 },
    'RPUSH l a b c', { c: 1, read: 1 }, { c: 2, read: 1 }, 'LRANGE l 0 -1',
  ]),
  s('BLMOVE woken moves to destination', [{ c: 1, cmd: 'BLMOVE src dst RIGHT LEFT 0', wait: false }, { blocked: 1 }, 'RPUSH src a b', { c: 1, read: 1 }, 'LRANGE src 0 -1', 'LRANGE dst 0 -1']),
  s('BRPOPLPUSH woken', [{ c: 1, cmd: 'BRPOPLPUSH src dst 0', wait: false }, { blocked: 1 }, 'LPUSH src a', { c: 1, read: 1 }, 'LRANGE dst 0 -1', 'EXISTS src']),
  s('BLMOVE chain wakes a client blocked on the destination', [
    { c: 1, cmd: 'BLPOP dst 0', wait: false }, { blocked: 1 }, { c: 2, cmd: 'BLMOVE src dst LEFT LEFT 0', wait: false }, { blocked: 2 },
    'RPUSH src x', { c: 2, read: 1 }, { c: 1, read: 1 }, 'EXISTS src dst',
  ]),
  s('BLMPOP woken with count', [{ c: 1, cmd: 'BLMPOP 0 2 a b LEFT COUNT 2', wait: false }, { blocked: 1 }, 'RPUSH b x y z', { c: 1, read: 1 }, 'LRANGE b 0 -1']),
  s('blocked client woken inside a MULTI push', [
    { c: 1, cmd: 'BLPOP l 0', wait: false }, { blocked: 1 }, 'MULTI', 'RPUSH l a', 'RPUSH l b', 'LPOP l', 'EXEC', { c: 1, read: 1 }, 'LRANGE l 0 -1',
  ]),
  s('push then pop in MULTI does not wake the client', [
    { c: 1, cmd: 'BLPOP l 0.5', wait: false }, { blocked: 1 }, 'MULTI', 'RPUSH l a', 'LPOP l', 'EXEC', { c: 1, read: 1, timeout: 5_000 },
  ]),
  s('SET of the key does not wake a list waiter', [{ c: 1, cmd: 'BLPOP l 0.3', wait: false }, { blocked: 1 }, 'SET l v', { c: 1, read: 1, timeout: 5_000 }, 'GET l']),
  s('LMOVE into a watched key wakes the waiter', [{ c: 1, cmd: 'BRPOP dst 0', wait: false }, { blocked: 1 }, 'RPUSH src a b', 'LMOVE src dst LEFT LEFT', { c: 1, read: 1 }, 'LRANGE src 0 -1']),
  s('blocking pop timeout then later push', [{ c: 1, cmd: 'BLPOP l 0.1', wait: false }, { c: 1, read: 1, timeout: 5_000 }, 'RPUSH l a', 'LLEN l']),

  // inside MULTI blocking commands do not block
  s('BLPOP in MULTI behaves as non-blocking', ['MULTI', 'BLPOP l 0', 'BRPOP l 10', 'BLMOVE l m LEFT LEFT 0', 'BLMPOP 0 1 l LEFT', 'EXEC']),
  s('BLPOP in MULTI with data', ['RPUSH l a b', 'MULTI', 'BLPOP l 0', 'BLMPOP 0 1 l LEFT', 'EXEC']),

  // errors
  s('BLPOP timeout validation', ['BLPOP l -1', 'BLPOP l abc', 'BLPOP l ""', 'BLPOP l nan', 'BLPOP l 0x10', 'BLPOP l -0.1', 'BLPOP l 1.5.5']),
  s('BLPOP timeout overflowing milliseconds', ['BLPOP l 1e100', 'BLPOP l 9223372036854775807', 'BLPOP l 9223372036854776', 'BLPOP l 1e17']),
  s('BLPOP infinite timeout', ['BLPOP l inf', 'BLMPOP inf 1 l LEFT', 'BLPOP l -inf']),
  s('BLPOP very large timeout still blocks', [{ c: 1, cmd: 'BLPOP l 3000000', wait: false }, { blocked: 1 }, { sleep: 100 }, 'RPUSH l x', { c: 1, read: 1 }]),
  s('BLMOVE huge but valid timeout still blocks', [{ c: 1, cmd: 'BLMOVE a b LEFT LEFT 1e15', wait: false }, { blocked: 1 }, { sleep: 100 }, 'RPUSH a x', { c: 1, read: 1 }, 'LRANGE b 0 -1']),
  s('BLMOVE and BRPOPLPUSH timeout validation', ['BLMOVE a b LEFT LEFT -1', 'BLMOVE a b LEFT LEFT x', 'BRPOPLPUSH a b -2', 'BRPOPLPUSH a b x']),
  s('BLMPOP timeout validation', ['BLMPOP -1 1 l LEFT', 'BLMPOP x 1 l LEFT']),
  s('blocking commands arity', ['BLPOP l', 'BLPOP', 'BRPOP l', 'BLMOVE a b LEFT', 'BRPOPLPUSH a b', 'BLMPOP 0 1 l']),
  s('BLMPOP option errors', [
    'BLMPOP 0 0 l LEFT', 'BLMPOP 0 2 l LEFT', 'BLMPOP 0 1 l UP', 'BLMPOP 0 1 l LEFT COUNT 0', 'BLMPOP 0 1 l LEFT COUNT -2',
    'BLMPOP 0 1 l LEFT COUNT 1 COUNT 1', 'BLMPOP 0 x l LEFT',
  ]),
  s('BLMOVE direction errors', ['BLMOVE a b UP LEFT 0', 'BLMOVE a b LEFT DOWN 0']),
  s('BLPOP WRONGTYPE with and without data', ['SET k v', 'BLPOP k 0', 'RPUSH l a', 'BLPOP k l 0', 'BLPOP l k 0', 'BLMOVE k l LEFT LEFT 0', 'BLMPOP 0 2 k l LEFT']),
  s('BLMOVE wrong type destination', ['RPUSH l a', 'SET d v', 'BLMOVE l d LEFT LEFT 0', 'LRANGE l 0 -1']),
]);
