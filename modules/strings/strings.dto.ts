import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { INT64_MIN } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';
import {
  ExpireOptionEnum,
  ExpireTimeSchema,
  ExpireTimeSchemas,
  Int64Schema,
  IntegerSchema,
  KeySchema,
  ValueSchema,
  firstIssue,
  parseArg,
  reject,
} from '@/libs/schemas';
import type { ExpireOption, Parsed } from '@/libs/schemas';
import { LongDoubleSchema } from '@/libs/schemas/long-double';

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

/** `key start end` with int64 indexes (GETRANGE, SUBSTR); the service clamps them to the value's length. */
const RangeDTO = z.tuple([KeySchema, Int64Schema, Int64Schema]).transform(([key, start, end]) => ({ key, start, end }));

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
const GETEX_EXPIRE = ExpireTimeSchemas('getex');

/** The expiry options a command accepts besides EX / PX / EXAT / PXAT, and which options each one excludes. */
type OptionRules = Record<string, readonly string[]>;

const EXPIRES = ['EX', 'PX', 'EXAT', 'PXAT'] as const;

const SET_RULES: OptionRules = { NX: ['XX'], XX: ['NX'], GET: [], KEEPTTL: EXPIRES };
const GETEX_RULES: OptionRules = { PERSIST: EXPIRES };

/** What an option scan read: the flags seen and the last expiry option with its value (not yet validated). */
type ScannedOptions = { flags: Set<string>; expire?: { option: ExpireOption; raw: string } };

/**
 * Reads SET / GETEX options left to right like Redis: an option may repeat (the last expiry value wins), an option
 * that conflicts with one already read, an unknown option or an expiry missing its value is a syntax error. The expiry
 * value is validated later, by the caller, and only the last one.
 */
function scanOptions(options: string[], rules: OptionRules): ScannedOptions | null {
  const flags = new Set<string>();
  let expire: ScannedOptions['expire'];
  for (let i = 0; i < options.length; i++) {
    const option = options[i].toUpperCase();
    const asExpire = ExpireOptionEnum.safeParse(option);
    if (asExpire.success && i + 1 < options.length) {
      const excluded = [...EXPIRES.filter((other) => other !== option), ...Object.keys(rules).filter((r) => rules[r] === EXPIRES)];
      if (excluded.some((other) => flags.has(other))) return null;
      flags.add(option);
      expire = { option: asExpire.data, raw: options[++i] };
    } else if (Object.hasOwn(rules, option) && !rules[option].some((other) => flags.has(other))) flags.add(option);
    else return null;
  }
  return { flags, expire };
}

/**
 * SET key value [NX | XX] [GET] [EX s | PX ms | EXAT unix-s | PXAT unix-ms | KEEPTTL]
 * The options are read first (any conflict is a syntax error), then the last expiry value is validated.
 */
export const SetDTO = z.tuple([KeySchema, ValueSchema], z.string()).transform(([key, value, ...options], ctx) => {
  const scanned = scanOptions(options, SET_RULES);
  if (!scanned) return reject(ctx, RespMessages.SYNTAX);
  const { flags, expire } = scanned;
  let expireAt: number | bigint | undefined;
  if (expire) {
    const at = SET_EXPIRE[expire.option].safeParse(expire.raw);
    if (!at.success) return reject(ctx, firstIssue(at.error));
    expireAt = at.data;
  }
  const condition: SetCondition | undefined = flags.has('NX') ? 'NX' : flags.has('XX') ? 'XX' : undefined;
  return { key, value, condition, get: flags.has('GET'), keepTtl: flags.has('KEEPTTL'), expireAt };
});

/**
 * GETEX key [EX s | PX ms | EXAT unix-s | PXAT unix-ms | PERSIST]. Only the option syntax is checked here: Redis looks
 * the key up next (a missing key answers nil, another type WRONGTYPE) and validates the expiry value last, so the
 * value's parse result (`expireAt`) is reported by the service.
 */
export const GetExDTO = z.tuple([KeySchema], z.string()).transform(([key, ...options], ctx) => {
  const scanned = scanOptions(options, GETEX_RULES);
  if (!scanned) return reject(ctx, RespMessages.SYNTAX);
  const { flags, expire } = scanned;
  const expireAt: Parsed<number | bigint> | undefined = expire && parseArg(GETEX_EXPIRE[expire.option], expire.raw);
  return { key, persist: flags.has('PERSIST'), expireAt };
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

/** The increment is read as a long double, like the stored value (see `@/libs/number/long-double`). */
export const IncrByFloatDTO = z.tuple([KeySchema, LongDoubleSchema]).transform(([key, increment]) => ({ key, increment }));

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
    else if (option === 'MINMATCHLEN' && i + 1 < options.length) {
      const min = IntegerSchema.safeParse(options[++i]);
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
