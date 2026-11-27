import { differential, s } from './differential.harness';

const elements = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');

differential('hyperloglog', [
  // PFADD / PFCOUNT
  s('PFADD and PFCOUNT', ['PFADD h a b c', 'PFADD h a', 'PFADD h d', 'PFCOUNT h', 'PFCOUNT missing', 'PFADD e', 'PFADD e', 'PFCOUNT e', 'TYPE e']),
  s('PFADD raw sparse representation', ['PFADD h a b c foo bar', 'GET h', 'STRLEN h', 'PFADD empty', 'GET empty']),
  s('PFADD many elements exact count', [`PFADD h ${elements('e', 500)}`, 'PFCOUNT h', 'GET h']),
  s('PFADD promotes to dense', [`PFADD h ${elements('x', 2000)}`, `PFADD h ${elements('y', 2000)}`, 'PFCOUNT h', 'STRLEN h', 'PFDEBUG ENCODING h', 'GET h']),
  s('PFADD sparse threshold config', ['CONFIG SET hll-sparse-max-bytes 30', `PFADD h ${elements('z', 30)}`, 'PFDEBUG ENCODING h', 'PFCOUNT h', 'STRLEN h']),
  s('PFCOUNT multiple keys', ['PFADD a 1 2 3', 'PFADD b 3 4 5', 'PFCOUNT a b', 'PFCOUNT a b missing', 'PFCOUNT a a', 'GET a']),
  s('PFCOUNT caches cardinality in the header', ['PFADD h a b c', 'GET h', 'PFCOUNT h', 'GET h', 'PFADD h d', 'GET h']),
  s('PFADD PFCOUNT arity and wrong type', ['PFADD', 'PFCOUNT', 'RPUSH l a', 'PFADD l a', 'PFCOUNT l', 'PFCOUNT l missing']),
  s('PFADD on non-HLL string', ['SET s hello', 'PFADD s a', 'PFCOUNT s', 'PFMERGE d s', 'SET t HYLLxxxxxxxxxxxxxxxxxx', 'PFCOUNT t']),
  s('PFADD binary and empty elements', ['PFADD h "" "\\x00" "\\xff\\xfe"', 'PFCOUNT h', 'GET h']),

  // PFMERGE
  s('PFMERGE', ['PFADD a 1 2 3', 'PFADD b 3 4 5 6', 'PFMERGE d a b', 'PFCOUNT d', 'GET d', 'PFMERGE d', 'PFCOUNT d']),
  s('PFMERGE into existing and missing sources', ['PFADD d x', 'PFMERGE d missing', 'PFCOUNT d', 'PFMERGE n missing', 'EXISTS n', 'GET n', 'PFMERGE n2', 'GET n2']),
  s('PFMERGE dense and sparse', [`PFADD big ${elements('q', 3000)}`, 'PFADD small a b', 'PFMERGE d small big', 'PFCOUNT d', 'PFDEBUG ENCODING d', 'PFMERGE s2 small', 'PFDEBUG ENCODING s2', 'GET s2']),
  s('PFMERGE errors', ['PFMERGE', 'SET s x', 'PFMERGE d s', 'RPUSH l a', 'PFMERGE d l', 'PFMERGE l', 'PFADD h a', 'PFMERGE l h']),

  // PFDEBUG / PFSELFTEST
  s('PFDEBUG GETREG sparse', ['PFADD h a b c', 'PFDEBUG GETREG h', 'PFDEBUG ENCODING h', 'GET h']),
  s('PFDEBUG TODENSE', ['PFADD h a b c', 'PFDEBUG TODENSE h', 'PFDEBUG TODENSE h', 'PFDEBUG ENCODING h', 'PFCOUNT h', 'STRLEN h']),
  s('PFDEBUG DECODE', ['PFADD h a b c', 'PFDEBUG DECODE h', 'PFDEBUG TODENSE h', 'PFDEBUG DECODE h', 'PFADD e', 'PFDEBUG DECODE e']),
  s('PFDEBUG errors', ['PFDEBUG GETREG missing', 'PFDEBUG FOO h', 'PFADD h a', 'PFDEBUG FOO h', 'PFDEBUG', 'PFDEBUG GETREG', 'SET s x', 'PFDEBUG GETREG s', 'RPUSH l a', 'PFDEBUG ENCODING l']),
  s('PFDEBUG with an extra argument', ['PFADD h a', 'PFDEBUG GETREG h x', 'PFDEBUG ENCODING h x']),
  s('PFDEBUG GETREG dense', [`PFADD h ${elements('r', 2000)}`, 'PFDEBUG ENCODING h', 'PFDEBUG GETREG h']),
  // PFSELFTEST runs the full self test on both servers: allow for a loaded machine.
  s('PFSELFTEST', [{ cmd: 'PFSELFTEST', timeout: 150_000 }, 'PFSELFTEST x'], { testTimeout: 330_000 }),

  // corrupted HLLs
  s('corrupted HLL header', ['SET h "HYLL\\x02\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00"', 'PFCOUNT h', 'PFADD h a', 'SET g "HYLX\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00"', 'PFCOUNT g']),
  s('corrupted HLL dense with wrong length', ['SET h "HYLL\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00abc"', 'PFCOUNT h', 'PFADD h a', 'PFMERGE d h']),
  s('corrupted HLL sparse with bad opcodes', ['SET h "HYLL\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x80\\x7f\\xff\\x7f\\xff\\x7f\\xff"', 'PFCOUNT h', 'PFADD h x', 'PFDEBUG GETREG h']),
  s('corrupted HLL sparse too many registers', ['SET h "HYLL\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x80\\x7f\\xff\\x7f\\xff\\x7f\\xff\\x7f\\xff\\x7f\\xff"', 'PFCOUNT h', 'PFMERGE d h']),
  s('HLL valid after SETRANGE on header cache', ['PFADD h a b c', 'PFCOUNT h', 'SETRANGE h 15 "\\x80"', 'PFCOUNT h', 'GET h']),
  s('HLL string too short', ['SET h HYLL', 'PFCOUNT h', 'SET g ""', 'PFADD g a']),
]);
