const globCache = new Map<string, RegExp>();

/** Redis glob (`*`, `?`, `[a-z]`, `[^x]`, `\` escape) as a RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '[\\s\\S]';
    else if (c === '\\' && i + 1 < pattern.length) re += escapeRe(pattern[++i]);
    else if (c === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close < 0) {
        re += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, close);
      let negate = false;
      if (body.startsWith('^')) {
        negate = true;
        body = body.slice(1);
      }
      re += `[${negate ? '^' : ''}${body.replace(/[\]\\]/g, '\\$&')}]`;
      i = close;
    } else re += escapeRe(c);
  }
  const compiled = new RegExp(`${re}$`);
  if (globCache.size > 1000) globCache.clear();
  globCache.set(pattern, compiled);
  return compiled;
}

function escapeRe(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  return globToRegExp(pattern).test(value);
}
