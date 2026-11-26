import { AppError } from '@/libs/app-error';
import { addInt64 } from '@/libs/number';
import { addLongDouble, formatLongDouble, parseLongDouble } from '@/libs/number/long-double';
import { OK, RespMap } from '@/libs/resp';
import type { Status } from '@/libs/resp';
import { RespMessages } from '@/libs/resp/messages';

import type { CommandContext } from '@/modules/command/command.types';

import type { HIncrByFloatInput, HIncrByInput, HSetInput, HSetNxInput, KeyFieldInput, KeyFieldsInput, KeyInput } from './hashes.dto';
import HashesMessages from './hashes.messages';
import HashStore from './hashes.structure';

const ZERO = { neg: false, m: 0n, e: 0 };

/** Fields and values: HSET, HMSET, HSETNX, HGET, HMGET, HGETALL, HDEL, HEXISTS, HLEN, HKEYS, HVALS, HSTRLEN, HINCRBY*. */
export default class HashesFieldService {
  // ──────────────────────────────────────────────
  // Writes
  // ──────────────────────────────────────────────

  /** HSET: the number of new fields. Setting a field clears its TTL. */
  static hSet(ctx: CommandContext, { key, pairs }: HSetInput): number {
    const h = HashStore.readForWrite(ctx, key);
    let added = 0;
    for (const [field, value] of pairs) {
      if (!h.has(field)) added++;
      h.set(field, value);
      HashStore.clearFieldTtl(h, field);
    }
    return added;
  }

  /** HMSET: HSET answering OK. */
  static hMSet(ctx: CommandContext, input: HSetInput): Status {
    HashesFieldService.hSet(ctx, input);
    return OK;
  }

  static hSetNx(ctx: CommandContext, { key, field, value }: HSetNxInput): number {
    const h = HashStore.readForWrite(ctx, key);
    if (h.has(field)) return 0;
    h.set(field, value);
    return 1;
  }

  /** HDEL: the number of fields removed; the key goes with its last field. */
  static hDel(ctx: CommandContext, { key, fields }: KeyFieldsInput): number {
    const h = HashStore.read(ctx, key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) {
      if (h.delete(f)) n++;
      HashStore.clearFieldTtl(h, f);
    }
    ctx.db.removeIfEmpty(key);
    return n;
  }

  static hIncrBy(ctx: CommandContext, { key, field, delta }: HIncrByInput): number | bigint {
    const h = HashStore.readForWrite(ctx, key);
    const result = addInt64(h.get(field), delta);
    if (result === 'not-integer') throw new AppError(HashesMessages.HASH_NOT_INTEGER);
    if (result === 'overflow') throw new AppError(RespMessages.INCR_OVERFLOW);
    h.set(field, String(result));
    return result;
  }

  /** Like Redis, the sum is computed in 80-bit long double precision and stored as `%.17Lf` text. */
  static hIncrByFloat(ctx: CommandContext, { key, field, increment }: HIncrByFloatInput): string {
    const h = HashStore.readForWrite(ctx, key);
    const cur = h.get(field);
    const base = cur === undefined ? ZERO : parseLongDouble(cur);
    if (base === null) throw new AppError(HashesMessages.HASH_NOT_FLOAT);
    const result = addLongDouble(base, increment);
    if (result === null || result.inf) throw new AppError(RespMessages.NAN_OR_INF);
    const text = formatLongDouble(result);
    h.set(field, text);
    return text;
  }

  // ──────────────────────────────────────────────
  // Reads
  // ──────────────────────────────────────────────

  static hGet(ctx: CommandContext, { key, field }: KeyFieldInput): string | null {
    return HashStore.read(ctx, key)?.get(field) ?? null;
  }

  static hMGet(ctx: CommandContext, { key, fields }: KeyFieldsInput): Array<string | null> {
    const h = HashStore.read(ctx, key);
    return fields.map((f) => h?.get(f) ?? null);
  }

  /** HGETALL: a map in RESP3, a flat field/value array in RESP2. */
  static hGetAll(ctx: CommandContext, { key }: KeyInput): RespMap {
    return new RespMap([...(HashStore.read(ctx, key) ?? [])]);
  }

  static hExists(ctx: CommandContext, { key, field }: KeyFieldInput): number {
    return HashStore.read(ctx, key)?.has(field) ? 1 : 0;
  }

  static hLen(ctx: CommandContext, { key }: KeyInput): number {
    return HashStore.read(ctx, key)?.size ?? 0;
  }

  static hKeys(ctx: CommandContext, { key }: KeyInput): string[] {
    return [...(HashStore.read(ctx, key)?.keys() ?? [])];
  }

  static hVals(ctx: CommandContext, { key }: KeyInput): string[] {
    return [...(HashStore.read(ctx, key)?.values() ?? [])];
  }

  static hStrLen(ctx: CommandContext, { key, field }: KeyFieldInput): number {
    return HashStore.read(ctx, key)?.get(field)?.length ?? 0;
  }
}
