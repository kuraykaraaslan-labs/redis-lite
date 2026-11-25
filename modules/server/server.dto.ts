import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { isInteger } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';
import { IntegerSchema, firstIssue, reject } from '@/libs/schemas';

import { SubcommandSchema } from '@/modules/command/command.dto';
import CommandService from '@/modules/command/command.service';

import { REDIS_VERSION } from './server.constants';
import { CommandFilterEnum, ShutdownFlagEnum } from './server.enums';
import ServerMessages from './server.messages';

/**
 * Argument grammar of the server commands. Container DTOs (CONFIG, ACL, MEMORY, DEBUG…) parse the whole `args`,
 * subcommand included: their argument-count errors quote the subcommand as typed. Checks that need the server state
 * (config names, users, keys, the ACL file) stay in the services.
 */

// ============================================================================
// Shared Schemas
// ============================================================================

/** A strict Redis integer whose error text is command specific. */
function IntegerArgSchema(message: string) {
  return z
    .string()
    .refine(isInteger, { error: message })
    .transform((value) => Number(value));
}

/** A WAIT / WAITAOF timeout in ms: an integer, not negative. */
const WaitTimeoutSchema = IntegerArgSchema(ServerMessages.TIMEOUT_NOT_INTEGER).refine((ms) => ms >= 0, { error: ServerMessages.TIMEOUT_NEGATIVE });

/** A count that must not be negative (WAITAOF numlocal / numreplicas, DEBUG POPULATE). */
const NonNegativeSchema = IntegerSchema.refine((n) => n >= 0, { error: RespMessages.COUNT_POSITIVE });

const SlowlogCountSchema = IntegerArgSchema(ServerMessages.SLOWLOG_COUNT).refine((n) => n >= -1, { error: ServerMessages.SLOWLOG_COUNT });

/** Redis addReplySubcommandSyntaxError() text, the subcommand as typed. */
function syntax(sub: string, command: string): string {
  return CommandService.subcommandSyntaxMessage(sub, command);
}

/** A subcommand taking `min`..`max` arguments after it; any other count is a subcommand syntax error. */
function SubcommandArgsDTO(command: string, min: number, max = min) {
  return z.array(z.string()).transform((args, ctx) => {
    const n = args.length - 1;
    return n < min || n > max ? reject(ctx, syntax(args[0], command)) : { args: args.slice(1) };
  });
}

/** Parses `raw` with `schema` inside a transform; the parsed value, or the first issue as `{ error }`. */
function parseWith<T>(schema: z.ZodType<T>, raw: string): { value: T } | { error: string } {
  const parsed = schema.safeParse(raw);
  return parsed.success ? { value: parsed.data } : { error: firstIssue(parsed.error) };
}

// ============================================================================
// Info and Config DTOs: INFO, CONFIG GET / SET
// ============================================================================

export const InfoDTO = z.array(z.string()).transform((args) => ({ sections: new Set(args.map((a) => a.toLowerCase())) }));

export const ConfigGetDTO = z.tuple([SubcommandSchema], z.string()).transform(([, ...patterns]) => ({ patterns }));

const CONFIG_SET_ARITY = formatMessage(RespMessages.WRONG_ARITY, { command: 'config|set' });

/** CONFIG SET name value [name value …]: an odd count is CONFIG SET's own arity error. */
export const ConfigSetDTO = z.tuple([SubcommandSchema], z.string()).transform(([, ...rest], ctx) => {
  if (rest.length % 2) return reject(ctx, CONFIG_SET_ARITY);
  const pairs: Array<[name: string, value: string]> = [];
  for (let i = 0; i < rest.length; i += 2) pairs.push([rest[i], rest[i + 1]]);
  return { pairs };
});

// ============================================================================
// Command DTOs: COMMAND LIST / INFO / DOCS / GETKEYS
// ============================================================================

/** COMMAND LIST [FILTERBY MODULE name | ACLCAT category | PATTERN pattern] */
export const CommandListDTO = z.array(z.string()).transform((args, ctx) => {
  if (args.length === 1) return { filter: null };
  if (args.length !== 4 || args[1].toLowerCase() !== 'filterby') return reject(ctx, RespMessages.SYNTAX);
  const kind = CommandFilterEnum.safeParse(args[2].toLowerCase());
  if (!kind.success) return reject(ctx, RespMessages.SYNTAX);
  return { filter: { kind: kind.data, value: args[3] } };
});

/** COMMAND INFO / DOCS [name …]: no names = every command. */
export const CommandNamesDTO = z.tuple([SubcommandSchema], z.string()).transform(([, ...names]) => ({ names }));

/** COMMAND GETKEYS / GETKEYSANDFLAGS command [arg …] */
export const CommandGetKeysDTO = z.tuple([SubcommandSchema], z.string()).transform(([, ...argv]) => ({ argv }));

// ============================================================================
// ACL DTOs
// ============================================================================

export const AclNoArgsDTO = SubcommandArgsDTO('acl', 0);

export const AclSetUserDTO = z.array(z.string()).transform((args, ctx) =>
  args.length < 2 ? reject(ctx, syntax(args[0], 'acl')) : { username: args[1], rules: args.slice(2) },
);

export const AclDelUserDTO = z.array(z.string()).transform((args, ctx) =>
  args.length < 2 ? reject(ctx, syntax(args[0], 'acl')) : { usernames: args.slice(1) },
);

export const AclGetUserDTO = SubcommandArgsDTO('acl', 1).transform(({ args }) => ({ username: args[0] }));

export const AclCatDTO = SubcommandArgsDTO('acl', 0, 1).transform(({ args }) => ({ category: args[0] ?? null }));

/** ACL LOG [count | RESET]: a negative count is 0. */
export const AclLogDTO = SubcommandArgsDTO('acl', 0, 1).transform(({ args }, ctx) => {
  if (!args.length) return { reset: false, count: 10 };
  if (args[0].toLowerCase() === 'reset') return { reset: true, count: 0 };
  const count = parseWith(IntegerSchema, args[0]);
  return 'error' in count ? reject(ctx, count.error) : { reset: false, count: Math.max(0, count.value) };
});

export const AclDryRunDTO = z.array(z.string()).transform((args, ctx) =>
  args.length < 3 ? reject(ctx, syntax(args[0], 'acl')) : { username: args[1], argv: args.slice(2) },
);

export const AclGenPassDTO = SubcommandArgsDTO('acl', 0, 1).transform(({ args }, ctx) => {
  if (!args.length) return { bits: 256 };
  const bits = parseWith(IntegerSchema, args[0]);
  return 'error' in bits ? reject(ctx, bits.error) : { bits: bits.value };
});

// ============================================================================
// Diagnostics DTOs: SLOWLOG, LATENCY, MEMORY
// ============================================================================

/** SLOWLOG GET [count]: 10 by default, -1 = every entry. */
export const SlowlogGetDTO = SubcommandArgsDTO('slowlog', 0, 1).transform(({ args }, ctx) => {
  if (!args.length) return { count: 10 };
  const count = parseWith(SlowlogCountSchema, args[0]);
  return 'error' in count ? reject(ctx, count.error) : { count: count.value };
});

export const LatencyEventDTO = z.tuple([SubcommandSchema, z.string()]).transform(([, event]) => ({ event }));

export const MemoryNoArgsDTO = SubcommandArgsDTO('memory', 0);

/** MEMORY USAGE key [SAMPLES count]: SAMPLES 0 = every element. */
export const MemoryUsageDTO = z.array(z.string()).transform((args, ctx) => {
  if (args.length < 2) return reject(ctx, syntax(args[0], 'memory'));
  let samples = 5;
  for (let j = 2; j < args.length; j++) {
    if (args[j].toLowerCase() === 'samples' && j + 1 < args.length) {
      const n = parseWith(IntegerSchema, args[j + 1]);
      if ('error' in n) return reject(ctx, n.error);
      if (n.value < 0) return reject(ctx, RespMessages.SYNTAX);
      samples = n.value;
      j++;
    } else return reject(ctx, RespMessages.SYNTAX);
  }
  return { key: args[1], samples };
});

// ============================================================================
// Debug DTOs
// ============================================================================

export const DebugNoArgsDTO = SubcommandArgsDTO('debug', 0);

/** DEBUG subcommands taking exactly one argument that is not interpreted (LOG, SET-SKIP-CHECKSUM-VALIDATION…). */
export const DebugOneArgDTO = SubcommandArgsDTO('debug', 1).transform(({ args }) => ({ value: args[0] }));

export const DebugObjectDTO = SubcommandArgsDTO('debug', 1, 2).transform(({ args }) => ({
  key: args[0],
  fast: args.length === 2 && args[1].toLowerCase() === 'fast',
}));

/** DEBUG SLEEP seconds: Redis reads it with strtod(), no validation (garbage sleeps 0). */
export const DebugSleepDTO = SubcommandArgsDTO('debug', 1).transform(({ args }) => {
  const seconds = Number.parseFloat(args[0]);
  return { ms: Number.isFinite(seconds) ? seconds * 1000 : 0 };
});

export const DebugActiveExpireDTO = SubcommandArgsDTO('debug', 1).transform(({ args }) => ({
  enabled: Number.parseInt(args[0], 10) !== 0 && !Number.isNaN(Number.parseInt(args[0], 10)),
}));

const MEMORY_UNITS: Record<string, number> = { b: 1, k: 1e3, kb: 1024, m: 1e6, mb: 1048576, g: 1e9, gb: 1073741824 };

/** DEBUG QUICKLIST-PACKED-THRESHOLD size: 0 restores the default, otherwise at most 4GB (the threshold is not modelled). */
export const DebugPackedThresholdDTO = SubcommandArgsDTO('debug', 1).transform(({ args }, ctx) => {
  const m = /^(\d+)(b|k|kb|m|mb|g|gb)?$/i.exec(args[0]);
  const size = m ? Number(m[1]) * MEMORY_UNITS[(m[2] ?? 'b').toLowerCase()] : NaN;
  return !m || size > 2 ** 32 ? reject(ctx, ServerMessages.DEBUG_PACKED_THRESHOLD) : { size };
});

export const DebugListpackDTO = SubcommandArgsDTO('debug', 1).transform(({ args }) => ({ key: args[0] }));

export const DebugQuicklistDTO = SubcommandArgsDTO('debug', 1, 2).transform(({ args }) => ({ key: args[0] }));

/** DEBUG POPULATE count [prefix] [size]: `<prefix>:<n>` = `value:<n>`, padded / cut to `size`. */
export const DebugPopulateDTO = SubcommandArgsDTO('debug', 1, 3).transform(({ args }, ctx) => {
  const count = parseWith(NonNegativeSchema, args[0]);
  if ('error' in count) return reject(ctx, count.error);
  const prefix = args.length >= 2 ? args[1] : 'key';
  if (args.length < 3) return { count: count.value, prefix, size: 0 };
  const size = parseWith(NonNegativeSchema, args[2]);
  return 'error' in size ? reject(ctx, size.error) : { count: count.value, prefix, size: size.value };
});

/** DEBUG RELOAD [option …]: the options are read by the reload hook. */
export const DebugReloadDTO = z.tuple([SubcommandSchema], z.string()).transform(([, ...options]) => ({ options }));

// ============================================================================
// Admin DTOs: FLUSHDB / FLUSHALL, SHUTDOWN, BGSAVE, WAIT, WAITAOF, LOLWUT
// ============================================================================

/** FLUSHDB / FLUSHALL [ASYNC | SYNC]: both modes flush at once. */
export const FlushDTO = z.array(z.string()).transform((args, ctx) => {
  if (args.length > 1) return reject(ctx, RespMessages.SYNTAX);
  if (args.length === 1 && !['async', 'sync'].includes(args[0].toLowerCase())) return reject(ctx, RespMessages.SYNTAX);
  return {};
});

/** SHUTDOWN [NOSAVE | SAVE] [NOW] [FORCE] [ABORT] */
export const ShutdownDTO = z.array(z.string()).transform((args, ctx) => {
  const opts = { save: false, nosave: false, now: false, force: false, abort: false };
  for (const a of args) {
    const flag = ShutdownFlagEnum.safeParse(a.toLowerCase());
    if (!flag.success) return reject(ctx, RespMessages.SYNTAX);
    opts[flag.data] = true;
  }
  if ((opts.save && opts.nosave) || (opts.abort && args.length > 1)) return reject(ctx, RespMessages.SYNTAX);
  return opts;
});

export const BgsaveDTO = z.array(z.string()).transform((args, ctx) => {
  if (args.length > 1 || (args.length === 1 && args[0].toLowerCase() !== 'schedule')) return reject(ctx, RespMessages.SYNTAX);
  return { schedule: args.length === 1 };
});

/** WAIT numreplicas timeout: the timeout is checked first, as in Redis. */
export const WaitDTO = z.tuple([z.string(), z.string()]).transform(([rawReplicas, rawTimeout], ctx) => {
  const timeout = parseWith(WaitTimeoutSchema, rawTimeout);
  if ('error' in timeout) return reject(ctx, timeout.error);
  const numreplicas = parseWith(IntegerSchema, rawReplicas);
  return 'error' in numreplicas ? reject(ctx, numreplicas.error) : { numreplicas: numreplicas.value, timeout: timeout.value };
});

/** WAITAOF numlocal numreplicas timeout: the timeout is checked first, as in Redis. */
export const WaitAofDTO = z.tuple([z.string(), z.string(), z.string()]).transform(([rawLocal, rawReplicas, rawTimeout], ctx) => {
  const timeout = parseWith(WaitTimeoutSchema, rawTimeout);
  if ('error' in timeout) return reject(ctx, timeout.error);
  const numlocal = parseWith(NonNegativeSchema, rawLocal);
  if ('error' in numlocal) return reject(ctx, numlocal.error);
  const numreplicas = parseWith(NonNegativeSchema, rawReplicas);
  if ('error' in numreplicas) return reject(ctx, numreplicas.error);
  return { numlocal: numlocal.value, numreplicas: numreplicas.value, timeout: timeout.value };
});

/** LOLWUT [VERSION version] [art options…]: version 5 takes columns, squares per row and per column (clamped). */
export const LolwutDTO = z.array(z.string()).transform((args, ctx) => {
  let version = Number(REDIS_VERSION.split('.')[0]);
  let rest = args;
  if (args.length >= 2 && args[0].toLowerCase() === 'version') {
    const v = parseWith(IntegerSchema, args[1]);
    if ('error' in v) return reject(ctx, v.error);
    version = v.value;
    rest = args.slice(2);
  }
  if (version !== 5) return { version, cols: 0, perRow: 0, perCol: 0 };
  const dims: number[] = [];
  for (const [i, def, max] of [[0, 66, 1000], [1, 8, 200], [2, 12, 200]]) {
    if (rest[i] === undefined) {
      dims.push(def);
      continue;
    }
    const n = parseWith(IntegerSchema, rest[i]);
    if ('error' in n) return reject(ctx, n.error);
    dims.push(Math.min(Math.max(n.value, 1), max));
  }
  return { version, cols: dims[0], perRow: dims[1], perCol: dims[2] };
});

// ============================================================================
// Type Exports
// ============================================================================

export type InfoInput = z.infer<typeof InfoDTO>;
export type ConfigGetInput = z.infer<typeof ConfigGetDTO>;
export type ConfigSetInput = z.infer<typeof ConfigSetDTO>;
export type CommandListInput = z.infer<typeof CommandListDTO>;
export type CommandNamesInput = z.infer<typeof CommandNamesDTO>;
export type CommandGetKeysInput = z.infer<typeof CommandGetKeysDTO>;
export type AclSetUserInput = z.infer<typeof AclSetUserDTO>;
export type AclDelUserInput = z.infer<typeof AclDelUserDTO>;
export type AclGetUserInput = z.infer<typeof AclGetUserDTO>;
export type AclCatInput = z.infer<typeof AclCatDTO>;
export type AclLogInput = z.infer<typeof AclLogDTO>;
export type AclDryRunInput = z.infer<typeof AclDryRunDTO>;
export type AclGenPassInput = z.infer<typeof AclGenPassDTO>;
export type SlowlogGetInput = z.infer<typeof SlowlogGetDTO>;
export type LatencyEventInput = z.infer<typeof LatencyEventDTO>;
export type MemoryUsageInput = z.infer<typeof MemoryUsageDTO>;
export type DebugOneArgInput = z.infer<typeof DebugOneArgDTO>;
export type DebugObjectInput = z.infer<typeof DebugObjectDTO>;
export type DebugSleepInput = z.infer<typeof DebugSleepDTO>;
export type DebugActiveExpireInput = z.infer<typeof DebugActiveExpireDTO>;
export type DebugKeyInput = z.infer<typeof DebugListpackDTO>;
export type DebugPopulateInput = z.infer<typeof DebugPopulateDTO>;
export type DebugReloadInput = z.infer<typeof DebugReloadDTO>;
export type ShutdownInput = z.infer<typeof ShutdownDTO>;
export type BgsaveInput = z.infer<typeof BgsaveDTO>;
export type WaitInput = z.infer<typeof WaitDTO>;
export type WaitAofInput = z.infer<typeof WaitAofDTO>;
export type LolwutInput = z.infer<typeof LolwutDTO>;
