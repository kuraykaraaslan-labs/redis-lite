import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { INT64_MIN } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';
import {
  ExpireOptionEnum,
  ExpireTimeSchema,
  ExpireTimeSchemas,
  FloatSchema,
  Int64Schema,
  IntegerSchema,
  KeySchema,
  ValueSchema,
  firstIssue,
  reject,
} from '@/libs/schemas';

import { LcsFlagEnum } from './strings.enums';
import type { SetCondition } from './strings.enums';
import StringsMessages from './strings.messages';

/**
 * Argument grammar of the string commands. Each DTO parses the arguments after the command name (`args`), in command
 * order, so the first issue is the error Redis reports first. Checks that need the database stay in the services.
 */

// ============================================================================
// Shared Shapes
// ============================================================================

const KeyDTO = z.tuple([KeySchema]).transform(([key]) => ({ key }));

const KeyValueDTO = z.tuple([KeySchema, ValueSchema]).transform(([key, value]) => ({ key, value }));

/** `key value [key value …]`; an odd count is an arity error naming the command (MSET, MSETNX). */
function KeyValuePairsDTO(command: string) {
  return z.array(z.string()).transform((args, ctx) => {
    if (args.length % 2) return reject(ctx, formatMessage(RespMessages.WRONG_ARITY, { command }));
    const pairs: Array<[key: string, value: string]> = [];
    for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
    return { pairs };
  });
}

/** `key start end` with integer indexes (GETRANGE, SUBSTR). */
const RangeDTO = z.tuple([KeySchema, IntegerSchema, IntegerSchema]).transform(([key, start, end]) => ({ key, start, end }));

// ============================================================================
// Value DTOs: GET, SET and variants, GETEX, MGET, MSET
// ============================================================================

export const GetDTO = KeyDTO;
export const GetDelDTO = KeyDTO;
export const GetSetDTO = KeyValueDTO;
export const SetNxDTO = KeyValueDTO;

export const SetExDTO = z
  .tuple([KeySchema, ExpireTimeSchema('EX', 'setex'), ValueSchema])
  .transform(([key, expireAt, value]) => ({ key, expireAt, value }));

export const PSetExDTO = z
  .tuple([KeySchema, ExpireTimeSchema('PX', 'psetex'), ValueSchema])
  .transform(([key, expireAt, value]) => ({ key, expireAt, value }));

const SET_EXPIRE = ExpireTimeSchemas('set');

/**
 * SET key value [NX | XX] [GET] [EX s | PX ms | EXAT unix-s | PXAT unix-ms | KEEPTTL]
 * Options are read left to right (an invalid expire time or unknown option fails where it stands); conflicting
 * options are a syntax error once all of them are read.
 */
export const SetDTO = z.tuple([KeySchema, ValueSchema], z.string()).transform(([key, value, ...options], ctx) => {
  const flags = new Set<string>();
  let expireAt: number | undefined;
  let expiryOptions = 0;
  for (let i = 0; i < options.length; i++) {
    const option = options[i].toUpperCase();
    const expire = ExpireOptionEnum.safeParse(option);
    if (option === 'NX' || option === 'XX' || option === 'GET') flags.add(option);
    else if (option === 'KEEPTTL') {
      flags.add(option);
      expiryOptions++;
    } else if (expire.success && i + 1 < options.length) {
      const at = SET_EXPIRE[expire.data].safeParse(options[++i]);
      if (!at.success) return reject(ctx, firstIssue(at.error));
      expireAt = at.data;
      expiryOptions++;
    } else return reject(ctx, RespMessages.SYNTAX);
  }
  if ((flags.has('NX') && flags.has('XX')) || expiryOptions > 1) return reject(ctx, RespMessages.SYNTAX);
  const condition: SetCondition | undefined = flags.has('NX') ? 'NX' : flags.has('XX') ? 'XX' : undefined;
  return { key, value, condition, get: flags.has('GET'), keepTtl: flags.has('KEEPTTL'), expireAt };
});

const GETEX_EXPIRE = ExpireTimeSchemas('getex');

/** GETEX key [EX s | PX ms | EXAT unix-s | PXAT unix-ms | PERSIST]: at most one option, so the shape is checked first. */
export const GetExDTO = z.tuple([KeySchema], z.string()).transform(([key, ...options], ctx) => {
  const option = options[0]?.toUpperCase();
  const expire = ExpireOptionEnum.safeParse(option);
  if (options.length === 0) return { key, persist: false, expireAt: undefined };
  if (option === 'PERSIST' && options.length === 1) return { key, persist: true, expireAt: undefined };
  if (!expire.success || options.length !== 2) return reject(ctx, RespMessages.SYNTAX);
  const at = GETEX_EXPIRE[expire.data].safeParse(options[1]);
  return at.success ? { key, persist: false, expireAt: at.data } : reject(ctx, firstIssue(at.error));
});

export const MGetDTO = z.array(KeySchema).transform((keys) => ({ keys }));
export const MSetDTO = KeyValuePairsDTO('mset');
export const MSetNxDTO = KeyValuePairsDTO('msetnx');

// ============================================================================
// Counter DTOs: INCR, DECR, INCRBY, DECRBY, INCRBYFLOAT
// ============================================================================

export const IncrDTO = z.tuple([KeySchema]).transform(([key]) => ({ key, delta: 1n }));
export const DecrDTO = z.tuple([KeySchema]).transform(([key]) => ({ key, delta: -1n }));
export const IncrByDTO = z.tuple([KeySchema, Int64Schema]).transform(([key, delta]) => ({ key, delta }));

/** The decrement is negated, so -2^63 (whose negation does not fit in int64) is refused up front. */
export const DecrByDTO = z
  .tuple([KeySchema, Int64Schema.refine((n) => n !== INT64_MIN, { error: StringsMessages.DECREMENT_OVERFLOW })])
  .transform(([key, decrement]) => ({ key, delta: -decrement }));

export const IncrByFloatDTO = z.tuple([KeySchema, FloatSchema]).transform(([key, increment]) => ({ key, increment }));

// ============================================================================
// Range DTOs: APPEND, STRLEN, GETRANGE, SUBSTR, SETRANGE
// ============================================================================

export const AppendDTO = KeyValueDTO;
export const StrLenDTO = KeyDTO;
export const GetRangeDTO = RangeDTO;
export const SubstrDTO = RangeDTO;

export const SetRangeDTO = z
  .tuple([KeySchema, IntegerSchema.refine((offset) => offset >= 0, { error: StringsMessages.OFFSET_OUT_OF_RANGE }), ValueSchema])
  .transform(([key, offset, value]) => ({ key, offset, value }));

// ============================================================================
// LCS DTO
// ============================================================================

/** LCS key1 key2 [LEN] [IDX] [MINMATCHLEN len] [WITHMATCHLEN] */
export const LcsDTO = z.tuple([KeySchema, KeySchema], z.string()).transform(([keyA, keyB, ...options], ctx) => {
  const flags = new Set<string>();
  let minMatchLen = 0;
  for (let i = 0; i < options.length; i++) {
    const option = options[i].toUpperCase();
    if (LcsFlagEnum.safeParse(option).success) flags.add(option);
    else if (option === 'MINMATCHLEN') {
      const min = IntegerSchema.safeParse(options[++i] ?? '');
      if (!min.success) return reject(ctx, firstIssue(min.error));
      minMatchLen = Math.max(0, min.data);
    } else return reject(ctx, RespMessages.SYNTAX);
  }
  if (flags.has('LEN') && flags.has('IDX')) return reject(ctx, StringsMessages.LCS_LEN_AND_IDX);
  return { keyA, keyB, len: flags.has('LEN'), idx: flags.has('IDX'), withMatchLen: flags.has('WITHMATCHLEN'), minMatchLen };
});

// ============================================================================
// Type Exports
// ============================================================================

export type KeyInput = z.infer<typeof KeyDTO>;
export type KeyValueInput = z.infer<typeof KeyValueDTO>;
export type SetInput = z.infer<typeof SetDTO>;
export type SetExInput = z.infer<typeof SetExDTO>;
export type GetExInput = z.infer<typeof GetExDTO>;
export type MGetInput = z.infer<typeof MGetDTO>;
export type MSetInput = z.infer<typeof MSetDTO>;
export type IncrByInput = z.infer<typeof IncrByDTO>;
export type IncrByFloatInput = z.infer<typeof IncrByFloatDTO>;
export type RangeInput = z.infer<typeof RangeDTO>;
export type SetRangeInput = z.infer<typeof SetRangeDTO>;
export type LcsInput = z.infer<typeof LcsDTO>;
