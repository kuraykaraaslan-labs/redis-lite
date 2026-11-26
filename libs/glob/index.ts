/**
 * Redis glob matching (KEYS, SCAN MATCH, PSUBSCRIBE, CONFIG GET…), with Redis's exact reading of odd patterns:
 * - `*` any run (consecutive stars are one), `?` any one character, `\x` the character x (a trailing `\` is itself);
 * - `[...]` a set: `^` first negates, `\x` is x, `a-z` a range (reversed bounds are swapped), any other character
 *   itself; a `]` right after `[` (or `[^`) closes an empty set, and a set left open runs to the end of the pattern.
 * Patterns are compiled once into tokens and matched iteratively (backtracking only to the last star), so a hostile
 * pattern costs at most O(pattern × value).
 */

/** One pattern token: a star, any character, a literal character code, or a set of code ranges. */
type Token = { kind: 'star' } | { kind: 'any' } | { kind: 'char'; code: number } | { kind: 'set'; negate: boolean; ranges: number[] };

const cache = new Map<string, Token[]>();
const CACHE_LIMIT = 1000;

/** Reads the set starting after `[` at `i`; returns the token and the index just past it. */
function readSet(pattern: string, i: number): [Token, number] {
  const len = pattern.length;
  const negate = pattern[i] === '^';
  if (negate) i++;
  const ranges: number[] = [];
  while (i < len) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < len) {
      const code = pattern.charCodeAt(i + 1);
      ranges.push(code, code);
      i += 2;
    } else if (c === ']') return [{ kind: 'set', negate, ranges }, i + 1];
    else if (i + 2 < len && pattern[i + 1] === '-') {
      const a = pattern.charCodeAt(i);
      const b = pattern.charCodeAt(i + 2);
      ranges.push(Math.min(a, b), Math.max(a, b));
      i += 3;
    } else {
      const code = pattern.charCodeAt(i);
      ranges.push(code, code);
      i++;
    }
  }
  return [{ kind: 'set', negate, ranges }, len];
}

function compile(pattern: string): Token[] {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; ) {
    const c = pattern[i];
    if (c === '*') {
      if (tokens[tokens.length - 1]?.kind !== 'star') tokens.push({ kind: 'star' });
      i++;
    } else if (c === '?') {
      tokens.push({ kind: 'any' });
      i++;
    } else if (c === '[') {
      const [set, next] = readSet(pattern, i + 1);
      tokens.push(set);
      i = next;
    } else if (c === '\\' && i + 1 < pattern.length) {
      tokens.push({ kind: 'char', code: pattern.charCodeAt(i + 1) });
      i += 2;
    } else {
      tokens.push({ kind: 'char', code: pattern.charCodeAt(i) });
      i++;
    }
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(pattern, tokens);
  return tokens;
}

/** Whether a one-character token accepts `code`. */
function accepts(token: Token, code: number): boolean {
  switch (token.kind) {
    case 'any':
      return true;
    case 'char':
      return token.code === code;
    case 'set': {
      let found = false;
      for (let r = 0; r < token.ranges.length && !found; r += 2) found = code >= token.ranges[r] && code <= token.ranges[r + 1];
      return found !== token.negate;
    }
    default:
      return false;
  }
}

export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const tokens = compile(pattern);
  let t = 0;
  let v = 0;
  let starT = -1;
  let starV = 0;
  while (v < value.length) {
    const token = tokens[t];
    if (token?.kind === 'star') {
      starT = t++;
      starV = v;
    } else if (token && accepts(token, value.charCodeAt(v))) {
      t++;
      v++;
    } else if (starT >= 0) {
      t = starT + 1;
      v = ++starV;
    } else return false;
  }
  while (tokens[t]?.kind === 'star') t++;
  return t === tokens.length;
}
