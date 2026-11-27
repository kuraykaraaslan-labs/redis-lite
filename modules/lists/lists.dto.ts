import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { INT64_MIN } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';
import { Int64Schema, IntegerSchema, KeySchema, ValueSchema, firstIssue, reject } from '@/libs/schemas';
import { BlockSecondsTimeoutSchema } from '@/libs/schemas/block-timeout';

import { InsertPositionEnum, LPosOptionEnum, ListSideEnum } from './lists.enums';
import type { ListSide } from './lists.enums';
import ListsMessages from './lists.messages';

/**
 * Argument grammar of the list commands. Each DTO parses the arguments after the command name (`args`), in command
 * order, so the first issue is the error Redis reports first. Checks that need the stored list stay in the services.
 */

// ============================================================================
// Shared Grammar
// ============================================================================

/** `LEFT | RIGHT`, any case; anything else is a syntax error. */
const SideSchema = z.string().transform((raw, ctx) => {
  const side = ListSideEnum.safeParse(raw.toLowerCase());
  return side.success ? side.data : reject(ctx, RespMessages.SYNTAX);
});

/** `numkeys key… LEFT|RIGHT [COUNT n]` (LMPOP, and BLMPOP after its timeout). */
const MPopSchema = z.array(z.string()).transform((args, ctx) => {
  // any numkeys that is not an int64 > 0 gets the same text; a huge one fails on the missing keys (syntax error)
  const numKeys = Int64Schema.safeParse(args[0]);
  if (!numKeys.success || numKeys.data <= 0n) return reject(ctx, ListsMessages.NUMKEYS_POSITIVE);
  const n = Number(numKeys.data);
  const keys = args.slice(1, 1 + n);
  const side = ListSideEnum.safeParse((args[1 + n] ?? '').toLowerCase());
  if (keys.length < n || !side.success) return reject(ctx, RespMessages.SYNTAX);
  let count = 1;
  if (args.length > 2 + n) {
    if (args[2 + n].toLowerCase() !== 'count' || args.length !== 4 + n) return reject(ctx, RespMessages.SYNTAX);
    const parsed = Int64Schema.safeParse(args[3 + n]);
    if (!parsed.success || parsed.data <= 0n) return reject(ctx, ListsMessages.COUNT_POSITIVE);
    count = Number(parsed.data);
  }
  return { keys, left: side.data === 'left', count };
});

const KeyDTO = z.tuple([KeySchema]).transform(([key]) => ({ key }));

const KeyRangeDTO = z.tuple([KeySchema, IntegerSchema, IntegerSchema]).transform(([key, start, stop]) => ({ key, start, stop }));

// ============================================================================
// Push / Pop DTOs: LPUSH, RPUSH, LPUSHX, RPUSHX, LPOP, RPOP, LMPOP
// ============================================================================

function PushDTO(left: boolean, onlyIfExists: boolean) {
  return z.tuple([KeySchema], ValueSchema).transform(([key, ...values]) => ({ key, values, left, onlyIfExists }));
}

export const LPushDTO = PushDTO(true, false);
export const RPushDTO = PushDTO(false, false);
export const LPushXDTO = PushDTO(true, true);
export const RPushXDTO = PushDTO(false, true);

/** LPOP / RPOP key [count]: a second count is an arity error; the count must be a non-negative integer. */
function PopDTO(command: string, left: boolean) {
  const arity = formatMessage(RespMessages.WRONG_ARITY, { command });
  return z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx) => {
    if (rest.length > 1) return reject(ctx, arity);
    if (rest.length === 0) return { key, left, count: null };
    const count = Int64Schema.safeParse(rest[0]);
    if (!count.success || count.data < 0n) return reject(ctx, RespMessages.COUNT_POSITIVE);
    return { key, left, count: Number(count.data) };
  });
}

export const LPopDTO = PopDTO('lpop', true);
export const RPopDTO = PopDTO('rpop', false);

export const LMPopDTO = MPopSchema;

// ============================================================================
// Index DTOs: LLEN, LRANGE, LINDEX, LSET, LREM, LTRIM, LINSERT, LPOS
// ============================================================================

export const LLenDTO = KeyDTO;
export const LRangeDTO = KeyRangeDTO;
export const LTrimDTO = KeyRangeDTO;
export const LIndexDTO = z.tuple([KeySchema, IntegerSchema]).transform(([key, index]) => ({ key, index }));

export const LSetDTO = z
  .tuple([KeySchema, IntegerSchema, ValueSchema])
  .transform(([key, index, element]) => ({ key, index, element }));

export const LRemDTO = z
  .tuple([KeySchema, IntegerSchema, ValueSchema])
  .transform(([key, count, element]) => ({ key, count, element }));

/** LINSERT key BEFORE|AFTER pivot element: the position is checked before the key is read. */
export const LInsertDTO = z
  .tuple([KeySchema, z.string(), ValueSchema, ValueSchema])
  .transform(([key, given, pivot, element], ctx) => {
    const position = InsertPositionEnum.safeParse(given.toLowerCase());
    return position.success ? { key, position: position.data, pivot, element } : reject(ctx, RespMessages.SYNTAX);
  });

/**
 * LPOS key element [RANK rank] [COUNT num-matches] [MAXLEN len]; each option is checked where it stands. Values are
 * int64 (beyond 2^53 only their magnitude matters: no list is that long). RANK -9223372036854775808 cannot be negated:
 * Redis 7.0 then scans from the tail without skipping and without a COUNT limit; it is passed on as -Infinity.
 */
export const LPosDTO = z.tuple([KeySchema, ValueSchema], z.string()).transform(([key, element, ...options], ctx) => {
  let rank = 1;
  let count: number | null = null;
  let maxLen = 0;
  for (let i = 0; i < options.length; i += 2) {
    const option = LPosOptionEnum.safeParse(options[i].toLowerCase());
    if (i + 1 >= options.length || !option.success) return reject(ctx, RespMessages.SYNTAX);
    const parsed = Int64Schema.safeParse(options[i + 1]);
    // COUNT and MAXLEN refuse anything that is not a non-negative int64 with their own text
    const n = parsed.success ? Number(parsed.data) : -1;
    if (option.data === 'rank') {
      if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
      if (n === 0) return reject(ctx, ListsMessages.RANK_ZERO);
      rank = parsed.data === INT64_MIN ? -Infinity : n;
    } else if (option.data === 'count') {
      if (n < 0) return reject(ctx, ListsMessages.COUNT_NEGATIVE);
      count = n;
    } else {
      if (n < 0) return reject(ctx, ListsMessages.MAXLEN_NEGATIVE);
      maxLen = n;
    }
  }
  return { key, element, rank, count, maxLen };
});

// ============================================================================
// Move DTOs: LMOVE, RPOPLPUSH
// ============================================================================

export const LMoveDTO = z
  .tuple([KeySchema, KeySchema, SideSchema, SideSchema])
  .transform(([source, destination, from, to]) => ({ source, destination, from, to }));

export const RPopLPushDTO = z
  .tuple([KeySchema, KeySchema])
  .transform(([source, destination]) => ({ source, destination, from: 'right' as ListSide, to: 'left' as ListSide }));

// ============================================================================
// Blocking DTOs: BLPOP, BRPOP, BLMPOP, BLMOVE, BRPOPLPUSH
// ============================================================================

/** BLPOP / BRPOP key [key …] timeout */
function BPopDTO(left: boolean) {
  return z.array(z.string()).transform((args, ctx) => {
    const timeout = BlockSecondsTimeoutSchema.safeParse(args[args.length - 1]);
    if (!timeout.success) return reject(ctx, firstIssue(timeout.error));
    return { keys: args.slice(0, -1), timeoutMs: timeout.data, left };
  });
}

export const BLPopDTO = BPopDTO(true);
export const BRPopDTO = BPopDTO(false);

/** BLMPOP timeout numkeys key… LEFT|RIGHT [COUNT n]: the timeout is checked first. */
export const BLMPopDTO = z.tuple([BlockSecondsTimeoutSchema], z.string()).transform(([timeoutMs, ...rest], ctx) => {
  const parsed = MPopSchema.safeParse(rest);
  return parsed.success ? { ...parsed.data, timeoutMs } : reject(ctx, firstIssue(parsed.error));
});

/** BLMOVE source destination LEFT|RIGHT LEFT|RIGHT timeout: the sides are checked before the timeout. */
export const BLMoveDTO = z
  .tuple([KeySchema, KeySchema, SideSchema, SideSchema, BlockSecondsTimeoutSchema])
  .transform(([source, destination, from, to, timeoutMs]) => ({ source, destination, from, to, timeoutMs }));

export const BRPopLPushDTO = z
  .tuple([KeySchema, KeySchema, BlockSecondsTimeoutSchema])
  .transform(([source, destination, timeoutMs]) => ({
    source,
    destination,
    from: 'right' as ListSide,
    to: 'left' as ListSide,
    timeoutMs,
  }));

// ============================================================================
// Type Exports
// ============================================================================

export type KeyInput = z.infer<typeof KeyDTO>;
export type KeyRangeInput = z.infer<typeof KeyRangeDTO>;
export type PushInput = z.infer<typeof LPushDTO>;
export type PopInput = z.infer<typeof LPopDTO>;
export type MPopInput = z.infer<typeof LMPopDTO>;
export type LIndexInput = z.infer<typeof LIndexDTO>;
export type LSetInput = z.infer<typeof LSetDTO>;
export type LRemInput = z.infer<typeof LRemDTO>;
export type LInsertInput = z.infer<typeof LInsertDTO>;
export type LPosInput = z.infer<typeof LPosDTO>;
export type MoveInput = z.infer<typeof LMoveDTO>;
export type BPopInput = z.infer<typeof BLPopDTO>;
export type BLMPopInput = z.infer<typeof BLMPopDTO>;
export type BLMoveInput = z.infer<typeof BLMoveDTO>;
