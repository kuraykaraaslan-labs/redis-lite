import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { toFloat } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';
import {
  FloatSchema,
  FloatSchemaWith,
  Int64Schema,
  IntegerSchema,
  IntegerSchemaWith,
  KeySchema,
  ScanCursorSchema,
  ValueSchema,
  parseArg,
  reject,
} from '@/libs/schemas';
import { BlockSecondsTimeoutSchema } from '@/libs/schemas/block-timeout';
import { RandomCountMessages, RandomCountSchema, isPairCountInRange } from '@/libs/schemas/random-count';
import type { Parsed } from '@/libs/schemas';

import { AggregateEnum, PopSideEnum } from './zsets.enums';
import type { Aggregate, CombineOp } from './zsets.enums';
import ZSetsMessages from './zsets.messages';
import type { CombineMode, FixedRange, LexBound, ParsedRange, RangeOptions, ScoreBound } from './zsets.types';

/**
 * Argument grammar of the sorted-set commands. Each DTO parses the arguments after the command name (`args`), in
 * Redis's order, so the first issue is the error Redis reports first. Option lists are read left to right exactly like
 * the original parsers: an option is only recognised when enough arguments remain for it.
 *
 * Several commands read a key between two parsing steps (ZRANGESTORE, ZUNION…, ZSCAN): they have one DTO per step
 * (`…KeysDTO` / `…OptionsDTO` first, the full DTO after the read), see zsets.commands.ts.
 */

// ============================================================================
// Argument Primitives
// ============================================================================

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function unwrap<T>(ctx: z.core.$RefinementCtx, parsed: Parsed<T>): T {
  return parsed.ok ? parsed.value : reject(ctx, parsed.error);
}

/** ZPOPMIN / ZPOPMAX's COUNT: not an integer and negative are the same error. */
const PopCountSchema = IntegerSchemaWith(RespMessages.COUNT_POSITIVE);

/** ZINTERCARD's LIMIT: not an integer and negative are the same error. */
const CardLimitSchema = IntegerSchemaWith(ZSetsMessages.LIMIT_NEGATIVE);

/** A WEIGHTS value of ZUNION / ZINTER. */
const WeightSchema = FloatSchemaWith(ZSetsMessages.WEIGHT_NOT_FLOAT);

/** A score bound: `5`, `(5` (exclusive), `-inf`, `+inf`. */
export const ScoreBoundSchema = z.string().transform((raw, ctx): ScoreBound => {
  const exclusive = raw.startsWith('(');
  const value = toFloat(exclusive ? raw.slice(1) : raw);
  return value === null ? reject(ctx, ZSetsMessages.MIN_MAX_NOT_FLOAT) : { value, exclusive };
});

/** A lexicographic bound: `-`, `+`, `[member` (inclusive) or `(member` (exclusive). */
export const LexBoundSchema = z.string().transform((raw, ctx): LexBound => {
  if (raw === '-') return { kind: 'min' };
  if (raw === '+') return { kind: 'max' };
  if (raw.startsWith('[')) return { kind: 'value', value: raw.slice(1), exclusive: false };
  if (raw.startsWith('(')) return { kind: 'value', value: raw.slice(1), exclusive: true };
  return reject(ctx, ZSetsMessages.MIN_MAX_NOT_STRING);
});

// ============================================================================
// Shared Shapes
// ============================================================================

const KeyDTO = z.tuple([KeySchema]).transform(([key]) => ({ key }));

const KeyMemberDTO = z.tuple([KeySchema, ValueSchema]).transform(([key, member]) => ({ key, member }));

const KeyMembersDTO = z.tuple([KeySchema], ValueSchema).transform(([key, ...members]) => ({ key, members }));

const ScoreRangeDTO = z.tuple([KeySchema, ScoreBoundSchema, ScoreBoundSchema]).transform(([key, min, max]) => ({ key, min, max }));

const LexRangeDTO = z.tuple([KeySchema, LexBoundSchema, LexBoundSchema]).transform(([key, min, max]) => ({ key, min, max }));

// ============================================================================
// Write DTOs: ZADD, ZINCRBY, ZREM
// ============================================================================

/**
 * ZADD key [NX | XX] [GT | LT] [CH] [INCR] score member [score member …]
 * Flags are read until the first non-flag; then the shape and the flag conflicts are checked before any score.
 */
export const ZAddDTO = z.tuple([KeySchema], z.string()).transform(([key, ...args], ctx) => {
  const flags = { nx: false, xx: false, gt: false, lt: false, ch: false, incr: false };
  let i = 0;
  for (; i < args.length; i++) {
    const option = args[i].toLowerCase();
    if (option in flags) flags[option as keyof typeof flags] = true;
    else break;
  }
  const rest = args.slice(i);
  if (!rest.length || rest.length % 2) return reject(ctx, RespMessages.SYNTAX);
  if (flags.nx && flags.xx) return reject(ctx, ZSetsMessages.XX_NX);
  if ((flags.gt && flags.nx) || (flags.lt && flags.nx) || (flags.gt && flags.lt)) return reject(ctx, ZSetsMessages.GT_LT_NX);
  if (flags.incr && rest.length !== 2) return reject(ctx, ZSetsMessages.INCR_ONE_PAIR);
  const pairs: Array<[score: number, member: string]> = [];
  for (let j = 0; j < rest.length; j += 2) {
    const score = parseArg(FloatSchema, rest[j]);
    if (!score.ok) return reject(ctx, score.error);
    pairs.push([score.value, rest[j + 1]]);
  }
  return { key, flags, pairs };
});

export const ZIncrByDTO = z
  .tuple([KeySchema, FloatSchema, ValueSchema])
  .transform(([key, increment, member]) => ({ key, increment, member }));

export const ZRemDTO = KeyMembersDTO;

// ============================================================================
// Query DTOs: ZCARD, ZSCORE, ZMSCORE, ZCOUNT, ZLEXCOUNT, ZRANK, ZSCAN, ZRANDMEMBER
// ============================================================================

export const ZCardDTO = KeyDTO;
export const ZScoreDTO = KeyMemberDTO;
export const ZMScoreDTO = KeyMembersDTO;
export const ZCountDTO = ScoreRangeDTO;
export const ZLexCountDTO = LexRangeDTO;

/** ZRANK / ZREVRANK key member. */
function RankDTO(reverse: boolean) {
  return z.tuple([KeySchema, ValueSchema]).transform(([key, member]) => ({ key, member, reverse }));
}

export const ZRankDTO = RankDTO(false);
export const ZRevRankDTO = RankDTO(true);

/** ZSCAN key cursor …: the cursor alone, checked before the key is read. */
export const ZScanCursorDTO = z.tuple([KeySchema, ScanCursorSchema], z.string()).transform(([key, cursor]) => ({ key, cursor }));

/** ZSCAN key cursor [MATCH pattern] [COUNT count], parsed once the key is known to hold a sorted set. */
export const ZScanDTO = z.tuple([KeySchema, ScanCursorSchema], z.string()).transform(([key, cursor, ...options], ctx) => {
  let match = '*';
  let count = 10;
  for (let i = 0; i < options.length; i++) {
    const option = options[i].toLowerCase();
    if (option === 'count' && i + 1 < options.length) {
      const parsed = parseArg(IntegerSchema, options[++i]);
      if (!parsed.ok) return reject(ctx, parsed.error);
      if (parsed.value < 1) return reject(ctx, RespMessages.SYNTAX);
      count = parsed.value;
    } else if (option === 'match' && i + 1 < options.length) match = options[++i];
    else return reject(ctx, RespMessages.SYNTAX);
  }
  return { key, cursor, match, count };
});

/** ZRANDMEMBER key [count [WITHSCORES]]: the count is parsed before the trailing option is checked. */
export const ZRandMemberDTO = z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx) => {
  if (!rest.length) return { key, count: null, withScores: false };
  const count = parseArg(RandomCountSchema, rest[0]);
  if (!count.ok) return reject(ctx, count.error);
  if (rest.length > 2 || (rest.length === 2 && rest[1].toLowerCase() !== 'withscores')) return reject(ctx, RespMessages.SYNTAX);
  const withScores = rest.length === 2;
  if (withScores && !isPairCountInRange(count.value)) return reject(ctx, RandomCountMessages.PAIRS_RANGE);
  return { key, count: Number(count.value), withScores };
});

// ============================================================================
// Range DTOs: ZRANGE family, ZRANGESTORE, ZREMRANGEBY*
// ============================================================================

/**
 * Option parsing of zrangeGenericCommand: BYSCORE/BYLEX are accepted only when the command did not fix the range
 * type (ZRANGE, ZRANGESTORE) and only once; REV likewise; WITHSCORES never for the STORE form.
 */
function rangeOptions(options: string[], fixed: FixedRange, store: boolean): Parsed<RangeOptions> {
  let by = fixed.by;
  let rev = fixed.rev;
  let limit: RangeOptions['limit'] = null;
  let scores = false;
  for (let i = 0; i < options.length; i++) {
    const option = options[i].toLowerCase();
    const left = options.length - i - 1;
    if (!store && option === 'withscores') scores = true;
    else if (option === 'limit' && left >= 2) {
      const offset = parseArg(IntegerSchema, options[i + 1]);
      if (!offset.ok) return offset;
      const count = parseArg(IntegerSchema, options[i + 2]);
      if (!count.ok) return count;
      limit = [offset.value, count.value];
      i += 2;
    } else if (rev === undefined && option === 'rev') rev = true;
    else if (by === undefined && option === 'bylex') by = 'lex';
    else if (by === undefined && option === 'byscore') by = 'score';
    else return fail(RespMessages.SYNTAX);
  }
  const parsed: RangeOptions = { by: by ?? 'rank', rev: rev ?? false, limit, scores };
  if (parsed.limit && parsed.by === 'rank') return fail(ZSetsMessages.LIMIT_NEEDS_BY);
  if (parsed.scores && parsed.by === 'lex') return fail(ZSetsMessages.WITHSCORES_BYLEX);
  return { ok: true, value: parsed };
}

/** Parses `start stop` like zrangeGenericCommand step 2 (for REV score/lex ranges the args arrive as max, min). */
function rangeBounds(start: string, stop: string, options: RangeOptions): Parsed<ParsedRange> {
  const [a, b] = options.rev && options.by !== 'rank' ? [stop, start] : [start, stop];
  if (options.by === 'rank') {
    const from = parseArg(IntegerSchema, a);
    if (!from.ok) return from;
    const to = parseArg(IntegerSchema, b);
    return to.ok ? { ok: true, value: { by: 'rank', start: from.value, stop: to.value } } : to;
  }
  if (options.by === 'score') {
    const min = parseArg(ScoreBoundSchema, a);
    if (!min.ok) return min;
    const max = parseArg(ScoreBoundSchema, b);
    return max.ok ? { ok: true, value: { by: 'score', min: min.value, max: max.value } } : max;
  }
  const min = parseArg(LexBoundSchema, a);
  if (!min.ok) return min;
  const max = parseArg(LexBoundSchema, b);
  return max.ok ? { ok: true, value: { by: 'lex', min: min.value, max: max.value } } : max;
}

/** key start stop [options]: the options first, then the two bounds. */
function RangeDTO(fixed: FixedRange) {
  return z.tuple([KeySchema, z.string(), z.string()], z.string()).transform(([key, start, stop, ...rest], ctx) => {
    const options = rangeOptions(rest, fixed, false);
    if (!options.ok) return reject(ctx, options.error);
    return { key, range: unwrap(ctx, rangeBounds(start, stop, options.value)), options: options.value };
  });
}

export const ZRangeDTO = RangeDTO({});
export const ZRevRangeDTO = RangeDTO({ by: 'rank', rev: true });
export const ZRangeByScoreDTO = RangeDTO({ by: 'score', rev: false });
export const ZRevRangeByScoreDTO = RangeDTO({ by: 'score', rev: true });
export const ZRangeByLexDTO = RangeDTO({ by: 'lex', rev: false });
export const ZRevRangeByLexDTO = RangeDTO({ by: 'lex', rev: true });

const RangeStoreShape = z.tuple([KeySchema, KeySchema, z.string(), z.string()], z.string());

/** ZRANGESTORE dst src min max [options]: the options alone (they are checked before the source key is read). */
export const ZRangeStoreOptionsDTO = RangeStoreShape.transform(([, , , , ...rest], ctx) => unwrap(ctx, rangeOptions(rest, {}, true)));

/** ZRANGESTORE dst src min max [options], in full (the bounds are checked after the source key is read). */
export const ZRangeStoreDTO = RangeStoreShape.transform(([destination, source, start, stop, ...rest], ctx) => {
  const options = rangeOptions(rest, {}, true);
  if (!options.ok) return reject(ctx, options.error);
  return { destination, source, range: unwrap(ctx, rangeBounds(start, stop, options.value)), options: options.value };
});

export const ZRemRangeByScoreDTO = ScoreRangeDTO;
export const ZRemRangeByLexDTO = LexRangeDTO;

export const ZRemRangeByRankDTO = z
  .tuple([KeySchema, IntegerSchema, IntegerSchema])
  .transform(([key, start, stop]) => ({ key, start, stop }));

// ============================================================================
// Pop DTOs: ZPOPMIN, ZPOPMAX, BZPOPMIN, BZPOPMAX, ZMPOP, BZMPOP
// ============================================================================

/** ZPOPMIN / ZPOPMAX key [count]: `withCount` tells the reply shape (flat without COUNT). */
function PopDTO(max: boolean) {
  return z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx) => {
    if (rest.length > 1) return reject(ctx, RespMessages.SYNTAX);
    if (!rest.length) return { key, count: 1, withCount: false, max };
    const count = parseArg(PopCountSchema, rest[0]);
    if (!count.ok) return reject(ctx, count.error);
    if (count.value < 0) return reject(ctx, RespMessages.COUNT_POSITIVE);
    return { key, count: count.value, withCount: true, max };
  });
}

export const ZPopMinDTO = PopDTO(false);
export const ZPopMaxDTO = PopDTO(true);

/** BZPOPMIN / BZPOPMAX key [key …] timeout. */
function BlockingPopDTO(max: boolean) {
  return z.array(KeySchema).transform((args, ctx) => {
    const timeoutMs = unwrap(ctx, parseArg(BlockSecondsTimeoutSchema, args[args.length - 1]));
    return { keys: args.slice(0, -1), timeoutMs, max };
  });
}

export const BZPopMinDTO = BlockingPopDTO(false);
export const BZPopMaxDTO = BlockingPopDTO(true);

/** `numkeys key … MIN|MAX [COUNT count]` → keys, side, count. */
function mpopArgs(args: string[]): Parsed<{ keys: string[]; max: boolean; count: number }> {
  // any numkeys that is not an int64 > 0 gets the same text; a huge one fails on the missing keys (syntax error)
  const numKeys = parseArg(Int64Schema, args[0]);
  if (!numKeys.ok || numKeys.value <= 0n) return fail(ZSetsMessages.NUMKEYS_NOT_POSITIVE);
  const n = Number(numKeys.value);
  const keys = args.slice(1, 1 + n);
  const side = PopSideEnum.safeParse((args[1 + n] ?? '').toLowerCase());
  if (keys.length < n || !side.success) return fail(RespMessages.SYNTAX);
  let count = 1;
  if (args.length > 2 + n) {
    if (args[2 + n].toLowerCase() !== 'count' || args.length !== 4 + n) return fail(RespMessages.SYNTAX);
    const parsed = parseArg(Int64Schema, args[3 + n]);
    if (!parsed.ok || parsed.value <= 0n) return fail(ZSetsMessages.COUNT_NOT_POSITIVE);
    count = Number(parsed.value);
  }
  return { ok: true, value: { keys, max: side.data === 'max', count } };
}

export const ZMPopDTO = z.array(z.string()).transform((args, ctx) => unwrap(ctx, mpopArgs(args)));

/** BZMPOP timeout numkeys key … MIN|MAX [COUNT count]: the timeout first. */
export const BZMPopDTO = z.tuple([z.string()], z.string()).transform(([timeout, ...args], ctx) => {
  const timeoutMs = parseArg(BlockSecondsTimeoutSchema, timeout);
  if (!timeoutMs.ok) return reject(ctx, timeoutMs.error);
  return { timeoutMs: timeoutMs.value, ...unwrap(ctx, mpopArgs(args)) };
});

// ============================================================================
// Combine DTOs: ZUNION, ZINTER, ZDIFF (+STORE), ZINTERCARD
// ============================================================================

const REPLY_MODE: CombineMode = { withScores: true, cardinality: false };
const STORE_MODE: CombineMode = { withScores: false, cardinality: false };
const CARD_MODE: CombineMode = { withScores: false, cardinality: true };

/** `numkeys key …`: at least one key, and no more keys than arguments. */
function combineKeys(args: string[], command: string): Parsed<string[]> {
  const numKeys = parseArg(IntegerSchema, args[0]);
  if (!numKeys.ok) return numKeys;
  if (numKeys.value < 1) return fail(formatMessage(ZSetsMessages.AT_LEAST_ONE_KEY, { command }));
  if (numKeys.value > args.length - 1) return fail(RespMessages.SYNTAX);
  return { ok: true, value: args.slice(1, 1 + numKeys.value) };
}

/**
 * `numkeys key … [WEIGHTS w …] [AGGREGATE SUM|MIN|MAX] [WITHSCORES] [LIMIT n]`, following zunionInterDiffGenericCommand:
 * an option is only recognised when enough arguments remain for it and the command variant accepts it.
 */
function combineArgs(args: string[], command: string, op: CombineOp, mode: CombineMode) {
  const parsedKeys = combineKeys(args, command);
  if (!parsedKeys.ok) return parsedKeys;
  const keys = parsedKeys.value;
  const n = keys.length;
  const weights = keys.map(() => 1);
  let aggregate: Aggregate = 'sum';
  let withScores = false;
  let limit = 0;
  const weighted = op !== 'diff' && !mode.cardinality;
  for (let i = 1 + n; i < args.length; ) {
    const option = args[i].toLowerCase();
    const remaining = args.length - i;
    if (weighted && remaining >= n + 1 && option === 'weights') {
      for (let j = 0; j < n; j++) {
        const weight = parseArg(WeightSchema, args[i + 1 + j]);
        if (!weight.ok) return weight;
        weights[j] = weight.value;
      }
      i += n + 1;
    } else if (weighted && remaining >= 2 && option === 'aggregate') {
      const parsed = AggregateEnum.safeParse(args[i + 1].toLowerCase());
      if (!parsed.success) return fail(RespMessages.SYNTAX);
      aggregate = parsed.data;
      i += 2;
    } else if (mode.withScores && !mode.cardinality && option === 'withscores') {
      withScores = true;
      i += 1;
    } else if (mode.cardinality && remaining >= 2 && option === 'limit') {
      const parsed = parseArg(CardLimitSchema, args[i + 1]);
      if (!parsed.ok) return parsed;
      if (parsed.value < 0) return fail(ZSetsMessages.LIMIT_NEGATIVE);
      limit = parsed.value;
      i += 2;
    } else return fail(RespMessages.SYNTAX);
  }
  return { ok: true as const, value: { op, keys, weights, aggregate, withScores, limit } };
}

/** The `numkeys key …` step alone: the keys are read (WRONGTYPE) before the options are parsed. */
function CombineKeysDTO(command: string, store: boolean) {
  return z.array(z.string()).transform((args, ctx) => unwrap(ctx, combineKeys(store ? args.slice(1) : args, command)));
}

function CombineDTO(command: string, op: CombineOp, mode: CombineMode) {
  return z.array(z.string()).transform((args, ctx) => unwrap(ctx, combineArgs(args, command, op, mode)));
}

/** The STORE forms: `destination numkeys key … [options]`. */
function CombineStoreDTO(command: string, op: CombineOp) {
  return z.tuple([KeySchema], z.string()).transform(([destination, ...args], ctx) => ({
    destination,
    ...unwrap(ctx, combineArgs(args, command, op, STORE_MODE)),
  }));
}

export const ZUnionKeysDTO = CombineKeysDTO('zunion', false);
export const ZInterKeysDTO = CombineKeysDTO('zinter', false);
export const ZDiffKeysDTO = CombineKeysDTO('zdiff', false);
export const ZInterCardKeysDTO = CombineKeysDTO('zintercard', false);
export const ZUnionStoreKeysDTO = CombineKeysDTO('zunionstore', true);
export const ZInterStoreKeysDTO = CombineKeysDTO('zinterstore', true);
export const ZDiffStoreKeysDTO = CombineKeysDTO('zdiffstore', true);

export const ZUnionDTO = CombineDTO('zunion', 'union', REPLY_MODE);
export const ZInterDTO = CombineDTO('zinter', 'inter', REPLY_MODE);
export const ZDiffDTO = CombineDTO('zdiff', 'diff', REPLY_MODE);
export const ZInterCardDTO = CombineDTO('zintercard', 'inter', CARD_MODE);
export const ZUnionStoreDTO = CombineStoreDTO('zunionstore', 'union');
export const ZInterStoreDTO = CombineStoreDTO('zinterstore', 'inter');
export const ZDiffStoreDTO = CombineStoreDTO('zdiffstore', 'diff');

// ============================================================================
// Type Exports
// ============================================================================

export type KeyInput = z.infer<typeof KeyDTO>;
export type KeyMemberInput = z.infer<typeof KeyMemberDTO>;
export type KeyMembersInput = z.infer<typeof KeyMembersDTO>;
export type ScoreRangeInput = z.infer<typeof ScoreRangeDTO>;
export type LexRangeInput = z.infer<typeof LexRangeDTO>;
export type ZAddInput = z.infer<typeof ZAddDTO>;
export type ZIncrByInput = z.infer<typeof ZIncrByDTO>;
export type ZRankInput = z.infer<typeof ZRankDTO>;
export type ZScanInput = z.infer<typeof ZScanDTO>;
export type ZRandMemberInput = z.infer<typeof ZRandMemberDTO>;
export type ZRangeInput = z.infer<typeof ZRangeDTO>;
export type ZRangeStoreInput = z.infer<typeof ZRangeStoreDTO>;
export type ZRemRangeByRankInput = z.infer<typeof ZRemRangeByRankDTO>;
export type ZPopInput = z.infer<typeof ZPopMinDTO>;
export type BZPopInput = z.infer<typeof BZPopMinDTO>;
export type ZMPopInput = z.infer<typeof ZMPopDTO>;
export type BZMPopInput = z.infer<typeof BZMPopDTO>;
export type CombineInput = z.infer<typeof ZUnionDTO>;
export type CombineStoreInput = z.infer<typeof ZUnionStoreDTO>;
