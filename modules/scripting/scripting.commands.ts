import { validated, withDTO } from '@/modules/command/command.handler';
import type { CommandContext, CommandSpec, HandlerResult } from '@/modules/command/command.types';

import { EvalDTO, EvalShaDTO, ScriptDTO } from './scripting.dto';
import ScriptingService from './scripting.service';

/**
 * Routing of EVAL, EVALSHA (and their _RO variants) and SCRIPT: name, arity, flags, then DTO → service. No logic.
 *
 * EVAL caches its script before parsing numkeys, and EVALSHA looks its script up first (NOSCRIPT beats a bad numkeys),
 * because Redis does: both call the service's first step, then `validated()`, then the service.
 */

const NOSCRIPT = { noscript: true } as const;

/** EVAL / EVAL_RO: cache first, then parse, then run. */
function evalHandler(readOnly: boolean): CommandSpec['handler'] {
  return (ctx: CommandContext, args: string[]): HandlerResult => {
    const sha = ScriptingService.cacheScript(ctx, args[0]);
    return validated(EvalDTO, args, (input) => ScriptingService.eval(ctx, sha, input, readOnly));
  };
}

/** EVALSHA / EVALSHA_RO: read first (NOSCRIPT beats a bad numkeys), then parse, then run. */
function evalShaHandler(readOnly: boolean): CommandSpec['handler'] {
  return (ctx: CommandContext, args: string[]): HandlerResult => {
    const body = ScriptingService.cachedScript(ctx, args[0]);
    return validated(EvalShaDTO, args, (input) => ScriptingService.evalSha(ctx, body, input, readOnly));
  };
}

export const scriptingCommands: CommandSpec[] = [
  { name: 'eval', arity: -3, flags: NOSCRIPT, handler: evalHandler(false) },
  { name: 'evalsha', arity: -3, flags: NOSCRIPT, handler: evalShaHandler(false) },
  { name: 'eval_ro', arity: -3, flags: NOSCRIPT, handler: evalHandler(true) },
  { name: 'evalsha_ro', arity: -3, flags: NOSCRIPT, handler: evalShaHandler(true) },
  { name: 'script', arity: -2, flags: NOSCRIPT, handler: withDTO(ScriptDTO, ScriptingService.script) },
];
