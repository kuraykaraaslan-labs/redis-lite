/**
 * redis.conf reading for the CLI, following the syntax the self-documented redis.conf describes: one directive per
 * line (`name value ...`), `#` comments, arguments quoted like on the redis-cli command line ("double quotes" with
 * escapes, 'single quotes'), `include <path>` to pull in another file, and repeated `save` lines adding save points
 * (`save ""` clears them).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { readFileSync } from 'node:fs';

import { REDIS_VERSION } from '@/modules/connection/connection.commands';
import { splitArgs } from '@/modules/persistence/persistence.core';

export interface ConfDirective {
  name: string;
  args: string[];
  file: string;
  line: number;
  text: string;
}

/** The fatal error Redis prints for a bad configuration line. */
export function configFileError(d: Pick<ConfDirective, 'line' | 'text'>, reason: string): Error {
  return new Error(
    `\n*** FATAL CONFIG FILE ERROR (Redis ${REDIS_VERSION}) ***\nReading the configuration file, at line ${d.line}\n>>> '${d.text}'\n${reason}`,
  );
}

/** Every directive of a config file, `include`s expanded in place (paths relative to the working directory). */
export function readConfigFile(path: string, depth = 0): ConfDirective[] {
  if (depth > 16) throw new Error(`Fatal error, too many nested includes reading '${path}'`);
  let text: string;
  try {
    text = readFileSync(path, 'latin1');
  } catch (e) {
    throw new Error(`Fatal error, can't open config file '${path}': ${(e as Error).message}`);
  }
  const out: ConfDirective[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const args = splitArgs(line);
    const d = { file: path, line: i + 1, text: line };
    if (!args) throw configFileError(d, 'Unbalanced quotes in configuration line');
    if (!args.length) return;
    const name = args[0].toLowerCase();
    if (name === 'include') {
      if (args.length !== 2) throw configFileError(d, 'Bad directive or wrong number of arguments');
      out.push(...readConfigFile(args[1], depth + 1));
      return;
    }
    out.push({ ...d, name, args: args.slice(1) });
  });
  return out;
}

/**
 * Folds directives into config values: the last occurrence wins, except `save`, whose lines accumulate (an empty
 * `save ""` resets the list). `known(name)` tells whether a directive is a config this server has; unknown ones are
 * returned separately so the caller can report them.
 */
export function foldDirectives(
  directives: readonly ConfDirective[],
  known: (name: string) => boolean,
): { values: Map<string, string>; unknown: ConfDirective[] } {
  const values = new Map<string, string>();
  const unknown: ConfDirective[] = [];
  for (const d of directives) {
    if (!known(d.name)) {
      unknown.push(d);
      continue;
    }
    if (!d.args.length) throw configFileError(d, 'Bad directive or wrong number of arguments');
    const value = d.args.join(' ');
    if (d.name === 'save') {
      if (d.args.length === 1 && d.args[0] === '') values.set('save', '');
      else {
        const prev = values.get('save');
        values.set('save', prev ? `${prev} ${value}` : value);
      }
    } else values.set(d.name, value);
  }
  return { values, unknown };
}
