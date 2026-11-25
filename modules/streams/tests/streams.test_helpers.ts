import { expect } from 'vitest';

import type { RawClient } from '@/tests/helpers';

/** Shared assertions and RESP builders of the streams suites (expected texts written out: the tests are the oracle). */

/** Resolves to the error message of a rejected call, or 'NO ERROR'. */
export async function err(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'NO ERROR';
}

export const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

export const arity = (cmd: string) => `ERR wrong number of arguments for '${cmd}' command`;

export const INVALID_ID = 'ERR Invalid stream ID specified as stream command argument';

export const NOT_INT = 'ERR value is not an integer or out of range';

// RESP builders (latin1 lengths, matching RawClient).
export const bulk = (s: string) => `$${Buffer.byteLength(s, 'latin1')}\r\n${s}\r\n`;

export const arr = (...items: string[]) => `*${items.length}\r\n${items.join('')}`;

export const entry = (id: string, ...fv: string[]) => arr(bulk(id), arr(...fv.map(bulk)));

/** A raw client switched to RESP3. */
export async function openResp3(server: { raw(): Promise<RawClient> }): Promise<RawClient> {
  const c = await server.raw();
  await c.send('HELLO', '3');
  return c;
}

/** Asserts that `keys` appear in `flat` (a flat field/value list) in this relative order. */
export function expectOrderedFields(flat: unknown[], keys: string[]): void {
  const names = flat.filter((_, i) => i % 2 === 0) as string[];
  const positions = keys.map((k) => names.indexOf(k));
  for (const [i, p] of positions.entries()) expect(p, `field ${keys[i]}`).toBeGreaterThanOrEqual(0);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
}

export function toMap(flat: unknown[]): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (let i = 0; i < flat.length; i += 2) m[String(flat[i])] = flat[i + 1];
  return m;
}
