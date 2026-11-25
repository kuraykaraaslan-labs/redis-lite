import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { isInteger } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';
import {
  FloatSchema,
  Int64Schema,
  IntegerSchema,
  KeySchema,
  ScanCursorSchema,
  ScanOptionsSchema,
  ValueSchema,
  firstIssue,
  reject,
} from '@/libs/schemas';

import { FieldExpireConditionEnum, FieldExpireOptionEnum } from './hashes.enums';
import type { FieldExpireCondition } from './hashes.enums';
import HashesMessages from './hashes.messages';

/**
 * Argument grammar of the hash commands. Each DTO parses the arguments after the command name (`args`), in command
 * order, so the first issue is the error Redis reports first. Checks that need the stored hash stay in the services.
 */

// ============================================================================
// Shared Grammar
// ============================================================================

/** The outcome of one grammar step inside a transform: a value, or the error text to report. */
type Step<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * `FIELDS numfields field…` (or `field value…` pairs when `withValues`) from `args[i]` to the end: FIELDS must stand
 * there, numfields must be a positive integer and match the number of arguments that follow.
 */
function readFields(args: string[], i: number, withValues = false): Step<string[]> {
  if ((args[i] ?? '').toLowerCase() !== 'fields') return { ok: false, message: HashesMessages.FIELDS_MISSING };
  const raw = args[i + 1] ?? '';
  if (!isInteger(raw) || Number(raw) <= 0) return { ok: false, message: HashesMessages.NUMFIELDS_POSITIVE };
  const n = Number(raw);
  const rest = args.slice(i + 2);
  if (rest.length !== (withValues ? n * 2 : n)) return { ok: false, message: HashesMessages.NUMFIELDS_MISMATCH };
  return { ok: true, value: rest };
}

/**
 * `EX s | PX ms | EXAT ts | PXAT ms-ts` at args[i] → absolute ms; null when the token is not one of them. A value that
 * is not a positive integer is refused (HGETEX's wording, for HSETEX too).
 */
function readFieldExpiry(args: string[], i: number): Step<number | null> {
  const option = FieldExpireOptionEnum.safeParse((args[i] ?? '').toLowerCase());
  if (!option.success) return { ok: true, value: null };
  const amount = IntegerSchema.safeParse(args[i + 1] ?? '');
  if (!amount.success) return { ok: false, message: firstIssue(amount.error) };
  const n = amount.data;
  if (n <= 0) return { ok: false, message: HashesMessages.INVALID_FIELD_EXPIRE };
  const unit = option.data === 'ex' || option.data === 'exat' ? 1000 : 1;
  return { ok: true, value: option.data.endsWith('at') ? n * unit : Date.now() + n * unit };
}

const KeyDTO = z.tuple([KeySchema]).transform(([key]) => ({ key }));

const KeyFieldDTO = z.tuple([KeySchema, z.string()]).transform(([key, field]) => ({ key, field }));

const KeyFieldsDTO = z.tuple([KeySchema], z.string()).transform(([key, ...fields]) => ({ key, fields }));

/** `key FIELDS numfields field…` (HTTL family, HPERSIST, HGETDEL). */
const KeyFieldsClauseDTO = z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx) => {
  const fields = readFields(rest, 0);
  return fields.ok ? { key, fields: fields.value } : reject(ctx, fields.message);
});

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

export const HIncrByFloatDTO = z
  .tuple([KeySchema, z.string(), FloatSchema])
  .transform(([key, field, increment]) => ({ key, field, increment }));

// ============================================================================
// Iteration DTOs: HSCAN, HRANDFIELD
// ============================================================================

/** HSCAN key cursor [MATCH pattern] [COUNT n] [NOVALUES] */
export const HScanDTO = z.tuple([KeySchema, ScanCursorSchema], z.string()).transform(([key, cursor, ...options], ctx) => {
  const parsed = ScanOptionsSchema.safeParse(options);
  if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
  return { key, cursor, match: parsed.data.match, noValues: parsed.data.noValues, count: parsed.data.count };
});

/** HRANDFIELD key [count [WITHVALUES]]: the count is parsed before the trailing options are checked. */
export const HRandFieldDTO = z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx) => {
  if (rest.length === 0) return { key, count: null, withValues: false };
  const count = IntegerSchema.safeParse(rest[0]);
  if (!count.success) return reject(ctx, firstIssue(count.error));
  if (rest.length > 2 || (rest.length === 2 && rest[1].toLowerCase() !== 'withvalues')) return reject(ctx, RespMessages.SYNTAX);
  return { key, count: count.data, withValues: rest.length === 2 };
});

// ============================================================================
// Field TTL DTOs: HEXPIRE family, HTTL family, HPERSIST
// ============================================================================

const ExpireAmountSchema = IntegerSchema.refine((n) => n >= 0, { error: HashesMessages.EXPIRE_NEGATIVE });

/** HEXPIRE key amount [NX | XX | GT | LT] FIELDS numfields field… (`unit` ms per unit, `absolute` for the *AT forms). */
function HExpireDTO(unit: number, absolute: boolean) {
  return z.tuple([KeySchema, ExpireAmountSchema], z.string()).transform(([key, amount, ...rest], ctx) => {
    let i = 0;
    let condition: FieldExpireCondition | null = null;
    const given = FieldExpireConditionEnum.safeParse((rest[i] ?? '').toLowerCase());
    if (given.success) {
      condition = given.data;
      i++;
    }
    const fields = readFields(rest, i);
    if (!fields.ok) return reject(ctx, fields.message);
    return { key, amount, unit, absolute, condition, fields: fields.value };
  });
}

export const HExpireCmdDTO = HExpireDTO(1000, false);
export const HPExpireDTO = HExpireDTO(1, false);
export const HExpireAtDTO = HExpireDTO(1000, true);
export const HPExpireAtDTO = HExpireDTO(1, true);

/** HTTL family: the reply unit (ms per unit) and whether the absolute time is wanted. */
function HTtlDTO(unit: number, absolute: boolean) {
  return KeyFieldsClauseDTO.transform((input) => ({ ...input, unit, absolute }));
}

export const HTtlCmdDTO = HTtlDTO(1000, false);
export const HPTtlDTO = HTtlDTO(1, false);
export const HExpireTimeDTO = HTtlDTO(1000, true);
export const HPExpireTimeDTO = HTtlDTO(1, true);
export const HPersistDTO = KeyFieldsClauseDTO;

// ============================================================================
// Get-and-set DTOs: HGETDEL, HGETEX, HSETEX
// ============================================================================

export const HGetDelDTO = KeyFieldsClauseDTO;

/** HGETEX key [EX s | PX ms | EXAT ts | PXAT ms-ts | PERSIST] FIELDS numfields field… */
export const HGetExDTO = z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx) => {
  let i = 0;
  let persist = false;
  const expiry = readFieldExpiry(rest, i);
  if (!expiry.ok) return reject(ctx, expiry.message);
  const at = expiry.value;
  if (at !== null) i += 2;
  else if ((rest[i] ?? '').toLowerCase() === 'persist') {
    persist = true;
    i++;
  }
  const fields = readFields(rest, i);
  if (!fields.ok) return reject(ctx, fields.message);
  return { key, at, persist, fields: fields.value };
});

/**
 * HSETEX key [FNX | FXX] [EX s | PX ms | EXAT ts | PXAT ms-ts | KEEPTTL] FIELDS numfields field value…
 * Options are read left to right; FNX with FXX, or a second expiry option, is refused where it stands.
 */
export const HSetExDTO = z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx) => {
  let i = 0;
  let fnx = false;
  let fxx = false;
  let keepTtl = false;
  let at: number | null = null;
  let expiryOptions = 0;
  for (;;) {
    const opt = (rest[i] ?? '').toLowerCase();
    if (opt === 'fnx') {
      if (fxx) return reject(ctx, HashesMessages.FNX_AND_FXX);
      fnx = true;
    } else if (opt === 'fxx') {
      if (fnx) return reject(ctx, HashesMessages.FNX_AND_FXX);
      fxx = true;
    } else if (opt === 'keepttl') {
      keepTtl = true;
      expiryOptions++;
    } else {
      const expiry = readFieldExpiry(rest, i);
      if (!expiry.ok) return reject(ctx, expiry.message);
      if (expiry.value === null) break;
      at = expiry.value;
      expiryOptions++;
      i++;
    }
    if (expiryOptions > 1) return reject(ctx, HashesMessages.ONE_EXPIRY_OPTION);
    i++;
  }
  const pairs = readFields(rest, i, true);
  if (!pairs.ok) return reject(ctx, pairs.message);
  return { key, fnx, fxx, keepTtl, at, pairs: pairs.value };
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
export type HExpireInput = z.infer<typeof HExpireCmdDTO>;
export type HTtlInput = z.infer<typeof HTtlCmdDTO>;
export type HGetExInput = z.infer<typeof HGetExDTO>;
export type HSetExInput = z.infer<typeof HSetExDTO>;
