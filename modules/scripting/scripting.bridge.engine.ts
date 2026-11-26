import { createHash } from 'node:crypto';

import { NULL_ARRAY, RespError, toResp2 } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService, { Block, NO_REPLY } from '@/modules/command/command.service';
import { COMMANDS } from '@/modules/command/command.registry';
import type { RedisLiteServer } from '@/modules/server/server.service';

import LuaReplyConverter from './scripting.convert.engine';
import { LuaType } from './scripting.enums';
import ScriptingMessages from './scripting.messages';
import type LuaStack from './scripting.stack.engine';
import type { LuaState, ScriptState } from './scripting.types';

/** Scratch space to read the sign bit of a NaN. */
const NAN_VIEW = new DataView(new ArrayBuffer(8));

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

  /**
   * A Lua float passed to redis.call: the shortest round-trip digits, laid out like printf "%.17g" (fixed notation for
   * exponents -4..16, else d.ddde+XX).
   */
  private static formatLuaFloat(n: number): string {
    if (n === Infinity) return 'inf';
    if (n === -Infinity) return '-inf';
    if (Number.isNaN(n)) {
      // printf shows the sign of a NaN (0/0 is -nan on x86)
      NAN_VIEW.setFloat64(0, n);
      return (NAN_VIEW.getUint8(0) & 0x80) !== 0 ? '-nan' : 'nan';
    }
    if (n === 0) return Object.is(n, -0) ? '-0' : '0';
    const [mantissa, exponentText] = n.toExponential().split('e');
    const exponent = Number(exponentText);
    if (exponent < -4 || exponent >= 17) {
      return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
    }
    const negative = mantissa.startsWith('-');
    const digits = mantissa.replace('-', '').replace('.', '');
    let text: string;
    if (exponent < 0) text = `0.${'0'.repeat(-exponent - 1)}${digits}`;
    else if (digits.length <= exponent + 1) text = digits + '0'.repeat(exponent + 1 - digits.length);
    else text = `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
    return negative ? `-${text}` : text;
  }

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
        argv.push(
          lw.lua_isinteger(Ls, i)
            ? String(lw.lua_tointegerx(Ls, i, null))
            : LuaRedisBridge.formatLuaFloat(lw.lua_tonumberx(Ls, i, null)),
        );
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

  /** Runs the command of a redis.call / redis.pcall: its reply, or the error the script gets. */
  private runCommand(Ls: LuaState): Reply {
    try {
      const argv = this.readCallArgs(Ls);
      if (argv instanceof RespError) return argv;
      const client = this.script.client;
      if (!client) return new RespError(ScriptingMessages.CALL_OUTSIDE_SCRIPT);
      if (LuaRedisBridge.isWriteCommand(argv)) {
        if (this.script.readOnly) return new RespError(ScriptingMessages.READ_ONLY_SCRIPT);
        this.script.wrote = true;
      }
      const reply = this.server.execute(client, argv, { inScript: true, noBlock: true });
      return reply instanceof Block || reply === NO_REPLY ? NULL_ARRAY : reply;
    } catch (error) {
      return LuaRedisBridge.exceptionError(error);
    }
  }

  /** `redis.call` (raise) / `redis.pcall`: one result, the reply converted; errors as {err=…} tables. */
  private redisCall(Ls: LuaState, raise: boolean): number {
    const reply = this.runCommand(Ls);
    const { lw } = this.stack;
    lw.lua_settop(Ls, 0);
    if (reply instanceof RespError) {
      this.converter.pushReply(Ls, reply);
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
