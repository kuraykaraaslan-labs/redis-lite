import { differential, s, v } from './differential.harness';
import type { Step } from './differential.harness';
import { all, msClock, pendingIdle, shape, streamClocks } from './differential.normalizers';
import { intProbes } from './differential.probes';

/** `n` XADD steps with explicit ids `<base + i>-0`. */
function fill(key: string, n: number, base = 1): Step[] {
  return Array.from({ length: n }, (_, i) => `XADD ${key} ${base + i}-0 f ${i}`);
}

/** A stream `s` with entries 1-0..5-0 and a group `g` at 0. */
const base: Step[] = [...fill('s', 5), 'XGROUP CREATE s g 0'];

const clocks = all(streamClocks, msClock);

differential('streams.groups', [
  // XGROUP CREATE / SETID / DESTROY
  s('XGROUP CREATE basics', ['XADD s 1-0 f v', 'XADD s 2-0 f v', 'XGROUP CREATE s g 1-0', 'XGROUP CREATE s g 0', 'XGROUP CREATE s g $', 'XGROUP CREATE s g2 0-0', 'XINFO GROUPS s']),
  s('XGROUP CREATE missing key', ['XGROUP CREATE s g $', 'XGROUP CREATE s g $ MKSTREAM', 'TYPE s', 'XLEN s', 'XINFO STREAM s']),
  s('XGROUP CREATE dollar sets entries-read', ['XGROUP CREATE e g $ MKSTREAM', 'XINFO GROUPS e', 'XADD s 1-0 f v', 'XGROUP CREATE s g $', 'XINFO GROUPS s'], v('XGROUP CREATE with $ reports entries-read = entries-added instead of nil (changed after 7.0)', 'medium')),
  s('entries-read after CREATE and SETID', ['XADD s 1-0 f v', 'XGROUP CREATE s g2 $', 'XGROUP CREATE s g3 1-0', 'XGROUP CREATE s g4 0', 'XGROUP CREATE s g5 $ ENTRIESREAD 3', 'XINFO GROUPS s', 'XGROUP SETID s g4 $', 'XADD s 2-0 f v', 'XINFO GROUPS s', 'XREADGROUP GROUP g2 x STREAMS s >', 'XDEL s 1-0', 'XINFO GROUPS s']),
  s('XCLAIM and XAUTOCLAIM consumer creation', ['XADD s 1-0 f v', 'XGROUP CREATE s g 0', 'XCLAIM s g c1 0 5-0', 'XAUTOCLAIM s g c2 0 0', 'XINFO CONSUMERS s g', 'XREADGROUP GROUP g c3 STREAMS s >', 'XCLAIM s g c4 0 1-0 JUSTID', 'XAUTOCLAIM s g c5 0 0 JUSTID', 'XPENDING s g - + 10 c9', 'XINFO CONSUMERS s g'], { norm: clocks }),
  s('stream keyevent notifications', ['CONFIG SET notify-keyspace-events Etg', 'PSUBSCRIBE __keyevent@0__:*', { c: 1, cmd: 'XADD s 1-0 f v' }, { c: 1, cmd: 'XGROUP CREATE s g 0' }, { c: 1, cmd: 'XGROUP CREATE s2 g $ MKSTREAM' }, { c: 1, cmd: 'XREADGROUP GROUP g c1 STREAMS s >' }, { c: 1, cmd: 'XGROUP CREATECONSUMER s g c2' }, { c: 1, cmd: 'XCLAIM s g c3 0 1-0' }, { c: 1, cmd: 'XAUTOCLAIM s g c4 0 0' }, { c: 1, cmd: 'XGROUP SETID s g 0' }, { c: 1, cmd: 'XGROUP DELCONSUMER s g c2' }, { c: 1, cmd: 'XSETID s 5-0' }, { c: 1, cmd: 'XADD s 6-0 f v' }, { c: 1, cmd: 'XTRIM s MAXLEN 1' }, { c: 1, cmd: 'XDEL s 6-0' }, { c: 1, cmd: 'XGROUP DESTROY s g' }, { c: 1, cmd: 'DEL s' }, { read: 16, timeout: 1000 }]),
  s('XGROUP CREATE ENTRIESREAD', [...fill('s', 5), 'XGROUP CREATE s g 2-0 ENTRIESREAD 2', 'XGROUP CREATE s g2 0 ENTRIESREAD 0', 'XGROUP CREATE s g3 $ ENTRIESREAD 5', 'XINFO GROUPS s']),
  s('XGROUP CREATE ENTRIESREAD errors', ['XADD s 1-0 f v', 'XGROUP CREATE s g 0 ENTRIESREAD -5', 'XGROUP CREATE s g 0 ENTRIESREAD x', 'XGROUP CREATE s g 0 ENTRIESREAD', 'XGROUP CREATE s g 0 ENTRIESREAD 99', 'XGROUP CREATE s g 0 FOO', 'XINFO GROUPS s']),
  s('XGROUP CREATE invalid id and wrong type', ['XADD s 1-0 f v', 'XGROUP CREATE s g bad', 'XGROUP CREATE s g >', 'SET k v', 'XGROUP CREATE k g $', 'XGROUP CREATE k g $ MKSTREAM']),
  s('XGROUP CREATE with future id', ['XADD s 1-0 f v', 'XGROUP CREATE s g 9-0', 'XINFO GROUPS s', 'XREADGROUP GROUP g c STREAMS s >']),
  s('XGROUP arity and unknown subcommand', ['XGROUP', 'XGROUP CREATE s', 'XGROUP CREATE s g', 'XGROUP FOO s g', 'XGROUP DESTROY s', 'XGROUP SETID s g', 'XGROUP CREATECONSUMER s g', 'XGROUP DELCONSUMER s g']),
  s('XGROUP HELP', ['XGROUP HELP'], v('the HELP footer reads "Print this help." in newer Redis (7.0: "Prints this help.")', 'medium')),
  s('XGROUP SETID', [...base, 'XREADGROUP GROUP g c STREAMS s >', 'XGROUP SETID s g 2-0', 'XINFO GROUPS s', 'XGROUP SETID s g $', 'XINFO GROUPS s', 'XGROUP SETID s g 0 ENTRIESREAD 1', 'XINFO GROUPS s']),
  s('XGROUP SETID errors', [...base, 'XGROUP SETID s nog 0', 'XGROUP SETID missing g 0', 'XGROUP SETID s g bad', 'XGROUP SETID s g 0 ENTRIESREAD -3', 'XGROUP SETID s g 0 FOO 1', 'XGROUP SETID s g 0 MKSTREAM']),
  s('XGROUP DESTROY', [...base, 'XGROUP DESTROY s g', 'XGROUP DESTROY s g', 'XGROUP DESTROY missing g', 'XINFO GROUPS s']),
  s('XGROUP CREATECONSUMER and DELCONSUMER', [...base, 'XGROUP CREATECONSUMER s g c1', 'XGROUP CREATECONSUMER s g c1', 'XREADGROUP GROUP g c1 COUNT 2 STREAMS s >', 'XGROUP DELCONSUMER s g c1', 'XGROUP DELCONSUMER s g c1', 'XGROUP DELCONSUMER s g nobody', 'XPENDING s g']),
  s('XGROUP consumer commands on missing group', ['XADD s 1-0 f v', 'XGROUP CREATECONSUMER s g c', 'XGROUP DELCONSUMER s g c', 'XGROUP CREATECONSUMER missing g c']),
  s('XGROUP wrong type', ['SET k v', 'XGROUP DESTROY k g', 'XGROUP SETID k g 0', 'XGROUP CREATECONSUMER k g c']),

  // XREADGROUP
  s('XREADGROUP new entries', [...base, 'XREADGROUP GROUP g c COUNT 2 STREAMS s >', 'XREADGROUP GROUP g c STREAMS s >', 'XREADGROUP GROUP g c STREAMS s >']),
  s('XREADGROUP history with explicit id', [...base, 'XREADGROUP GROUP g c COUNT 3 STREAMS s >', 'XREADGROUP GROUP g c STREAMS s 0', 'XREADGROUP GROUP g c STREAMS s 2-0', 'XREADGROUP GROUP g c COUNT 1 STREAMS s 0', 'XREADGROUP GROUP g other STREAMS s 0']),
  s('XREADGROUP history shows deleted entries as nil', [...base, 'XREADGROUP GROUP g c COUNT 3 STREAMS s >', 'XDEL s 2-0', 'XREADGROUP GROUP g c STREAMS s 0']),
  s('XREADGROUP NOACK', [...base, 'XREADGROUP GROUP g c NOACK COUNT 2 STREAMS s >', 'XPENDING s g', 'XREADGROUP GROUP g c STREAMS s 0']),
  s('XREADGROUP errors', [...base, 'XREADGROUP GROUP g c STREAMS s $', 'XREADGROUP GROUP nog c STREAMS s >', 'XREADGROUP GROUP g c STREAMS missing >', 'XREADGROUP STREAMS s >', 'XREADGROUP GROUP g STREAMS s >', 'XREADGROUP GROUP g c STREAMS s', 'XREADGROUP GROUP g c COUNT x STREAMS s >', 'XREADGROUP GROUP g c STREAMS s bad', 'XREADGROUP GROUP g c FOO STREAMS s >']),
  s('XREADGROUP wrong type', ['SET k v', 'XREADGROUP GROUP g c STREAMS k >']),
  s('XREADGROUP two streams', [...base, ...fill('t', 2), 'XGROUP CREATE t g 0', 'XREADGROUP GROUP g c COUNT 1 STREAMS s t > >', 'XREADGROUP GROUP g c STREAMS s t 0 0']),
  s('XREADGROUP updates entries-read and lag', [...base, 'XREADGROUP GROUP g c COUNT 2 STREAMS s >', 'XINFO GROUPS s', 'XDEL s 4-0', 'XINFO GROUPS s', 'XREADGROUP GROUP g c STREAMS s >', 'XINFO GROUPS s']),
  s('XREADGROUP BLOCK wakes on XADD', [...base, 'XREADGROUP GROUP g c STREAMS s >', { c: 1, cmd: 'XREADGROUP GROUP g c2 BLOCK 0 STREAMS s >', wait: false }, { blocked: 1 }, 'XADD s 9-0 x y', { c: 1, read: 1 }, 'XPENDING s g']),
  s('XREADGROUP BLOCK timeout', [...base, 'XREADGROUP GROUP g c STREAMS s >', { cmd: 'XREADGROUP GROUP g c BLOCK 50 STREAMS s >', timeout: 2000 }]),
  s('XREADGROUP BLOCK with history id is immediate', [...base, 'XREADGROUP GROUP g c COUNT 1 STREAMS s >', 'XREADGROUP GROUP g c BLOCK 0 STREAMS s 0']),
  s('XREADGROUP BLOCK then group destroyed', [...base, 'XREADGROUP GROUP g c STREAMS s >', { c: 1, cmd: 'XREADGROUP GROUP g c BLOCK 0 STREAMS s >', wait: false }, { blocked: 1 }, 'XGROUP DESTROY s g', { c: 1, read: 1 }]),
  s('XREADGROUP BLOCK then key deleted', [...base, 'XREADGROUP GROUP g c STREAMS s >', { c: 1, cmd: 'XREADGROUP GROUP g c BLOCK 0 STREAMS s >', wait: false }, { blocked: 1 }, 'DEL s', { c: 1, read: 1 }]),
  s('XREADGROUP creates consumer', [...base, 'XREADGROUP GROUP g c1 COUNT 0 STREAMS s >', 'XINFO CONSUMERS s g'], { norm: clocks, ...v('XINFO CONSUMERS gained the inactive field in 7.2', 'high') }),

  // XACK / XPENDING
  s('XACK', [...base, 'XREADGROUP GROUP g c STREAMS s >', 'XACK s g 1-0 2-0 9-0', 'XACK s g 1-0', 'XACK s nog 3-0', 'XACK missing g 1-0', 'XPENDING s g']),
  s('XACK errors', [...base, 'XACK s g', 'XACK s g bad', 'XACK s g 1-0 bad', 'SET k v', 'XACK k g 1-0']),
  s('XPENDING summary', [...base, 'XPENDING s g', 'XREADGROUP GROUP g a COUNT 2 STREAMS s >', 'XREADGROUP GROUP g b COUNT 2 STREAMS s >', 'XPENDING s g']),
  s('XPENDING extended form', [...base, 'XREADGROUP GROUP g a COUNT 2 STREAMS s >', 'XREADGROUP GROUP g b STREAMS s >', 'XPENDING s g - + 10', 'XPENDING s g - + 2', 'XPENDING s g - + 10 b', 'XPENDING s g (1-0 (5-0 10', 'XPENDING s g - + 10 nobody', 'XPENDING s g - + 0'], { norm: pendingIdle }),
  s('XPENDING delivery counts', [...base, 'XREADGROUP GROUP g a COUNT 2 STREAMS s >', 'XREADGROUP GROUP g a STREAMS s 0', 'XREADGROUP GROUP g a STREAMS s 0', 'XPENDING s g - + 10'], { norm: pendingIdle }),
  s('XPENDING IDLE filter', [...base, 'XREADGROUP GROUP g a COUNT 2 STREAMS s >', { sleep: 120 }, 'XREADGROUP GROUP g b STREAMS s >', 'XPENDING s g IDLE 100 - + 10', 'XPENDING s g IDLE 100000 - + 10', 'XPENDING s g IDLE 0 - + 10 b'], { norm: pendingIdle }),
  s('XPENDING errors', [...base, 'XPENDING s nog', 'XPENDING missing g', 'XPENDING s g -', 'XPENDING s g - +', 'XPENDING s g - + x', 'XPENDING s g - + -1', 'XPENDING s g IDLE x - + 10', 'XPENDING s g IDLE', 'XPENDING s g bad + 10', 'XPENDING s g - + 10 c extra', 'XPENDING s', 'SET k v', 'XPENDING k g']),

  // XCLAIM
  s('XCLAIM basic', [...base, 'XREADGROUP GROUP g a STREAMS s >', 'XCLAIM s g b 0 1-0 2-0 9-0', 'XPENDING s g - + 10'], { norm: pendingIdle }),
  s('XCLAIM min idle not reached', [...base, 'XREADGROUP GROUP g a STREAMS s >', 'XCLAIM s g b 3600000 1-0', 'XPENDING s g - + 1'], { norm: pendingIdle }),
  s('XCLAIM JUSTID does not bump count', [...base, 'XREADGROUP GROUP g a STREAMS s >', 'XCLAIM s g b 0 1-0 2-0 JUSTID', 'XPENDING s g - + 2'], { norm: pendingIdle }),
  s('XCLAIM FORCE and RETRYCOUNT', [...base, 'XCLAIM s g b 0 3-0 JUSTID', 'XCLAIM s g b 0 3-0 FORCE RETRYCOUNT 7', 'XPENDING s g - + 10', 'XCLAIM s g b 0 99-0 FORCE'], { norm: pendingIdle }),
  s('XCLAIM IDLE and TIME options', [...base, 'XREADGROUP GROUP g a STREAMS s >', 'XCLAIM s g b 0 1-0 IDLE 5000 JUSTID', 'XPENDING s g IDLE 4000 - + 10', 'XCLAIM s g b 0 2-0 TIME 1 JUSTID', 'XPENDING s g IDLE 100000 - + 10'], { norm: pendingIdle }),
  s('XCLAIM LASTID moves group id', [...base, 'XREADGROUP GROUP g a COUNT 1 STREAMS s >', 'XCLAIM s g b 0 1-0 LASTID 4-0 JUSTID', 'XINFO GROUPS s', 'XCLAIM s g b 0 1-0 LASTID 2-0 JUSTID', 'XINFO GROUPS s']),
  s('XCLAIM deleted entry removed from PEL', [...base, 'XREADGROUP GROUP g a STREAMS s >', 'XDEL s 2-0', 'XCLAIM s g b 0 1-0 2-0', 'XPENDING s g']),
  s('XCLAIM errors', [...base, 'XCLAIM s g b', 'XCLAIM s g b 0', 'XCLAIM s g b x 1-0', 'XCLAIM s g b -1 1-0', 'XCLAIM s nog b 0 1-0', 'XCLAIM missing g b 0 1-0', 'XCLAIM s g b 0 bad', 'XCLAIM s g b 0 1-0 IDLE x', 'XCLAIM s g b 0 1-0 RETRYCOUNT -1', 'XCLAIM s g b 0 1-0 LASTID bad', 'XCLAIM s g b 0 1-0 FOO', 'XCLAIM s g b 0 1-0 TIME', 'SET k v', 'XCLAIM k g b 0 1-0']),

  // XAUTOCLAIM
  s('XAUTOCLAIM basic', [...base, 'XREADGROUP GROUP g a STREAMS s >', 'XAUTOCLAIM s g b 0 0-0 COUNT 2', 'XAUTOCLAIM s g b 0 0-0 COUNT 2 JUSTID', 'XAUTOCLAIM s g b 0 (3-0', 'XAUTOCLAIM s g b 0 5-0 COUNT 10']),
  s('XAUTOCLAIM reports deleted ids', [...base, 'XREADGROUP GROUP g a STREAMS s >', 'XDEL s 2-0 4-0', 'XAUTOCLAIM s g b 0 0', 'XPENDING s g']),
  s('XAUTOCLAIM min idle not reached', [...base, 'XREADGROUP GROUP g a STREAMS s >', 'XAUTOCLAIM s g b 3600000 0']),
  s('XAUTOCLAIM empty group', [...base, 'XAUTOCLAIM s g b 0 0', 'XINFO CONSUMERS s g'], { norm: clocks }),
  s('XAUTOCLAIM errors', [...base, 'XAUTOCLAIM s g b 0', 'XAUTOCLAIM s g b x 0', 'XAUTOCLAIM s g b 0 bad', 'XAUTOCLAIM s g b 0 0 COUNT 0', 'XAUTOCLAIM s g b 0 0 COUNT -1', 'XAUTOCLAIM s g b 0 0 COUNT x', 'XAUTOCLAIM s g b 0 0 FOO', 'XAUTOCLAIM s nog b 0 0', 'XAUTOCLAIM missing g b 0 0', 'XAUTOCLAIM s g b 0 0 COUNT 99999999999', 'SET k v', 'XAUTOCLAIM k g b 0 0']),

  // XINFO GROUPS / CONSUMERS / STREAM FULL
  s('XINFO GROUPS fields', [...base, 'XGROUP CREATE s g2 3-0', 'XREADGROUP GROUP g a COUNT 2 STREAMS s >', 'XINFO GROUPS s']),
  s('XINFO GROUPS lag unknown after deletion in range', [...base, 'XREADGROUP GROUP g a COUNT 1 STREAMS s >', 'XDEL s 3-0', 'XINFO GROUPS s', 'XGROUP CREATE s g2 2-0', 'XINFO GROUPS s']),
  s('XINFO GROUPS errors', ['XINFO GROUPS s', 'SET k v', 'XINFO GROUPS k', 'XINFO GROUPS', 'XINFO GROUPS s extra']),
  s('XINFO CONSUMERS', [...base, 'XREADGROUP GROUP g a COUNT 2 STREAMS s >', 'XGROUP CREATECONSUMER s g b', 'XINFO CONSUMERS s g'], { norm: clocks, ...v('XINFO CONSUMERS gained the inactive field in 7.2', 'high') }),
  s('XINFO CONSUMERS inactive field', [...base, 'XGROUP CREATECONSUMER s g b', 'XINFO CONSUMERS s g'], { norm: clocks, ...v('XINFO CONSUMERS gained the inactive field in 7.2', 'high') }),
  s('XINFO CONSUMERS errors', ['XINFO CONSUMERS s g', 'XADD s 1-0 f v', 'XINFO CONSUMERS s g', 'XINFO CONSUMERS s', 'SET k v', 'XINFO CONSUMERS k g']),
  s('XINFO STREAM with groups', [...base, 'XREADGROUP GROUP g a COUNT 2 STREAMS s >', 'XINFO STREAM s']),
  s('XINFO STREAM FULL with groups', [...base, 'XREADGROUP GROUP g a COUNT 2 STREAMS s >', 'XGROUP CREATECONSUMER s g b', 'XINFO STREAM s FULL'], { norm: clocks, ...v('XINFO STREAM FULL consumers gained active-time in 7.2', 'high') }),
  s('XINFO STREAM FULL COUNT limits PEL', [...base, 'XREADGROUP GROUP g a STREAMS s >', 'XINFO STREAM s FULL COUNT 2'], { norm: clocks, ...v('XINFO STREAM FULL consumers gained active-time in 7.2', 'high') }),

  // integer arguments at the int64 and int32 edges (see differential.probes)
  ...intProbes('XREADGROUP COUNT', ['XADD x 1-1 f v', 'XGROUP CREATE x g 0', 'XREADGROUP GROUP g c COUNT $N STREAMS x >', 'XREADGROUP GROUP g c BLOCK $N STREAMS x 0']),
  ...intProbes('XPENDING', ['XADD x 1-1 f v', 'XGROUP CREATE x g 0', 'XREADGROUP GROUP g c STREAMS x >', { cmd: 'XPENDING x g - + $N', norm: pendingIdle }, { cmd: 'XPENDING x g IDLE $N - + 10', norm: shape }]),
  ...intProbes('XCLAIM', ['XADD x 1-1 f v', 'XGROUP CREATE x g 0', 'XREADGROUP GROUP g c STREAMS x >', 'XCLAIM x g c $N 1-1', 'XCLAIM x g c 0 1-1 IDLE $N JUSTID', 'XCLAIM x g c 0 1-1 TIME $N JUSTID', 'XCLAIM x g c 0 1-1 RETRYCOUNT $N JUSTID']),
  ...intProbes('XAUTOCLAIM', ['XADD x 1-1 f v', 'XGROUP CREATE x g 0', 'XREADGROUP GROUP g c STREAMS x >', 'XAUTOCLAIM x g c $N 0 JUSTID', 'XAUTOCLAIM x g c 0 0 COUNT $N JUSTID']),
]);
