import { createHash } from 'node:crypto';

import { formatMessage } from '@/libs/message-format';
import { NULL_ARRAY, RespError, toResp2 } from '@/libs/resp';

import { Block, NO_REPLY } from '@/modules/command/command.handler';
import { lookupCommand } from '@/modules/command/command.meta';
import { COMMANDS } from '@/modules/command/command.registry';
import type { RedisLiteServer } from '@/modules/server/server.core';

import { LuaType } from './scripting.enums';
import type LuaReplyConverter from './scripting.convert.engine';
import ScriptingMessages from './scripting.messages';
import type LuaStack from './scripting.stack.engine';
import type { LuaState, ScriptState } from './scripting.types';

/**
 * The host functions the Lua prelude wraps: `__redis_call` (redis.call / redis.pcall), `__redis_acl_check_cmd`,
 * `__redis_setresp` and `__redis_sha1hex`. They never raise from JS: they push (ok, value) and the Lua side raises.
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

  /** Lua float passed to redis.call: shortest round-trip form, like Redis 7 (fpconv_dtoa). */
  private static formatLuaFloat(n: number): string {
    if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(0);
    if (n === Infinity) return 'inf';
    if (n === -Infinity) return '-inf';
    return String(n);
  }

  /** An exception caught in a host function, as the error the script sees. */
  private static exceptionText(error: unknown): string {
    return formatMessage(ScriptingMessages.ERR_PREFIXED, { message: (error as Error).message });
  }

  /** The arguments of a redis lib call as strings, or the error Redis raises for them. */
  private readCallArgs(Ls: LuaState): string[] | { error: string } {
    const { lw } = this.stack;
    const n = lw.lua_gettop(Ls);
    if (n === 0) return { error: ScriptingMessages.CALL_NO_ARGUMENTS };
    const argv: string[] = [];
    for (let i = 1; i <= n; i++) {
      const t = lw.lua_type(Ls, i);
      if (t === LuaType.STRING) argv.push(this.stack.readBytes(Ls, i));
      else if (t === LuaType.NUMBER) {
        argv.push(
          lw.lua_isinteger(Ls, i)
            ? String(lw.lua_tointegerx(Ls, i, null))
            : LuaRedisBridge.formatLuaFloat(lw.lua_tonumberx(Ls, i, null)),
        );
      } else return { error: ScriptingMessages.CALL_BAD_ARGUMENT };
    }
    return argv;
  }

  /** A known command with a valid arity that Redis flags `write` (unknown/arity/noscript errors are left to execute()). */
  private isWriteCommand(argv: string[]): boolean {
    const spec = COMMANDS.get(argv[0].toLowerCase());
    if (!spec?.flags?.write || spec.flags.noscript) return false;
    return spec.arity > 0 ? argv.length === spec.arity : argv.length >= -spec.arity;
  }

  private pushCallError(Ls: LuaState, message: string): number {
    this.stack.lw.lua_pushboolean(Ls, 0);
    this.converter.pushReply(Ls, new RespError(message));
    return 2;
  }

  /** `__redis_call(...)` → (ok: boolean, reply). Never raises from JS; the Lua wrapper raises for redis.call. */
  private redisCall(Ls: LuaState): number {
    const { lw } = this.stack;
    try {
      const argv = this.readCallArgs(Ls);
      if (!Array.isArray(argv)) return this.pushCallError(Ls, argv.error);
      const client = this.script.client;
      if (!client) return this.pushCallError(Ls, ScriptingMessages.CALL_OUTSIDE_SCRIPT);
      if (this.script.readOnly && this.isWriteCommand(argv)) return this.pushCallError(Ls, ScriptingMessages.READ_ONLY_SCRIPT);
      const reply = this.server.execute(client, argv, { inScript: true, noBlock: true });
      const value = reply instanceof Block || reply === NO_REPLY ? NULL_ARRAY : reply;
      lw.lua_pushboolean(Ls, value instanceof RespError ? 0 : 1);
      if (this.script.resp === 3) this.converter.pushReply3(Ls, value);
      else this.converter.pushReply(Ls, toResp2(value));
      return 2;
    } catch (error) {
      return this.pushCallError(Ls, LuaRedisBridge.exceptionText(error));
    }
  }

  /**
   * `__redis_acl_check_cmd(...)` → (ok, allowed): whether the user running the script may run the command with these
   * arguments (redis.acl_check_cmd). Unknown commands raise an error, as documented.
   */
  private aclCheckCmd(Ls: LuaState): number {
    try {
      const argv = this.readCallArgs(Ls);
      if (!Array.isArray(argv)) return this.pushCallError(Ls, argv.error);
      const { meta } = lookupCommand(argv);
      if (!meta) return this.pushCallError(Ls, ScriptingMessages.ACL_CHECK_INVALID_COMMAND);
      const user = this.script.client?.user;
      const allowed = !user || this.server.aclCheckUser(user, argv, meta) === null;
      this.stack.lw.lua_pushboolean(Ls, 1);
      this.stack.lw.lua_pushboolean(Ls, allowed ? 1 : 0);
      return 2;
    } catch (error) {
      return this.pushCallError(Ls, LuaRedisBridge.exceptionText(error));
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
    stack.registerFunction('__redis_call', (Ls) => this.redisCall(Ls));
    stack.registerFunction('__redis_acl_check_cmd', (Ls) => this.aclCheckCmd(Ls));
    stack.registerFunction('__redis_setresp', (Ls) => {
      this.script.resp = stack.lw.lua_tointegerx(Ls, 1, null) === 3n ? 3 : 2;
      return 0;
    });
    stack.registerFunction('__redis_sha1hex', (Ls) => {
      stack.pushBytes(Ls, LuaRedisBridge.sha1hex(stack.readBytes(Ls, 1)));
      return 1;
    });
  }
}
