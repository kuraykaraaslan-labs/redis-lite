import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { EvalInput, EvalShaInput, ScriptInput } from './scripting.dto';
import { LuaEngine } from './scripting.engine';
import ScriptingMessages from './scripting.messages';

/** Scripts: EVAL, EVALSHA (and their _RO variants) and SCRIPT LOAD / EXISTS / FLUSH / KILL. */
export default class ScriptingScriptsService {
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
  static eval(ctx: CommandContext, sha: string, { script, keys, argv }: EvalInput, readOnly = false): Reply {
    return ctx.server.lua.run(ctx.client, sha, script, keys, argv, readOnly);
  }

  /** EVALSHA / EVALSHA_RO of `body` (read first, see cachedScript). */
  static evalSha(ctx: CommandContext, body: string, { sha, keys, argv }: EvalShaInput, readOnly = false): Reply {
    return ctx.server.lua.run(ctx.client, sha, body, keys, argv, readOnly);
  }

  /** SCRIPT LOAD compiles before caching (a syntax error caches nothing); KILL: no script ever runs concurrently. */
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
      case 'kill':
        throw new AppError(ScriptingMessages.NOTBUSY);
    }
  }
}
