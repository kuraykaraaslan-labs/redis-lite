import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { RespMessages } from '@/libs/resp/messages';
import { IntegerSchema, IntegerSchemaWith, firstIssue, reject } from '@/libs/schemas';

import CommandService from '@/modules/command/command.service';

import { FlushModeEnum, FunctionRestorePolicyEnum, FunctionSubcommandEnum, ScriptSubcommandEnum } from './scripting.enums';
import ScriptingMessages from './scripting.messages';

/**
 * Argument grammar of the scripting commands. Each DTO parses the arguments after the command name (`args`), in command
 * order, so the first issue is the error Redis reports first. Checks that need the server's state (a cached script, a
 * loaded library, a valid dump payload) stay in the services.
 */

// ============================================================================
// Shared Shapes
// ============================================================================

const WRONG_ARITY_SCRIPT_LOAD = formatMessage(RespMessages.WRONG_ARITY, { command: 'script|load' });
const WRONG_ARITY_FUNCTION_LOAD = formatMessage(RespMessages.WRONG_ARITY, { command: 'function|load' });

/**
 * `<head> numkeys key [key …] arg [arg …]` (EVAL, EVALSHA, FCALL and their _RO variants): numkeys must be an integer,
 * not negative, and not larger than the number of arguments that follow it. FCALL words a non-integer differently.
 */
function numKeysDTO(numkeys: z.ZodType<number, string>) {
  return z.tuple([z.string(), numkeys], z.string()).transform(([head, n, ...rest], ctx) => {
    if (n < 0) return reject(ctx, ScriptingMessages.NUMKEYS_NEGATIVE);
    if (n > rest.length) return reject(ctx, ScriptingMessages.NUMKEYS_GREATER);
    return { head, keys: rest.slice(0, n), argv: rest.slice(n) };
  });
}

/** `SCRIPT FLUSH` / `FUNCTION FLUSH` mode argument; null when absent. */
function flushMode(arg: string | undefined): 'sync' | 'async' | null | undefined {
  if (arg === undefined) return null;
  const mode = FlushModeEnum.safeParse(arg.toLowerCase());
  return mode.success ? mode.data : undefined;
}

// ============================================================================
// Script DTOs: EVAL, EVALSHA, SCRIPT
// ============================================================================

/** EVAL script numkeys key… arg… (also EVAL_RO). */
export const EvalDTO = numKeysDTO(IntegerSchema).transform(({ head, keys, argv }) => ({ script: head, keys, argv }));

/** EVALSHA sha1 numkeys key… arg… (also EVALSHA_RO); the sha is case-insensitive. */
export const EvalShaDTO = numKeysDTO(IntegerSchema).transform(({ head, keys, argv }) => ({
  sha: head.toLowerCase(),
  keys,
  argv,
}));

/** SCRIPT LOAD script | EXISTS sha… | FLUSH [SYNC|ASYNC] | KILL | HELP (the arities are checked by the dispatcher). */
export const ScriptDTO = z.tuple([z.string()], z.string()).transform(([sub, ...rest], ctx) => {
  const subcommand = ScriptSubcommandEnum.safeParse(sub.toLowerCase());
  if (!subcommand.success) {
    return reject(ctx, formatMessage(RespMessages.UNKNOWN_SUBCOMMAND, { subcommand: sub, command: 'SCRIPT' }));
  }
  switch (subcommand.data) {
    case 'load':
      if (rest.length !== 1) return reject(ctx, WRONG_ARITY_SCRIPT_LOAD);
      return { subcommand: 'load' as const, script: rest[0] };
    case 'exists':
      return { subcommand: 'exists' as const, shas: rest };
    case 'flush': {
      const mode = rest.length > 1 ? undefined : flushMode(rest[0]);
      if (mode === undefined) return reject(ctx, ScriptingMessages.SCRIPT_FLUSH_OPTION);
      return { subcommand: 'flush' as const, mode };
    }
    case 'kill':
      return { subcommand: 'kill' as const };
    case 'help':
      return { subcommand: 'help' as const };
  }
});

// ============================================================================
// Function DTOs: FCALL, FUNCTION
// ============================================================================

/**
 * FCALL function numkeys key… arg… (also FCALL_RO); a non-integer numkeys is "Bad number of keys provided". Redis looks
 * the function up first, so a numkeys problem is handed over as `numKeysError`, reported only once the function exists.
 */
const FcallNumKeysSchema = IntegerSchemaWith(ScriptingMessages.FCALL_BAD_NUMKEYS);
export const FcallDTO = z.tuple([z.string(), z.string()], z.string()).transform(([name, rawNumKeys, ...rest]) => {
  const parsed = FcallNumKeysSchema.safeParse(rawNumKeys);
  let numKeysError: string | null = null;
  if (!parsed.success) numKeysError = firstIssue(parsed.error);
  else if (parsed.data < 0) numKeysError = ScriptingMessages.NUMKEYS_NEGATIVE;
  else if (parsed.data > rest.length) numKeysError = ScriptingMessages.NUMKEYS_GREATER;
  const n = numKeysError ? 0 : (parsed.data as number);
  return { name, keys: rest.slice(0, n), argv: rest.slice(n), numKeysError };
});

/** FUNCTION LIST [LIBRARYNAME pattern] [WITHCODE], each option at most once. */
function parseListOptions(options: string[], ctx: z.core.$RefinementCtx) {
  let pattern: string | null = null;
  let withCode = false;
  for (let i = 0; i < options.length; i++) {
    const option = options[i].toLowerCase();
    if (option === 'withcode' && !withCode) withCode = true;
    else if (option === 'libraryname' && pattern === null) {
      if (i + 1 >= options.length) return reject(ctx, ScriptingMessages.FUNCTION_LIST_NO_LIBRARY_NAME);
      pattern = options[++i];
    } else return reject(ctx, formatMessage(ScriptingMessages.FUNCTION_LIST_UNKNOWN_ARGUMENT, { argument: options[i] }));
  }
  return { subcommand: 'list' as const, pattern: pattern ?? '*', withCode };
}

/** FUNCTION LOAD [REPLACE] code: the code is the last argument, every argument before it an option. */
function parseLoad(rest: string[], ctx: z.core.$RefinementCtx) {
  if (!rest.length) return reject(ctx, WRONG_ARITY_FUNCTION_LOAD);
  let replace = false;
  for (const option of rest.slice(0, -1)) {
    if (option.toLowerCase() !== 'replace') {
      return reject(ctx, formatMessage(ScriptingMessages.FUNCTION_LOAD_UNKNOWN_OPTION, { option }));
    }
    replace = true;
  }
  return { subcommand: 'load' as const, code: rest[rest.length - 1], replace };
}

/**
 * FUNCTION LOAD [REPLACE] code | DELETE name | FLUSH [SYNC|ASYNC] | LIST … | STATS | DUMP | RESTORE payload [policy] |
 * KILL | HELP. The arities are checked by the dispatcher; a missing DELETE name or RESTORE payload is an empty string
 * (the service then answers "not found" / "invalid payload").
 */
export const FunctionDTO = z.tuple([z.string()], z.string()).transform(([sub, ...rest], ctx) => {
  const subcommand = FunctionSubcommandEnum.safeParse(sub.toLowerCase());
  if (!subcommand.success) {
    return reject(ctx, formatMessage(RespMessages.UNKNOWN_SUBCOMMAND, { subcommand: sub, command: 'FUNCTION' }));
  }
  switch (subcommand.data) {
    case 'load':
      return parseLoad(rest, ctx);
    case 'delete':
      return { subcommand: 'delete' as const, library: rest[0] ?? '' };
    case 'list':
      return parseListOptions(rest, ctx);
    case 'flush': {
      if (rest.length > 1) return reject(ctx, CommandService.subcommandSyntaxMessage(sub, 'function'));
      const mode = flushMode(rest[0]);
      if (mode === undefined) return reject(ctx, ScriptingMessages.FUNCTION_FLUSH_OPTION);
      return { subcommand: 'flush' as const, mode };
    }
    case 'restore': {
      if (rest.length > 2) return reject(ctx, CommandService.subcommandSyntaxMessage(sub, 'function'));
      const policy = FunctionRestorePolicyEnum.safeParse((rest[1] ?? 'append').toLowerCase());
      if (!policy.success) return reject(ctx, ScriptingMessages.RESTORE_POLICY);
      return { subcommand: 'restore' as const, payload: rest[0] ?? '', policy: policy.data };
    }
    default:
      return { subcommand: subcommand.data };
  }
});

// ============================================================================
// Type Exports
// ============================================================================

export type EvalInput = z.infer<typeof EvalDTO>;
export type EvalShaInput = z.infer<typeof EvalShaDTO>;
export type ScriptInput = z.infer<typeof ScriptDTO>;
export type FcallInput = z.infer<typeof FcallDTO>;
export type FunctionInput = z.infer<typeof FunctionDTO>;
