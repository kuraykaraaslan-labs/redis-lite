import { createHash } from 'node:crypto';

import { NULL_ARRAY, RespError, toResp2 } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService, { Block, NO_REPLY } from '@/modules/command/command.service';
import { COMMANDS } from '@/modules/command/command.registry';
import type { RedisLiteServer } from '@/modules/server/server.service';

import LuaReplyConverter from './scripting.convert.engine';
import { IGNORE_ERROR_STATS, LuaType } from './scripting.enums';
import ScriptingMessages from './scripting.messages';
import type LuaStack from './scripting.stack.engine';
import type { LuaState, ScriptState } from './scripting.types';

/**
 * The host functions of the Lua state, registered as globals before the prelude runs (it captures them in locals and
 * removes the globals): `redis.call` / `redis.pcall` (`__redis_call`, `__redis_pcall`), `redis.acl_check_cmd`,
 * `__redis_setresp`, `__redis_sha1hex`, and `__rl_to51` (Lua 5.4 → 5.1 error texts for the prelude's pcall).
 *
 * redis.call and acl_check_cmd raise their errors with lua_error() themselves (a C function, like in Redis), so the
 * caller's frame stays on the stack; lua_error() never returns, so it is only called outside try blocks.
 */
export default class LuaRedisBridge {
  constructor(
    private readonly server: RedisLiteServer,
    private readonly stack: LuaStack,
    private readonly converter: LuaReplyConverter,
    private readonly script: ScriptState,
  ) {}

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** An exception caught in a host function, as the error the script sees. */
  private static exceptionError(error: unknown): RespError {
    return new RespError(`ERR ${(error as Error).message}`);
  }

  /** The arguments of a redis lib call as strings, or the error Redis raises for them. */
  private readCallArgs(Ls: LuaState): string[] | RespError {
    const { lw } = this.stack;
    const n = lw.lua_gettop(Ls);
    if (n === 0) return new RespError(ScriptingMessages.CALL_NO_ARGUMENTS);
    const argv: string[] = [];
    for (let i = 1; i <= n; i++) {
      const t = lw.lua_type(Ls, i);
      if (t === LuaType.STRING) argv.push(this.stack.readBytes(Ls, i));
      else if (t === LuaType.NUMBER) {
        argv.push(LuaReplyConverter.formatNumber(lw.lua_tonumberx(Ls, i, null)));
      } else return new RespError(ScriptingMessages.CALL_BAD_ARGUMENT);
    }
    return argv;
  }

  /** A known command with a valid arity that Redis flags `write` (unknown/arity/noscript errors are left to execute()). */
  private static isWriteCommand(argv: string[]): boolean {
    const spec = COMMANDS.get(argv[0].toLowerCase());
    if (!spec?.flags?.write || spec.flags.noscript) return false;
    return spec.arity > 0 ? argv.length === spec.arity : argv.length >= -spec.arity;
  }

  /**
   * Runs the command of a redis.call / redis.pcall: its reply, or the error the script gets. `fromCommand`: the error
   * came from the command (refused or failed), not from the call's arguments; it is counted in INFO errorstats now.
   */
  private runCommand(Ls: LuaState): { reply: Reply; fromCommand: boolean } {
    try {
      const argv = this.readCallArgs(Ls);
      if (argv instanceof RespError) return { reply: argv, fromCommand: false };
      const client = this.script.client;
      if (!client) return { reply: new RespError(ScriptingMessages.CALL_OUTSIDE_SCRIPT), fromCommand: false };
      const write = LuaRedisBridge.isWriteCommand(argv);
      let reply: Reply;
      if (write && this.script.readOnly) reply = new RespError(ScriptingMessages.READ_ONLY_SCRIPT);
      else {
        if (write) this.script.wrote = true;
        const result = this.server.execute(client, argv, { inScript: true, noBlock: true });
        reply = result instanceof Block || result === NO_REPLY ? NULL_ARRAY : result;
      }
      if (reply instanceof RespError) this.server.countError(reply.message);
      return { reply, fromCommand: true };
    } catch (error) {
      return { reply: LuaRedisBridge.exceptionError(error), fromCommand: false };
    }
  }

  /**
   * `redis.call` (raise) / `redis.pcall`: one result, the reply converted; errors as {err=…} tables, the ones of a
   * command marked `ignore_error_stats_update` (already counted: the script's error reply is not counted again).
   */
  private redisCall(Ls: LuaState, raise: boolean): number {
    const { reply, fromCommand } = this.runCommand(Ls);
    const { lw } = this.stack;
    lw.lua_settop(Ls, 0);
    if (reply instanceof RespError) {
      this.converter.pushReply(Ls, reply);
      if (fromCommand) {
        lw.lua_pushboolean(Ls, 1);
        lw.lua_setfield(Ls, -2, IGNORE_ERROR_STATS);
      }
      return raise ? lw.lua_error(Ls) : 1;
    }
    if (this.script.resp === 3) this.converter.pushReply3(Ls, reply);
    else this.converter.pushReply(Ls, toResp2(reply));
    return 1;
  }

  /**
   * `redis.acl_check_cmd(...)`: whether the user running the script may run the command with these arguments. Unknown
   * commands raise an error, as documented.
   */
  private aclCheck(Ls: LuaState): boolean | RespError {
    try {
      const argv = this.readCallArgs(Ls);
      if (argv instanceof RespError) return argv;
      const { meta } = CommandService.lookupCommand(argv);
      if (!meta) return new RespError(ScriptingMessages.ACL_CHECK_INVALID_COMMAND);
      const user = this.script.client?.user;
      return !user || this.server.aclCheckUser(user, argv, meta) === null;
    } catch (error) {
      return LuaRedisBridge.exceptionError(error);
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** sha1 hex digest of a binary (latin1) string: script ids (EVAL, SCRIPT LOAD) and redis.sha1hex(). */
  static sha1hex(text: string): string {
    return createHash('sha1').update(Buffer.from(text, 'latin1')).digest('hex');
  }

  /** Exposes the host functions to Lua as globals (before the prelude runs: it captures them in locals). */
  register(): void {
    const { stack } = this;
    const { lw } = stack;
    stack.registerFunction('__redis_call', (Ls) => this.redisCall(Ls, true));
    stack.registerFunction('__redis_pcall', (Ls) => this.redisCall(Ls, false));
    stack.registerFunction('__redis_acl_check_cmd', (Ls) => {
      const allowed = this.aclCheck(Ls);
      lw.lua_settop(Ls, 0);
      if (allowed instanceof RespError) {
        this.converter.pushReply(Ls, allowed);
        return lw.lua_error(Ls);
      }
      lw.lua_pushboolean(Ls, allowed ? 1 : 0);
      return 1;
    });
    stack.registerFunction('__redis_setresp', (Ls) => {
      this.script.resp = lw.lua_tointegerx(Ls, 1, null) === 3n ? 3 : 2;
      return 0;
    });
    stack.registerFunction('__redis_sha1hex', (Ls) => {
      stack.pushBytes(Ls, LuaRedisBridge.sha1hex(stack.readBytes(Ls, 1)));
      return 1;
    });
    stack.registerFunction('__rl_to51', (Ls) => {
      stack.pushBytes(Ls, LuaReplyConverter.toLua51(stack.readBytes(Ls, 1)));
      return 1;
    });
  }
}
