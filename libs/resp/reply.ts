/**
 * RESP reply values: what command handlers return and the encoder turns into bytes (RESP2 or RESP3).
 *
 * Every Redis string is kept as a "binary string": a JS string where each char is one byte (latin1). That keeps keys and
 * values byte-exact (msgpack payloads, UTF-8 text, anything) while still letting us use them as Map keys.
 */

import { formatG17 } from '@/libs/number';

export class Status {
  constructor(readonly value: string) {}
}

export class RespError {
  /** `counted`: already counted in INFO errorstats (a script's error that a redis.call counted when it failed). */
  constructor(
    readonly message: string,
    readonly counted = false,
  ) {}
}

/** RESP3 map (`%`); RESP2 sends it as a flat array of key, value, key, value… */
export class RespMap {
  /** `nestedInResp2`: RESP2 gets [[k, v], …] instead of a flat array (XREAD, XREADGROUP). */
  constructor(
    readonly entries: Array<[Reply, Reply]>,
    readonly nestedInResp2 = false,
  ) {}

  static from(flat: Reply[]): RespMap {
    const entries: Array<[Reply, Reply]> = [];
    for (let i = 0; i + 1 < flat.length; i += 2)
      entries.push([flat[i], flat[i + 1]]);
    return new RespMap(entries);
  }
}

/** RESP3 set (`~`); RESP2 sends it as an array. */
export class RespSet {
  constructor(readonly items: Reply[]) {}
}

/** RESP3 double (`,`); RESP2 sends it as a bulk string. */
export class RespDouble {
  /** `text` overrides the default formatting (GEOPOS prints 17 decimals). */
  constructor(
    readonly value: number,
    readonly text?: string,
  ) {}
}

/** RESP3 out-of-band push (`>`): pub/sub messages, invalidations. RESP2 sends it as an array. */
export class RespPush {
  constructor(readonly items: Reply[]) {}
}

/** RESP3 verbatim string (`=`, e.g. INFO); RESP2 sends a bulk string. */
export class RespVerbatim {
  constructor(
    readonly text: string,
    readonly format = 'txt',
  ) {}
}

/** RESP3 boolean (`#`); RESP2 sends integer 1 / 0. */
export class RespBool {
  constructor(readonly value: boolean) {}
}

/** RESP3 big number (`(`); RESP2 sends a bulk string. */
export class RespBigNumber {
  constructor(readonly value: bigint) {}
}

/** A list of pairs: RESP2 flattens it (a, b, a, b…), RESP3 nests it ([a, b], [a, b]…). ZRANGE WITHSCORES, HRANDFIELD WITHVALUES. */
export class RespPairs {
  constructor(readonly pairs: Array<[Reply, Reply]>) {}
}

/** RESP2 null array (`*-1`): the timeout reply of blocking commands and an aborted EXEC. RESP3 sends `_`. */
export const NULL_ARRAY = Symbol('NULL_ARRAY');

export type Reply =
  | string
  | number
  | bigint
  | null
  | Status
  | RespError
  | RespMap
  | RespSet
  | RespDouble
  | RespPush
  | RespVerbatim
  | RespBool
  | RespBigNumber
  | RespPairs
  | typeof NULL_ARRAY
  | Reply[];

export const OK = new Status('OK');
export const QUEUED = new Status('QUEUED');
export const PONG = new Status('PONG');

export type Protocol = 2 | 3;

/** Doubles as Redis 7.0 prints them: C `%.17g` (17 significant digits, trailing zeros dropped), inf / -inf / nan. */
export function formatDouble(n: number): string {
  return formatG17(n);
}
