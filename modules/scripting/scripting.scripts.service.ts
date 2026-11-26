import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
import type { CommandContext, HandlerResult } from '@/modules/command/command.types';

import type { EvalInput, EvalShaInput, ScriptInput } from './scripting.dto';
import { LuaEngine } from './scripting.engine';
import type { ScriptCall } from './scripting.engine';
import ScriptingMessages from './scripting.messages';

/** Scripts: EVAL, EVALSHA (and their _RO variants) and SCRIPT LOAD / EXISTS / FLUSH / KILL / HELP. */
export default class ScriptingScriptsService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Who runs the script; a top-level command (not EXEC, not a script) may be suspended while busy. */
  private static call(ctx: CommandContext, command: string[], readOnly: boolean): ScriptCall {
    return { client: ctx.client, command, readOnly, topLevel: !ctx.noBlock && !ctx.inScript };
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Caches the body of an EVAL (before its arguments are parsed, as Redis does) and returns its sha1. */
  static cacheScript(ctx: CommandContext, script: string): string {
    const sha = LuaEngine.sha1hex(script);
    ctx.server.scripts.set(sha, script);
    return sha;
  }

  /** The body of a cached script, read before EVALSHA's arguments are parsed: NOSCRIPT beats a bad numkeys. */
  static cachedScript(ctx: CommandContext, sha: string): string {
    const body = ctx.server.scripts.get(sha.toLowerCase());
    if (body === undefined) throw new AppError(ScriptingMessages.NOSCRIPT);
    return body;
  }

  /** EVAL / EVAL_RO of the script cached as `sha`. */
  static eval(ctx: CommandContext, sha: string, { script, keys, argv }: EvalInput, readOnly = false): HandlerResult {
    const command = [ctx.name ?? 'EVAL', script, String(keys.length), ...keys, ...argv];
    return ctx.server.lua.run(ScriptingScriptsService.call(ctx, command, readOnly), sha, script, keys, argv);
  }

  /** EVALSHA / EVALSHA_RO of `body` (read first, see cachedScript). */
  static evalSha(ctx: CommandContext, body: string, { sha, keys, argv }: EvalShaInput, readOnly = false): HandlerResult {
    const command = [ctx.name ?? 'EVALSHA', sha, String(keys.length), ...keys, ...argv];
    return ctx.server.lua.run(ScriptingScriptsService.call(ctx, command, readOnly), sha, body, keys, argv);
  }

  /** SCRIPT LOAD compiles before caching (a syntax error caches nothing); KILL stops a busy script. */
  static script(ctx: CommandContext, input: ScriptInput): Reply {
    switch (input.subcommand) {
      case 'load': {
        const sha = LuaEngine.sha1hex(input.script);
        ctx.server.lua.compile(sha, input.script);
        ctx.server.scripts.set(sha, input.script);
        return sha;
      }
      case 'exists':
        return input.shas.map((sha) => (ctx.server.scripts.has(sha.toLowerCase()) ? 1 : 0));
      case 'flush':
        ctx.server.scripts.clear();
        ctx.server.lua.flush();
        return OK;
      case 'kill': {
        const refused = ctx.server.lua.kill('eval');
        if (refused) return refused;
        return OK;
      }
      case 'help':
        return CommandService.helpReply('script', ScriptingMessages.SCRIPT_HELP);
    }
  }
}
