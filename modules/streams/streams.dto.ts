import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { RespMessages } from '@/libs/resp/messages';
import { IntegerSchema, IntegerSchemaWith, KeySchema, firstIssue, reject } from '@/libs/schemas';

import { TrimStrategyEnum, XGroupSubcommandEnum, XInfoSubcommandEnum } from './streams.enums';
import type { TrimStrategy, XGroupSubcommand, XInfoSubcommand } from './streams.enums';
import StreamsMessages from './streams.messages';
import { MAX_ID, U64_MAX, ZERO_ID, compareIds, nextId, parseStreamId, parseU64, prevId } from './streams.structure';
import type { ClaimDeliveryTime, StreamId, StreamIdToken } from './streams.types';

/**
 * Argument grammar of the stream commands. Each DTO parses the arguments after the command name (`args`), in command
 * order, so the first issue is the error Redis reports first. Option loops keep Redis's index arithmetic (they work on
 * the whole `args`, as t_stream.c does on argv). Checks that need the database stay in the services, and so do id
 * arguments Redis validates only after looking at the key: those are parsed into a {@link StreamIdToken} here and
 * reported by the service at the right moment.
 */

// ============================================================================
// Primitives
// ============================================================================

/** A strict stream id: `ms` or `ms-seq` (`-` and `+` rejected); a missing seq is `defaultSeq`. */
function StreamIdWithDefaultSeq(defaultSeq: bigint) {
  return z.string().transform((raw, ctx): StreamId => parseStreamId(raw, defaultSeq) ?? reject(ctx, StreamsMessages.ID_INVALID));
}

export const StreamIdSchema = StreamIdWithDefaultSeq(0n);
const StreamIdMaxSeqSchema = StreamIdWithDefaultSeq(U64_MAX);

/** Start of an interval (streamParseIntervalIDOrReply): `-`, `+`, `(id` (exclusive) or an id; a missing seq is 0. */
export const RangeStartSchema = z.string().transform((raw, ctx): StreamId => {
  if (raw === '-') return ZERO_ID;
  if (raw === '+') return MAX_ID;
  const exclusive = raw.length > 1 && raw.startsWith('(');
  const parsed = StreamIdSchema.safeParse(exclusive ? raw.slice(1) : raw);
  if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
  if (!exclusive) return parsed.data;
  return nextId(parsed.data) ?? reject(ctx, StreamsMessages.INVALID_START_ID);
});

/** End of an interval: like the start, but a missing seq is the largest one and `(id` steps back. */
export const RangeEndSchema = z.string().transform((raw, ctx): StreamId => {
  if (raw === '-') return ZERO_ID;
  if (raw === '+') return MAX_ID;
  const exclusive = raw.length > 1 && raw.startsWith('(');
  const parsed = StreamIdMaxSeqSchema.safeParse(exclusive ? raw.slice(1) : raw);
  if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
  if (!exclusive) return parsed.data;
  return prevId(parsed.data) ?? reject(ctx, StreamsMessages.INVALID_END_ID);
});

/** Tokenizes an id whose errors are reported later (see {@link StreamIdToken}). */
function idToken(raw: string): StreamIdToken {
  if (raw === '$') return { kind: 'last' };
  if (raw === '>') return { kind: 'new' };
  if (raw === '+') return { kind: 'max' };
  const id = parseStreamId(raw);
  return id ? { kind: 'id', id } : { kind: 'invalid' };
}

const KeyDTO = z.tuple([KeySchema]).transform(([key]) => ({ key }));

/** A container subcommand's arity check (Redis counts the command name: argc = args.length + 1). */
function subcommandArityOk(arity: number, args: string[]): boolean {
  const argc = args.length + 1;
  return arity > 0 ? argc === arity : argc >= -arity;
}

// ============================================================================
// Append DTOs: XADD, XTRIM, XDEL, XLEN
// ============================================================================

/**
 * The option loop of XADD and XTRIM (streamParseAddOrTrimArgsOrReply), over the whole `args` (key first). `limit` is
 * null when no LIMIT was given: the default of an approximate trim comes from the config, so the service fills it.
 */
function AddTrimSchema(xadd: boolean) {
  return z.array(z.string()).transform((args, ctx) => {
    let strategy: TrimStrategy | null = null;
    let maxlen = 0;
    let minid: StreamId = ZERO_ID;
    let approx = false;
    let limit = 0;
    let limitGiven = false;
    let noMkStream = false;
    let id: StreamId | null = null;
    let seqGiven = true;
    let i = 1;
    for (; i < args.length; i++) {
      const more = args.length - 1 - i;
      const opt = args[i].toLowerCase();
      const trim = TrimStrategyEnum.safeParse(opt);
      if (xadd && args[i] === '*') {
        break;
      } else if (trim.success && more) {
        if (strategy) return reject(ctx, StreamsMessages.MAXLEN_AND_MINID);
        approx = false;
        const next = args[i + 1];
        if (more >= 2 && next === '~') {
          approx = true;
          i++;
        } else if (more >= 2 && next === '=') {
          i++;
        }
        if (trim.data === 'maxlen') {
          const parsed = IntegerSchema.safeParse(args[i + 1]);
          if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
          maxlen = parsed.data;
          if (maxlen < 0) return reject(ctx, StreamsMessages.MAXLEN_NEGATIVE);
        } else {
          const parsed = StreamIdSchema.safeParse(args[i + 1]);
          if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
          minid = parsed.data;
        }
        i++;
        strategy = trim.data;
      } else if (opt === 'limit' && more) {
        const parsed = IntegerSchema.safeParse(args[i + 1]);
        if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
        limit = parsed.data;
        if (limit < 0) return reject(ctx, StreamsMessages.LIMIT_NEGATIVE);
        limitGiven = true;
        i++;
      } else if (xadd && opt === 'nomkstream') {
        noMkStream = true;
      } else if (xadd) {
        const m = /^(.*)-\*$/s.exec(args[i]);
        if (m) {
          const ms = parseU64(m[1]);
          if (ms === null) return reject(ctx, StreamsMessages.ID_INVALID);
          id = { ms, seq: 0n };
          seqGiven = false;
        } else {
          const parsed = StreamIdSchema.safeParse(args[i]);
          if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
          id = parsed.data;
        }
        break;
      } else {
        return reject(ctx, RespMessages.SYNTAX);
      }
    }
    if (limit && !strategy) return reject(ctx, StreamsMessages.LIMIT_WITHOUT_STRATEGY);
    if (!xadd && !strategy) return reject(ctx, StreamsMessages.XTRIM_WITHOUT_STRATEGY);
    if (limitGiven && !approx) return reject(ctx, StreamsMessages.LIMIT_WITHOUT_APPROX);
    return {
      key: args[0],
      trim: { strategy, maxlen, minid, approx, limit: limitGiven ? limit : null },
      noMkStream,
      id,
      seqGiven,
      /** XADD: the field-value pairs; their count is checked by XAddDTO, after the options. */
      fields: args.slice(i + 1),
    };
  });
}

/** XADD key [NOMKSTREAM] [MAXLEN|MINID [=|~] threshold [LIMIT count]] *|id field value [field value …] */
export const XAddDTO = AddTrimSchema(true).transform(({ trim, noMkStream, id, seqGiven, fields, key }, ctx) => {
  if (fields.length < 2 || fields.length % 2) return reject(ctx, formatMessage(RespMessages.WRONG_ARITY, { command: 'xadd' }));
  if (id && seqGiven && compareIds(id, ZERO_ID) === 0) return reject(ctx, StreamsMessages.ID_ZERO);
  return { key, trim, noMkStream, id, seqGiven, fields };
});

/** XTRIM key MAXLEN|MINID [=|~] threshold [LIMIT count] */
export const XTrimDTO = AddTrimSchema(false).transform(({ key, trim }) => ({ key, trim }));

/** XDEL key id [id …] (parsed only when the key exists: a missing key answers 0 whatever the ids). */
export const XDelDTO = z.tuple([KeySchema], StreamIdSchema).transform(([key, ...ids]) => ({ key, ids }));

export const XLenDTO = KeyDTO;

// ============================================================================
// Range DTOs: XRANGE, XREVRANGE
// ============================================================================

/** XRANGE key start end [COUNT n] / XREVRANGE key end start [COUNT n]: the start is always parsed first. */
function RangeDTO(rev: boolean) {
  return z.tuple([KeySchema, z.string(), z.string()], z.string()).transform(([key, first, second, ...options], ctx) => {
    const start = RangeStartSchema.safeParse(rev ? second : first);
    if (!start.success) return reject(ctx, firstIssue(start.error));
    const end = RangeEndSchema.safeParse(rev ? first : second);
    if (!end.success) return reject(ctx, firstIssue(end.error));
    /** -1 = no COUNT. */
    let count = -1;
    for (let j = 0; j < options.length; j++) {
      if (options[j].toLowerCase() === 'count' && j + 1 < options.length) {
        const parsed = IntegerSchema.safeParse(options[++j]);
        if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
        count = Math.max(0, parsed.data);
      } else {
        return reject(ctx, RespMessages.SYNTAX);
      }
    }
    return { key, start: start.data, end: end.data, count, rev };
  });
}

export const XRangeDTO = RangeDTO(false);
export const XRevRangeDTO = RangeDTO(true);

// ============================================================================
// Read DTOs: XREAD, XREADGROUP
// ============================================================================

const BlockMsSchema = IntegerSchemaWith(StreamsMessages.TIMEOUT_NOT_INTEGER);

/**
 * The option loop of xreadCommand, shared by XREAD and XREADGROUP:
 * [GROUP group consumer] [COUNT n] [BLOCK ms] [NOACK] STREAMS key [key …] id [id …]
 */
function ReadDTO(xreadgroup: boolean) {
  return z.array(z.string()).transform((args, ctx) => {
    let count: number | undefined;
    let block: number | null = null;
    let noAck = false;
    let group: string | null = null;
    let consumer = '';
    let streamsAt = -1;
    for (let i = 0; i < args.length; i++) {
      const more = args.length - 1 - i;
      const opt = args[i].toLowerCase();
      if (opt === 'block' && more) {
        const ms = BlockMsSchema.safeParse(args[++i]);
        if (!ms.success) return reject(ctx, firstIssue(ms.error));
        if (ms.data < 0) return reject(ctx, RespMessages.TIMEOUT_NEGATIVE);
        block = ms.data;
      } else if (opt === 'count' && more) {
        const n = IntegerSchema.safeParse(args[++i]);
        if (!n.success) return reject(ctx, firstIssue(n.error));
        count = Math.max(0, n.data) || undefined;
      } else if (opt === 'streams' && more) {
        streamsAt = i + 1;
        if ((args.length - streamsAt) % 2) {
          return reject(ctx, xreadgroup ? StreamsMessages.UNBALANCED_XREADGROUP : StreamsMessages.UNBALANCED_XREAD);
        }
        break;
      } else if (opt === 'group' && more >= 2) {
        if (!xreadgroup) return reject(ctx, StreamsMessages.GROUP_XREADGROUP_ONLY);
        group = args[i + 1];
        consumer = args[i + 2];
        i += 2;
      } else if (opt === 'noack') {
        if (!xreadgroup) return reject(ctx, StreamsMessages.NOACK_XREADGROUP_ONLY);
        noAck = true;
      } else {
        return reject(ctx, RespMessages.SYNTAX);
      }
    }
    if (streamsAt < 0) return reject(ctx, RespMessages.SYNTAX);
    if (xreadgroup && group === null) return reject(ctx, StreamsMessages.MISSING_GROUP);
    const n = (args.length - streamsAt) / 2;
    const keys = args.slice(streamsAt, streamsAt + n);
    const ids = args.slice(streamsAt + n).map(idToken);
    return { count, block, noAck, group: group ?? '', consumer, keys, ids };
  });
}

export const XReadDTO = ReadDTO(false);
export const XReadGroupDTO = ReadDTO(true);

// ============================================================================
// Pending DTOs: XACK, XPENDING, XCLAIM, XAUTOCLAIM
// ============================================================================

/** XACK key group id [id …] (parsed after the key's type check). */
export const XAckDTO = z.tuple([KeySchema, z.string()], StreamIdSchema).transform(([key, group, ...ids]) => ({ key, group, ids }));

/** XPENDING key group [[IDLE min-idle-time] start end count [consumer]] */
export const XPendingDTO = z.array(z.string()).transform((args, ctx) => {
  const argc = args.length + 1;
  if (argc > 3 && argc < 6) return reject(ctx, RespMessages.SYNTAX);
  let minIdle = 0;
  let start = ZERO_ID;
  let end = MAX_ID;
  let count = 0;
  let consumer: string | undefined;
  if (argc >= 6) {
    let i = 2;
    if (args[2].toLowerCase() === 'idle') {
      const idle = IntegerSchema.safeParse(args[3]);
      if (!idle.success) return reject(ctx, firstIssue(idle.error));
      minIdle = idle.data;
      if (argc < 8) return reject(ctx, RespMessages.SYNTAX);
      i += 2;
    }
    const n = IntegerSchema.safeParse(args[i + 2]);
    if (!n.success) return reject(ctx, firstIssue(n.error));
    count = Math.max(0, n.data);
    const from = RangeStartSchema.safeParse(args[i]);
    if (!from.success) return reject(ctx, firstIssue(from.error));
    start = from.data;
    const to = RangeEndSchema.safeParse(args[i + 1]);
    if (!to.success) return reject(ctx, firstIssue(to.error));
    end = to.data;
    consumer = args[i + 3];
  }
  return { key: args[0], group: args[1], summary: argc === 3, minIdle, start, end, count, consumer };
});

const XCLAIM_MIN_IDLE = IntegerSchemaWith(StreamsMessages.XCLAIM_MIN_IDLE_INVALID);
const XCLAIM_IDLE = IntegerSchemaWith(StreamsMessages.XCLAIM_IDLE_INVALID);
const XCLAIM_TIME = IntegerSchemaWith(StreamsMessages.XCLAIM_TIME_INVALID);
const XCLAIM_RETRYCOUNT = IntegerSchemaWith(StreamsMessages.XCLAIM_RETRYCOUNT_INVALID);

/**
 * XCLAIM key group consumer min-idle-time id [id …] [IDLE ms] [TIME unix-ms] [RETRYCOUNT n] [FORCE] [JUSTID]
 * [LASTID id] (parsed after the group lookup). The ids run until the first argument that is not an id.
 */
export const XClaimDTO = z.array(z.string()).transform((args, ctx) => {
  const [key, group, consumer, rawIdle] = args;
  const idle = XCLAIM_MIN_IDLE.safeParse(rawIdle);
  if (!idle.success) return reject(ctx, firstIssue(idle.error));
  const ids: StreamId[] = [];
  let i = 4;
  for (; i < args.length; i++) {
    const id = parseStreamId(args[i]);
    if (!id) break;
    ids.push(id);
  }
  let deliveryTime: ClaimDeliveryTime | null = null;
  let retryCount = -1;
  let force = false;
  let justId = false;
  let lastId = ZERO_ID;
  for (; i < args.length; i++) {
    const more = args.length - 1 - i;
    const opt = args[i].toLowerCase();
    if (opt === 'force') force = true;
    else if (opt === 'justid') justId = true;
    else if ((opt === 'idle' || opt === 'time' || opt === 'retrycount' || opt === 'lastid') && more) {
      const raw = args[++i];
      if (opt === 'lastid') {
        const id = StreamIdSchema.safeParse(raw);
        if (!id.success) return reject(ctx, firstIssue(id.error));
        lastId = id.data;
        continue;
      }
      const n = (opt === 'idle' ? XCLAIM_IDLE : opt === 'time' ? XCLAIM_TIME : XCLAIM_RETRYCOUNT).safeParse(raw);
      if (!n.success) return reject(ctx, firstIssue(n.error));
      if (opt === 'retrycount') retryCount = n.data;
      else deliveryTime = { kind: opt, ms: n.data };
    } else return reject(ctx, formatMessage(StreamsMessages.XCLAIM_UNKNOWN_OPTION, { option: args[i] }));
  }
  return { key, group, consumer, minIdle: Math.max(0, idle.data), ids, deliveryTime, retryCount, force, justId, lastId };
});

const XAUTOCLAIM_MIN_IDLE = IntegerSchemaWith(StreamsMessages.XAUTOCLAIM_MIN_IDLE_INVALID);
const XAUTOCLAIM_COUNT = IntegerSchemaWith(StreamsMessages.COUNT_NOT_POSITIVE);

/** XAUTOCLAIM key group consumer min-idle-time start [COUNT count] [JUSTID] */
export const XAutoClaimDTO = z.array(z.string()).transform((args, ctx) => {
  const [key, group, consumer, rawIdle, rawStart] = args;
  const idle = XAUTOCLAIM_MIN_IDLE.safeParse(rawIdle);
  if (!idle.success) return reject(ctx, firstIssue(idle.error));
  const start = RangeStartSchema.safeParse(rawStart);
  if (!start.success) return reject(ctx, firstIssue(start.error));
  let count = 100;
  let justId = false;
  for (let i = 5; i < args.length; i++) {
    const more = args.length - 1 - i;
    const opt = args[i].toLowerCase();
    if (opt === 'count' && more) {
      const n = XAUTOCLAIM_COUNT.safeParse(args[++i]);
      if (!n.success) return reject(ctx, firstIssue(n.error));
      count = n.data;
      if (count < 1 || count > Number.MAX_SAFE_INTEGER / 16) return reject(ctx, StreamsMessages.COUNT_NOT_POSITIVE);
    } else if (opt === 'justid') justId = true;
    else return reject(ctx, RespMessages.SYNTAX);
  }
  return { key, group, consumer, minIdle: Math.max(0, idle.data), start: start.data, count, justId };
});

// ============================================================================
// Group DTO: XGROUP
// ============================================================================

const XGROUP_ARITY: Record<XGroupSubcommand, number> = { create: -5, setid: -5, destroy: 4, createconsumer: 5, delconsumer: 5, help: 2 };

/** ENTRIESREAD's value: a non-negative counter, or -1 for "unknown" (null). */
const EntriesReadSchema = IntegerSchema.refine((n) => n >= 0 || n === -1, { error: StreamsMessages.ENTRIESREAD_INVALID }).transform(
  (n) => (n === -1 ? null : n),
);

/**
 * XGROUP CREATE key group id|$ [MKSTREAM] [ENTRIESREAD n] | SETID key group id|$ [ENTRIESREAD n] | DESTROY key group |
 * CREATECONSUMER key group consumer | DELCONSUMER key group consumer | HELP.
 * The id is a token: Redis checks the key and the group before it.
 */
export const XGroupDTO = z.array(z.string()).transform((args, ctx) => {
  const parsedSub = XGroupSubcommandEnum.safeParse(args[0].toLowerCase());
  if (!parsedSub.success) {
    return reject(ctx, formatMessage(RespMessages.UNKNOWN_SUBCOMMAND, { subcommand: args[0], command: 'XGROUP' }));
  }
  const sub = parsedSub.data;
  if (!subcommandArityOk(XGROUP_ARITY[sub], args)) return reject(ctx, formatMessage(RespMessages.WRONG_ARITY, { command: `xgroup|${sub}` }));
  const syntaxError = formatMessage(StreamsMessages.SUBCOMMAND_SYNTAX, { subcommand: args[0], command: 'XGROUP' });
  let mkStream = false;
  let entriesRead: number | null | undefined;
  if (sub === 'create') {
    for (let i = 4; i < args.length; ) {
      const opt = args[i].toLowerCase();
      if (opt === 'mkstream') {
        mkStream = true;
        i++;
      } else if (opt === 'entriesread' && i + 1 < args.length) {
        const n = EntriesReadSchema.safeParse(args[i + 1]);
        if (!n.success) return reject(ctx, firstIssue(n.error));
        entriesRead = n.data;
        i += 2;
      } else {
        return reject(ctx, syntaxError);
      }
    }
  } else if (sub === 'setid') {
    if (args.length === 6 && args[4].toLowerCase() === 'entriesread') {
      const n = EntriesReadSchema.safeParse(args[5]);
      if (!n.success) return reject(ctx, firstIssue(n.error));
      entriesRead = n.data;
    } else if (args.length !== 4) return reject(ctx, syntaxError);
  }
  const id = sub === 'create' || sub === 'setid' ? idToken(args[3]) : ({ kind: 'invalid' } as StreamIdToken);
  return { sub, key: args[1] ?? '', group: args[2] ?? '', id, consumer: args[3] ?? '', mkStream, entriesRead };
});

// ============================================================================
// Info DTOs: XINFO, XSETID
// ============================================================================

const XINFO_ARITY: Record<XInfoSubcommand, number> = { stream: -3, groups: 3, consumers: 4, help: 2 };

/** XINFO STREAM key [FULL [COUNT n]] | GROUPS key | CONSUMERS key group | HELP: the subcommand and its arity. */
export const XInfoDTO = z.array(z.string()).transform((args, ctx) => {
  const parsedSub = XInfoSubcommandEnum.safeParse(args[0].toLowerCase());
  if (!parsedSub.success) {
    return reject(ctx, formatMessage(RespMessages.UNKNOWN_SUBCOMMAND, { subcommand: args[0], command: 'XINFO' }));
  }
  const sub = parsedSub.data;
  if (!subcommandArityOk(XINFO_ARITY[sub], args)) return reject(ctx, formatMessage(RespMessages.WRONG_ARITY, { command: `xinfo|${sub}` }));
  return { sub, key: args[1] ?? '', group: args[2] ?? '' };
});

/** XINFO STREAM's options, parsed once the key was found: [FULL [COUNT n]] (whole `args`, subcommand first). */
export const XInfoStreamDTO = z.array(z.string()).transform((args, ctx) => {
  let full = false;
  let count = 10;
  if (args.length > 2) {
    if (args[2].toLowerCase() !== 'full') return reject(ctx, RespMessages.SYNTAX);
    full = true;
    if (args.length === 5 && args[3].toLowerCase() === 'count') {
      const n = IntegerSchema.safeParse(args[4]);
      if (!n.success) return reject(ctx, firstIssue(n.error));
      count = Math.max(0, n.data);
    } else if (args.length !== 3) return reject(ctx, RespMessages.SYNTAX);
  }
  return { full, count };
});

/** XSETID key last-id [ENTRIESADDED entries-added] [MAXDELETEDID max-deleted-id] */
export const XSetIdDTO = z.tuple([KeySchema, StreamIdSchema], z.string()).transform(([key, id, ...options], ctx) => {
  let entriesAdded = -1;
  let maxDeleted = ZERO_ID;
  for (let j = 0; j < options.length; j += 2) {
    const more = options.length - 1 - j;
    const opt = options[j].toLowerCase();
    if (opt === 'entriesadded' && more) {
      const n = IntegerSchema.safeParse(options[j + 1]);
      if (!n.success) return reject(ctx, firstIssue(n.error));
      entriesAdded = n.data;
      if (entriesAdded < 0) return reject(ctx, StreamsMessages.ENTRIES_ADDED_NEGATIVE);
    } else if (opt === 'maxdeletedid' && more) {
      const max = StreamIdSchema.safeParse(options[j + 1]);
      if (!max.success) return reject(ctx, firstIssue(max.error));
      maxDeleted = max.data;
      if (compareIds(id, maxDeleted) < 0) return reject(ctx, StreamsMessages.XSETID_BELOW_MAX_DELETED_ARG);
    } else {
      return reject(ctx, RespMessages.SYNTAX);
    }
  }
  return { key, id, entriesAdded, maxDeleted };
});

// ============================================================================
// Type Exports
// ============================================================================

export type KeyInput = z.infer<typeof KeyDTO>;
export type XAddInput = z.infer<typeof XAddDTO>;
export type XTrimInput = z.infer<typeof XTrimDTO>;
export type TrimOptions = XTrimInput['trim'];
export type XDelInput = z.infer<typeof XDelDTO>;
export type XRangeInput = z.infer<typeof XRangeDTO>;
export type XReadInput = z.infer<typeof XReadDTO>;
export type XAckInput = z.infer<typeof XAckDTO>;
export type XPendingInput = z.infer<typeof XPendingDTO>;
export type XClaimInput = z.infer<typeof XClaimDTO>;
export type XAutoClaimInput = z.infer<typeof XAutoClaimDTO>;
export type XGroupInput = z.infer<typeof XGroupDTO>;
export type XInfoInput = z.infer<typeof XInfoDTO>;
export type XInfoStreamInput = z.infer<typeof XInfoStreamDTO>;
export type XSetIdInput = z.infer<typeof XSetIdDTO>;
