import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { RespMessages } from '@/libs/resp/messages';
import { IntegerSchema, reject } from '@/libs/schemas';

import { FunctionRestorePolicyEnum, FunctionSubcommandEnum, ScriptSubcommandEnum } from './scripting.enums';
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
 * not negative, and not larger than the number of arguments that follow it.
 */
const NumKeysDTO = z.tuple([z.string(), IntegerSchema], z.string()).transform(([head, numkeys, ...rest], ctx) => {
  if (numkeys < 0) return reject(ctx, ScriptingMessages.NUMKEYS_NEGATIVE);
  if (numkeys > rest.length) return reject(ctx, ScriptingMessages.NUMKEYS_GREATER);
  return { head, keys: rest.slice(0, numkeys), argv: rest.slice(numkeys) };
});

// ============================================================================
// Script DTOs: EVAL, EVALSHA, SCRIPT
// ============================================================================

/** EVAL script numkeys key… arg… (also EVAL_RO). */
export const EvalDTO = NumKeysDTO.transform(({ head, keys, argv }) => ({ script: head, keys, argv }));

/** EVALSHA sha1 numkeys key… arg… (also EVALSHA_RO); the sha is case-insensitive. */
export const EvalShaDTO = NumKeysDTO.transform(({ head, keys, argv }) => ({ sha: head.toLowerCase(), keys, argv }));

/** SCRIPT LOAD script | EXISTS sha… | FLUSH [mode] | KILL. Extra arguments of FLUSH and KILL are ignored. */
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
    case 'flush':
      return { subcommand: 'flush' as const };
    case 'kill':
      return { subcommand: 'kill' as const };
  }
});

// ============================================================================
// Function DTOs: FCALL, FUNCTION
// ============================================================================

/** FCALL function numkeys key… arg… (also FCALL_RO). */
export const FcallDTO = NumKeysDTO.transform(({ head, keys, argv }) => ({ name: head, keys, argv }));

/** FUNCTION LIST [LIBRARYNAME pattern] [WITHCODE], options read left to right. */
function parseListOptions(options: string[], ctx: z.core.$RefinementCtx) {
  let pattern = '*';
  let withCode = false;
  for (let i = 0; i < options.length; i++) {
    const option = options[i].toLowerCase();
    if (option === 'libraryname' && i + 1 < options.length) pattern = options[++i];
    else if (option === 'withcode') withCode = true;
    else return reject(ctx, RespMessages.SYNTAX);
  }
  return { subcommand: 'list' as const, pattern, withCode };
}

/**
 * FUNCTION LOAD [REPLACE] code | DELETE name | FLUSH | LIST … | STATS | DUMP | RESTORE payload [policy] | KILL | HELP.
 * A missing DELETE name or RESTORE payload is an empty string: the service then answers "not found" / "invalid payload".
 */
export const FunctionDTO = z.tuple([z.string()], z.string()).transform(([sub, ...rest], ctx) => {
  const subcommand = FunctionSubcommandEnum.safeParse(sub.toLowerCase());
  if (!subcommand.success) {
    return reject(ctx, formatMessage(RespMessages.UNKNOWN_SUBCOMMAND, { subcommand: sub, command: 'FUNCTION' }));
  }
  switch (subcommand.data) {
    case 'load': {
      const replace = rest[0]?.toLowerCase() === 'replace';
      const code = rest[replace ? 1 : 0];
      if (code === undefined || rest.length > (replace ? 2 : 1)) return reject(ctx, WRONG_ARITY_FUNCTION_LOAD);
      return { subcommand: 'load' as const, code, replace };
    }
    case 'delete':
      return { subcommand: 'delete' as const, library: rest[0] ?? '' };
    case 'list':
      return parseListOptions(rest, ctx);
    case 'restore': {
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
