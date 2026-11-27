import { differential, s, v } from './differential.harness';
import type { Step } from './differential.harness';
import { streamIds } from './differential.normalizers';
import { intProbes } from './differential.probes';

/** `n` XADD steps with explicit ids `<base + i>-0`. */
function fill(key: string, n: number, base = 1): Step[] {
  return Array.from({ length: n }, (_, i) => `XADD ${key} ${base + i}-0 f ${i}`);
}

differential('streams', [
  // XADD ids
  s('XADD explicit ids and XRANGE', ['XADD s 1-1 a 1', 'XADD s 1-2 b 2 c 3', 'XADD s 2-0 d 4', 'XRANGE s - +', 'XLEN s']),
  s('XADD 0-0 rejected', ['XADD s 0-0 f v', 'EXISTS s', 'XADD s 0-1 f v', 'XADD s 0-0 f v']),
  s('XADD id equal or smaller than top', ['XADD s 5-5 f v', 'XADD s 5-5 f v', 'XADD s 5-4 f v', 'XADD s 4-9 f v', 'XADD s 5 f v']),
  s('XADD ms only id gets seq 0', ['XADD s 7 f v', 'XADD s 8 f v', 'XRANGE s - +']),
  s('XADD ms-* partial ids', ['XADD s 5-* f v', 'XADD s 5-* f v', 'XADD s 6-* f v', 'XADD s 4-* f v', 'XADD s 6-* f v', 'XRANGE s - +']),
  s('XADD 0-* starts at 1', ['XADD s 0-* f v', 'XADD s 0-* f v']),
  s('XADD ms-* after max seq', ['XADD s 3-18446744073709551615 f v', 'XADD s 3-* f v']),
  s('XADD next ms-* after max seq', ['XADD s 3-18446744073709551615 f v', 'XADD s 4-* f v', 'XADD s 3 f v']),
  s('XADD max id then star', ['XADD s 18446744073709551615-18446744073709551615 f v', 'XADD s * f v', 'XADD s 18446744073709551615-* f v']),
  s('XADD invalid ids', ['XADD s abc f v', 'XADD s 1-abc f v', 'XADD s -1 f v', 'XADD s 1- f v', 'XADD s -  f v', 'XADD s 1-2-3 f v', 'XADD s *-1 f v', 'XADD s 18446744073709551616 f v']),
  s('XADD star id shape', ['XADD s * f v', 'XLEN s'], { norm: streamIds }),
  s('XADD star after explicit future id', ['XADD s 99999999999999-0 f v', 'XADD s * f v']),
  s('XADD arity and odd field list', ['XADD s', 'XADD s *', 'XADD s * f', 'XADD s * f v g', 'XADD']),
  s('XADD on wrong type', ['SET k v', 'XADD k * f v', 'XLEN k', 'XRANGE k - +']),
  s('XADD binary fields and empty value', ['XADD s 1-0 "\\x00\\xff" "" "" x', 'XRANGE s - +']),
  s('XADD duplicate fields kept', ['XADD s 1-0 f 1 f 2', 'XRANGE s - +']),

  // XADD NOMKSTREAM / MAXLEN / MINID
  s('XADD NOMKSTREAM on missing key', ['XADD s NOMKSTREAM 1-0 f v', 'EXISTS s', 'XADD s 1-0 f v', 'XADD s NOMKSTREAM 2-0 f v', 'XLEN s']),
  s('XADD MAXLEN exact', [...fill('s', 5), 'XADD s MAXLEN 3 6-0 f v', 'XRANGE s - +', 'XADD s MAXLEN = 1 7-0 f v', 'XRANGE s - +']),
  s('XADD MAXLEN 0 keeps empty stream', ['XADD s MAXLEN 0 1-0 f v', 'XLEN s', 'EXISTS s', 'XINFO STREAM s']),
  s('XADD MAXLEN approx small stream untouched', [...fill('s', 10), 'XADD s MAXLEN ~ 2 11-0 f v', 'XLEN s']),
  s('XADD MAXLEN approx trims whole nodes', [...fill('s', 250), 'XADD s MAXLEN ~ 50 251-0 f v', 'XLEN s', 'XRANGE s - + COUNT 1']),
  s('XADD MAXLEN approx with LIMIT', [...fill('s', 250), 'XADD s MAXLEN ~ 10 LIMIT 100 251-0 f v', 'XLEN s', 'XADD s MAXLEN ~ 10 LIMIT 0 252-0 f v', 'XLEN s']),
  s('XADD LIMIT without approx', ['XADD s MAXLEN 10 LIMIT 5 1-0 f v', 'XADD s MINID = 1 LIMIT 5 1-0 f v', 'EXISTS s']),
  s('XADD MINID exact', [...fill('s', 5), 'XADD s MINID 3 6-0 f v', 'XRANGE s - +', 'XADD s MINID = 6-0 7-0 f v', 'XRANGE s - +']),
  s('XADD MINID greater than new id', [...fill('s', 3), 'XADD s MINID 100 4-0 f v', 'XLEN s', 'XINFO STREAM s']),
  s('XADD MINID approx', [...fill('s', 250), 'XADD s MINID ~ 200 251-0 f v', 'XLEN s']),
  s('XADD MAXLEN and MINID together', ['XADD s MAXLEN 1 MINID 1 1-0 f v']),
  s('XADD trimming option errors', ['XADD s MAXLEN -1 1-0 f v', 'XADD s MAXLEN abc 1-0 f v', 'XADD s MAXLEN ~ 1 LIMIT -1 1-0 f v', 'XADD s MINID abc 1-0 f v', 'XADD s MAXLEN', 'XADD s LIMIT 5 1-0 f v', 'XADD s MAXLEN ~ 1 LIMIT abc 1-0 f v']),
  s('XADD NOMKSTREAM with MAXLEN', ['XADD s NOMKSTREAM MAXLEN 1 1-0 f v', 'XADD s 1-0 f v', 'XADD s NOMKSTREAM MAXLEN 1 2-0 f v', 'XRANGE s - +']),

  // XRANGE / XREVRANGE
  s('XRANGE bounds and partial ids', [...fill('s', 5), 'XRANGE s 2 4', 'XRANGE s 2-0 2-0', 'XRANGE s 3 +', 'XRANGE s - 1', 'XRANGE s 4 2']),
  s('XRANGE exclusive ranges', [...fill('s', 5), 'XRANGE s (2-0 +', 'XRANGE s - (4-0', 'XRANGE s (1-0 (5-0', 'XRANGE s (2 (3', 'XRANGE s (5-0 +']),
  s('XRANGE exclusive edge errors', ['XADD s 1-0 f v', 'XRANGE s (- +', 'XRANGE s - (+', 'XRANGE s (18446744073709551615-18446744073709551615 +', 'XRANGE s - (0-0', 'XREVRANGE s (0-0 -']),
  s('XRANGE COUNT', [...fill('s', 5), 'XRANGE s - + COUNT 2', 'XRANGE s - + COUNT -1', 'XRANGE s - + COUNT abc', 'XRANGE s - + COUNT', 'XRANGE s - + LIMIT 2']),
  s('XRANGE COUNT 0', [...fill('s', 2), 'XRANGE s - + COUNT 0', 'XREVRANGE s + - COUNT 0', 'XRANGE missing - + COUNT 0']),
  s('XREVRANGE ordering and exclusive', [...fill('s', 5), 'XREVRANGE s + -', 'XREVRANGE s + - COUNT 2', 'XREVRANGE s (4-0 (1-0', 'XREVRANGE s 2 4', 'XREVRANGE s 4 2']),
  s('XRANGE missing key and wrong type', ['XRANGE s - +', 'XREVRANGE s + -', 'SET k v', 'XRANGE k - +', 'XRANGE s', 'XRANGE s bad +']),
  s('XRANGE incomplete id end defaults', ['XADD s 1-5 f v', 'XADD s 1-9 f v', 'XRANGE s 1 1', 'XREVRANGE s 1 1', 'XRANGE s 1-6 +']),

  // XLEN / XDEL / XTRIM
  s('XLEN and XDEL', [...fill('s', 4), 'XDEL s 2-0 3-0 9-0', 'XLEN s', 'XDEL s 2-0', 'XDEL missing 1-0', 'XRANGE s - +', 'XLEN missing']),
  s('XDEL errors', ['XADD s 1-0 f v', 'XDEL s', 'XDEL s bad', 'XDEL s 1-0 bad', 'XLEN s', 'SET k v', 'XDEL k 1-0', 'XLEN k']),
  s('XDEL all entries keeps key', ['XADD s 1-0 f v', 'XDEL s 1-0', 'EXISTS s', 'XLEN s', 'XINFO STREAM s']),
  s('XDEL then XADD smaller id', ['XADD s 5-0 f v', 'XDEL s 5-0', 'XADD s 4-0 f v', 'XADD s 6-0 f v']),
  s('XTRIM MAXLEN exact', [...fill('s', 6), 'XTRIM s MAXLEN 4', 'XTRIM s MAXLEN = 2', 'XRANGE s - +', 'XTRIM s MAXLEN 10', 'XTRIM missing MAXLEN 0']),
  s('XTRIM MINID', [...fill('s', 6), 'XTRIM s MINID 3', 'XTRIM s MINID = 5-0', 'XRANGE s - +', 'XTRIM s MINID 0']),
  s('XTRIM approximate with LIMIT', [...fill('s', 300), 'XTRIM s MAXLEN ~ 0 LIMIT 100', 'XLEN s', 'XTRIM s MAXLEN ~ 0', 'XLEN s']),
  s('XTRIM approximate MINID', [...fill('s', 300), 'XTRIM s MINID ~ 250', 'XLEN s', 'XTRIM s MINID ~ 250 LIMIT 1', 'XLEN s']),
  s('XTRIM errors', ['XADD s 1-0 f v', 'XTRIM s', 'XTRIM s MAXLEN', 'XTRIM s FOO 1', 'XTRIM s MAXLEN -1', 'XTRIM s MAXLEN 1 LIMIT 1', 'XTRIM s MAXLEN ~ 1 LIMIT -5', 'XTRIM s MINID bad', 'XTRIM s MAXLEN 1 MINID 1', 'XTRIM s MAXLEN 1 extra']),
  s('XTRIM wrong type', ['SET k v', 'XTRIM k MAXLEN 1']),

  // XREAD
  s('XREAD from ids', [...fill('a', 3), ...fill('b', 2), 'XREAD STREAMS a b 1-0 0', 'XREAD COUNT 1 STREAMS a b 0 0', 'XREAD STREAMS a b 3-0 2-0']),
  s('XREAD dollar non blocking is empty', ['XADD a 1-0 f v', 'XREAD STREAMS a $', 'XREAD STREAMS missing 0']),
  s('XREADGROUP unbalanced streams text', ['XREADGROUP GROUP g c STREAMS a b 0', 'xread STREAMS a b 0', 'xreadgroup GROUP g c STREAMS a b 0']),
  s('XREAD BLOCK from a script', ['XADD s 1-0 f v', 'SET str v', 'EVAL "return redis.call(\'XREAD\', \'BLOCK\', 0, \'STREAMS\', \'s\', \'0\')" 0', 'EVAL "return redis.call(\'XREAD\', \'BLOCK\', \'x\', \'STREAMS\', \'str\', \'$\')" 0', 'EVAL "return redis.call(\'XREAD\', \'COUNT\', \'x\', \'BLOCK\', 0, \'STREAMS\', \'s\', \'0\')" 0', 'EVAL "return redis.call(\'XREAD\', \'BLOCK\', 0, \'GROUP\', \'STREAMS\', \'s\', \'0\')" 0', 'EVAL "return redis.call(\'XREAD\', \'STREAMS\', \'s\', \'0\')" 0', 'EVAL "return redis.call(\'XREADGROUP\', \'GROUP\', \'g\', \'c\', \'BLOCK\', 0, \'STREAMS\', \'s\', \'>\')" 0', 'XGROUP CREATE s g 0', 'EVAL "return redis.call(\'XREADGROUP\', \'GROUP\', \'g\', \'c\', \'BLOCK\', 0, \'STREAMS\', \'s\', \'>\')" 0', 'EVAL "return redis.call(\'XREADGROUP\', \'GROUP\', \'g\', \'c\', \'STREAMS\', \'s\', \'>\')" 0']),
  s('XREAD unbalanced streams text', ['XREAD STREAMS a b 0'], v("error text names the command as 'xread' (quoted, lower case) instead of XREAD after 7.0", 'low')),
  s('XREAD errors', ['XREAD', 'XREAD STREAMS', 'XREAD STREAMS a', 'XREAD COUNT x STREAMS a 0', 'XREAD BLOCK -1 STREAMS a 0', 'XREAD BLOCK x STREAMS a 0', 'XREAD FOO STREAMS a 0', 'XREAD STREAMS a bad', 'XREAD STREAMS a >']),
  s('XREAD COUNT zero and negative', [...fill('a', 3), 'XREAD COUNT 0 STREAMS a 0', 'XREAD COUNT -1 STREAMS a 0']),
  s('XREAD wrong type', ['SET k v', 'XREAD STREAMS k 0', 'XREAD BLOCK 10 STREAMS k $']),
  s('XREAD plus id last entry', [...fill('a', 3), 'XREAD STREAMS a +'], v('XREAD + (last entry) added in 7.4', 'high')),
  s('XREAD BLOCK timeout', ['XADD a 1-0 f v', { cmd: 'XREAD BLOCK 50 STREAMS a $', timeout: 2000 }]),
  s('XREAD BLOCK wakes on XADD', [{ c: 1, cmd: 'XREAD BLOCK 0 STREAMS a $', wait: false }, { blocked: 1 }, 'XADD a 5-0 f v', { c: 1, read: 1 }]),
  s('XREAD BLOCK with explicit id served immediately', [...fill('a', 2), 'XREAD BLOCK 0 STREAMS a 1-0']),
  s('XREAD BLOCK on two streams', [{ c: 1, cmd: 'XREAD BLOCK 0 COUNT 5 STREAMS a b $ $', wait: false }, { blocked: 1 }, 'XADD b 1-0 x y', { c: 1, read: 1 }]),
  s('XREAD BLOCK ignores smaller id', ['XADD a 10-0 f v', { c: 1, cmd: 'XREAD BLOCK 0 STREAMS a 20-0', wait: false }, { blocked: 1 }, 'XADD a 15-0 f v', 'XADD a 25-0 f v', { c: 1, read: 1 }]),
  s('XREAD BLOCK key deleted then recreated', [{ c: 1, cmd: 'XREAD BLOCK 0 STREAMS a $', wait: false }, { blocked: 1 }, 'XADD a 1-0 f v', { c: 1, read: 1 }, 'DEL a', { c: 1, cmd: 'XREAD BLOCK 0 STREAMS a 0', wait: false }, { blocked: 1 }, 'XADD a 2-0 f v', { c: 1, read: 1 }]),
  s('XREAD BLOCK key overwritten with other type', [{ c: 1, cmd: 'XREAD BLOCK 0 STREAMS a $', wait: false }, { blocked: 1 }, 'SET a x', 'DEL a', 'XADD a 3-0 f v', { c: 1, read: 1 }]),

  // XSETID
  s('XSETID basics', ['XADD s 5-0 f v', 'XSETID s 10-0', 'XINFO STREAM s', 'XADD s 9-0 f v', 'XADD s * f v'], { norm: streamIds }),
  s('XSETID smaller than top', ['XADD s 5-0 f v', 'XSETID s 4-0', 'XSETID s 5-0', 'XDEL s 5-0']),
  s('XSETID below max deleted id', ['XADD s 5-0 f v', 'XDEL s 5-0', 'XSETID s 3-0', 'XINFO STREAM s']),
  s('XSETID ENTRIESADDED and MAXDELETEDID', ['XADD s 1-0 f v', 'XADD s 2-0 f v', 'XSETID s 5-0 ENTRIESADDED 10 MAXDELETEDID 3-0', 'XINFO STREAM s']),
  s('XSETID option errors', ['XADD s 1-0 f v', 'XADD s 2-0 f v', 'XSETID s 5-0 ENTRIESADDED 1', 'XSETID s 5-0 ENTRIESADDED -1', 'XSETID s 5-0 MAXDELETEDID 6-0', 'XSETID s 5-0 ENTRIESADDED 5 MAXDELETEDID 9-0', 'XSETID s 5-0 FOO 1', 'XSETID s 5-0 ENTRIESADDED', 'XSETID s bad']),
  s('XSETID missing key and wrong type', ['XSETID s 1-0', 'SET k v', 'XSETID k 1-0', 'XSETID s']),
  s('XSETID on empty stream', ['XADD s MAXLEN 0 5-0 f v', 'XSETID s 1-0', 'XSETID s 0-0', 'XINFO STREAM s']),

  // XINFO STREAM
  s('XINFO STREAM summary', ['XADD s 1-0 a 1', 'XADD s 2-0 b 2', 'XADD s 3-0 c 3', 'XDEL s 2-0', 'XINFO STREAM s']),
  s('XINFO STREAM after deleting first entry', [...fill('s', 3), 'XDEL s 1-0', 'XINFO STREAM s', 'XTRIM s MAXLEN 1', 'XINFO STREAM s']),
  s('XINFO STREAM radix tree counters', [...fill('s', 250), 'XINFO STREAM s', 'XTRIM s MAXLEN ~ 120', 'XINFO STREAM s']),
  s('XINFO STREAM FULL empty groups', [...fill('s', 3), 'XINFO STREAM s FULL', 'XINFO STREAM s FULL COUNT 1', 'XINFO STREAM s FULL COUNT 0']),
  s('XINFO STREAM errors', ['XINFO STREAM s', 'SET k v', 'XINFO STREAM k', 'XADD s 1-0 f v', 'XINFO STREAM s FULL COUNT', 'XINFO STREAM s FULL COUNT x', 'XINFO STREAM s FULL COUNT -1', 'XINFO STREAM', 'XINFO', 'XINFO FOO s']),
  s('XINFO STREAM unknown option', ['XADD s 1-0 f v', 'XINFO STREAM s FOO', 'XINFO STREAM s FULL FOO']),
  s('XINFO HELP', ['XINFO HELP'], v('the HELP footer reads "Print this help." in newer Redis (7.0: "Prints this help.")', 'medium')),
  s('XINFO GROUPS on stream without groups', ['XADD s 1-0 f v', 'XINFO GROUPS s', 'XINFO GROUPS missing']),
  s('XINFO STREAM empty after MAXLEN 0', ['XADD s 1-0 f v', 'XADD s 2-0 f v', 'XTRIM s MAXLEN 0', 'XINFO STREAM s', 'XINFO STREAM s FULL']),

  // integer arguments at the int64 and int32 edges (see differential.probes)
  ...intProbes('XADD MAXLEN', ['XADD x 1-1 f v', 'XADD x MAXLEN $N 2-1 f v', 'XADD x MAXLEN ~ 1 LIMIT $N 3-1 f v', 'XLEN x']),
  ...intProbes('XTRIM', ['XADD x 1-1 f v', 'XTRIM x MAXLEN $N', 'XTRIM x MINID ~ 0 LIMIT $N', 'XLEN x']),
  ...intProbes('XRANGE COUNT', ['XADD x 1-1 f v', 'XRANGE x - + COUNT $N', 'XREVRANGE x + - COUNT $N']),
  ...intProbes('XREAD COUNT BLOCK', ['XADD x 1-1 f v', 'XREAD COUNT $N STREAMS x 0', 'XREAD BLOCK $N STREAMS x 0']),
  ...intProbes('XSETID and ENTRIESREAD', ['XADD x 1-1 f v', 'XSETID x 1-1 ENTRIESADDED $N', 'XGROUP CREATE x g 0 ENTRIESREAD $N', 'XGROUP CREATE x g2 0', 'XGROUP SETID x g2 0 ENTRIESREAD $N']),
  ...intProbes('XINFO FULL COUNT', ['XADD x 1-1 f v', 'XINFO STREAM x FULL COUNT $N']),
]);
