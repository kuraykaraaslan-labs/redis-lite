import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { RespMessages } from '@/libs/resp/messages';
import { Int64Schema, KeySchema, ScanCursorSchema, ValueSchema, firstIssue, reject } from '@/libs/schemas';
import { KeyScanOptionsSchema } from '@/libs/schemas/key-scan';
import { LongDoubleSchema } from '@/libs/schemas/long-double';
import { RandomCountMessages, RandomCountSchema, isPairCountInRange } from '@/libs/schemas/random-count';

import HashesMessages from './hashes.messages';

/**
 * Argument grammar of the hash commands. Each DTO parses the arguments after the command name (`args`), in command
 * order, so the first issue is the error Redis reports first. Checks that need the stored hash stay in the services.
 */

// ============================================================================
// Shared Grammar
// ============================================================================

const KeyDTO = z.tuple([KeySchema]).transform(([key]) => ({ key }));

const KeyFieldDTO = z.tuple([KeySchema, z.string()]).transform(([key, field]) => ({ key, field }));

const KeyFieldsDTO = z.tuple([KeySchema], z.string()).transform(([key, ...fields]) => ({ key, fields }));

// ============================================================================
// Field DTOs: HSET, HMSET, HSETNX, HGET, HMGET, HGETALL, HDEL, HEXISTS, HLEN, HKEYS, HVALS, HSTRLEN, HINCRBY*
// ============================================================================

/** `key field value [field value …]`; a missing or odd pair is an arity error naming the command (HSET, HMSET). */
function HSetDTO(command: string) {
  const arity = formatMessage(RespMessages.WRONG_ARITY, { command });
  return z.array(z.string()).transform((args, ctx) => {
    if (args.length < 3 || args.length % 2 === 0) return reject(ctx, arity);
    const pairs: Array<[field: string, value: string]> = [];
    for (let i = 1; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
    return { key: args[0], pairs };
  });
}

export const HSetCmdDTO = HSetDTO('hset');
export const HMSetDTO = HSetDTO('hmset');

export const HSetNxDTO = z
  .tuple([KeySchema, z.string(), ValueSchema])
  .transform(([key, field, value]) => ({ key, field, value }));

export const HGetDTO = KeyFieldDTO;
export const HMGetDTO = KeyFieldsDTO;
export const HGetAllDTO = KeyDTO;
export const HDelDTO = KeyFieldsDTO;
export const HExistsDTO = KeyFieldDTO;
export const HLenDTO = KeyDTO;
export const HKeysDTO = KeyDTO;
export const HValsDTO = KeyDTO;
export const HStrLenDTO = KeyFieldDTO;

export const HIncrByDTO = z
  .tuple([KeySchema, z.string(), Int64Schema])
  .transform(([key, field, delta]) => ({ key, field, delta }));

/** HINCRBYFLOAT key field increment: a long double; an infinite increment is refused before the key is read. */
export const HIncrByFloatDTO = z
  .tuple([KeySchema, z.string(), LongDoubleSchema.refine((x) => !x.inf, { error: HashesMessages.INCREMENT_NAN_OR_INF })])
  .transform(([key, field, increment]) => ({ key, field, increment }));

// ============================================================================
// Iteration DTOs: HSCAN, HRANDFIELD
// ============================================================================

/** HSCAN key cursor …: the cursor alone, checked before the key is read. */
export const HScanCursorDTO = z.tuple([KeySchema, ScanCursorSchema], z.string()).transform(([key, cursor]) => ({ key, cursor }));

const HScanOptionsSchema = KeyScanOptionsSchema();

/** HSCAN key cursor [MATCH pattern] [COUNT n], parsed once the key is known to hold a hash (no TYPE). */
export const HScanDTO = z.tuple([KeySchema, ScanCursorSchema], z.string()).transform(([key, cursor, ...options], ctx) => {
  const parsed = HScanOptionsSchema.safeParse(options);
  if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
  return { key, cursor, match: parsed.data.match, count: parsed.data.count };
});

/**
 * HRANDFIELD key [count [WITHVALUES]]: the count is parsed before the trailing options are checked, and both before
 * the key is read (a bad count beats WRONGTYPE). With WITHVALUES the count must stay within ±LONG_MAX / 2.
 */
export const HRandFieldDTO = z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx) => {
  if (rest.length === 0) return { key, count: null, withValues: false };
  const count = RandomCountSchema.safeParse(rest[0]);
  if (!count.success) return reject(ctx, firstIssue(count.error));
  if (rest.length > 2 || (rest.length === 2 && rest[1].toLowerCase() !== 'withvalues')) return reject(ctx, RespMessages.SYNTAX);
  const withValues = rest.length === 2;
  if (withValues && !isPairCountInRange(count.data)) return reject(ctx, RandomCountMessages.PAIRS_RANGE);
  return { key, count: Number(count.data), withValues };
});

// ============================================================================
// Type Exports
// ============================================================================

export type KeyInput = z.infer<typeof KeyDTO>;
export type KeyFieldInput = z.infer<typeof KeyFieldDTO>;
export type KeyFieldsInput = z.infer<typeof KeyFieldsDTO>;
export type HSetInput = z.infer<typeof HSetCmdDTO>;
export type HSetNxInput = z.infer<typeof HSetNxDTO>;
export type HIncrByInput = z.infer<typeof HIncrByDTO>;
export type HIncrByFloatInput = z.infer<typeof HIncrByFloatDTO>;
export type HScanInput = z.infer<typeof HScanDTO>;
export type HRandFieldInput = z.infer<typeof HRandFieldDTO>;
