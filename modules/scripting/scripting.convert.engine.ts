import { formatMessage } from '@/libs/message-format';
import {
  NULL_ARRAY,
  RespBigNumber,
  RespBool,
  RespDouble,
  RespError,
  RespMap,
  RespPairs,
  RespPush,
  RespSet,
  RespVerbatim,
  Status,
  toResp2,
} from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import { LuaType } from './scripting.enums';
import ScriptingMessages from './scripting.messages';
import type LuaStack from './scripting.stack.engine';
import type { LuaState, ScriptState } from './scripting.types';

// ============================================================================
// Lua 5.4 → 5.1 error texts
// ============================================================================

/** "attempt to <op> a <type> value (<kind> '<name>')" (5.4) */
const VARINFO_54 = /attempt to (.+?) an? (\w+) value \((global|local|field|method|upvalue|constant) '((?:[^'\\]|\\.)*)'\)/;
/** Arithmetic on a string that is not a number: 5.4's string metamethods name both operand types. */
const STRING_ARITH_54 = /attempt to (?:add|sub|mul|mod|pow|div|idiv|unm) a '(\w+)' with a '(\w+)'/;
/** An unquoted special token before " expected" or after " near" (5.4 quotes only symbols and reserved words). */
const SPECIAL_TOKEN_54 = / <(eof|name|string|number|integer)>(?= expected|$)/g;
/** 5.4's "syntax error near" of an expression statement that is not a call (5.1 expected an assignment). */
const SYNTAX_ERROR_54 = /: syntax error near /;
/** The position of an error raised by prelude code. */
const PRELUDE_POSITION = /^prelude:\d+: /;

// ============================================================================
// Numbers and lines
// ============================================================================

const TWO_POW_63 = 2 ** 63;
/** What a C cast of NaN or of an out-of-range double to long long gives on x86. */
const INTEGER_INDEFINITE = -(2n ** 63n);
const LINE_BREAKS = /[\r\n]/g;

/**
 * Conversions between Redis replies and Lua values, with Redis's rules: redis.call results become Lua values (RESP2
 * shapes, or RESP3 ones after redis.setresp(3)), and a script's return value becomes a reply.
 */
export default class LuaReplyConverter {
  constructor(
    private readonly stack: LuaStack,
    private readonly script: ScriptState,
  ) {}

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Pushes `{[field] = value}` where `pushValue` pushes the value. */
  private pushTagged(Ls: LuaState, field: string, pushValue: () => void): void {
    this.stack.lw.lua_createtable(Ls, 0, 1);
    pushValue();
    this.stack.lw.lua_setfield(Ls, -2, field);
  }

  /** RESP3-shaped tables a script can return: {double=n}, {big_number=s}, {verbatim_string={format,string}}, {map={…}}, {set={…}}. */
  private toTypedReply(at: number): Reply | undefined {
    const { stack } = this;
    const { lw, L } = stack;
    lw.lua_checkstack(L, 6);
    const top = lw.lua_gettop(L);
    try {
      if (stack.rawField(at, 'double') === LuaType.NUMBER) return new RespDouble(lw.lua_tonumberx(L, -1, null));
      lw.lua_settop(L, -2);
      if (stack.rawField(at, 'big_number') === LuaType.STRING) {
        const text = stack.readBytes(L, -1).replace(/[\r\n]/g, ' ');
        try {
          return new RespBigNumber(BigInt(text));
        } catch {
          return text;
        }
      }
      lw.lua_settop(L, -2);
      if (stack.rawField(at, 'verbatim_string') === LuaType.TABLE) {
        const vt = lw.lua_gettop(L);
        const format = stack.rawField(vt, 'format') === LuaType.STRING ? stack.readBytes(L, -1) : null;
        lw.lua_settop(L, -2);
        const text = stack.rawField(vt, 'string') === LuaType.STRING ? stack.readBytes(L, -1) : null;
        lw.lua_settop(L, -2);
        if (format !== null && text !== null && format.length === 3) return new RespVerbatim(text, format);
      }
      lw.lua_settop(L, -2);
      if (stack.rawField(at, 'map') === LuaType.TABLE) {
        const mt = lw.lua_gettop(L);
        const entries: Array<[Reply, Reply]> = [];
        lw.lua_pushnil(L);
        while (lw.lua_next(L, mt) !== 0) {
          entries.push([this.toReply(-2), this.toReply(-1)]);
          lw.lua_settop(L, -2);
        }
        return new RespMap(entries);
      }
      lw.lua_settop(L, -2);
      if (stack.rawField(at, 'set') === LuaType.TABLE) {
        const st = lw.lua_gettop(L);
        const items: Reply[] = [];
        lw.lua_pushnil(L);
        while (lw.lua_next(L, st) !== 0) {
          items.push(this.toReply(-2));
          lw.lua_settop(L, -2);
        }
        return new RespSet(items);
      }
      return undefined;
    } finally {
      lw.lua_settop(L, top);
    }
  }

  /**
   * A Lua float returned by a script, as the integer reply Redis sends: truncated (a C cast to long long), with the x86
   * "integer indefinite" value for NaN and out-of-range numbers.
   */
  private static floatToInteger(n: number): Reply {
    if (!(n >= -TWO_POW_63 && n < TWO_POW_63)) return INTEGER_INDEFINITE;
    const t = Math.trunc(n);
    return Number.isSafeInteger(t) ? t : BigInt(t);
  }

  // ──────────────────────────────────────────────
  // Redis → Lua
  // ──────────────────────────────────────────────

  /** RESP2 reply → Lua: nil → false, status → {ok=…}, error → {err=…}, arrays → tables. */
  pushReply(Ls: LuaState, reply: Reply): void {
    const { lw } = this.stack;
    lw.lua_checkstack(Ls, 4);
    if (reply === null || reply === NULL_ARRAY) lw.lua_pushboolean(Ls, 0);
    else if (typeof reply === 'string') this.stack.pushBytes(Ls, reply);
    else if (typeof reply === 'number') lw.lua_pushinteger(Ls, BigInt(Math.trunc(reply)));
    else if (typeof reply === 'bigint') lw.lua_pushinteger(Ls, reply);
    else if (reply instanceof Status) {
      lw.lua_createtable(Ls, 0, 1);
      this.stack.pushBytes(Ls, reply.value);
      lw.lua_setfield(Ls, -2, 'ok');
    } else if (reply instanceof RespError) {
      lw.lua_createtable(Ls, 0, 1);
      this.stack.pushBytes(Ls, reply.message);
      lw.lua_setfield(Ls, -2, 'err');
    } else if (!Array.isArray(reply)) {
      this.pushReply(Ls, toResp2(reply));
    } else {
      lw.lua_createtable(Ls, reply.length, 0);
      reply.forEach((item, i) => {
        this.pushReply(Ls, item);
        lw.lua_rawseti(Ls, -2, BigInt(i + 1));
      });
    }
  }

  /** RESP3 reply → Lua (redis.setresp(3)): maps, sets, doubles, big numbers, verbatim strings and booleans get their own shapes. */
  pushReply3(Ls: LuaState, reply: Reply): void {
    const { lw } = this.stack;
    lw.lua_checkstack(Ls, 6);
    if (reply === null || reply === NULL_ARRAY) lw.lua_pushnil(Ls);
    else if (reply instanceof RespBool) lw.lua_pushboolean(Ls, reply.value ? 1 : 0);
    else if (reply instanceof RespDouble) this.pushTagged(Ls, 'double', () => lw.lua_pushnumber(Ls, reply.value));
    else if (reply instanceof RespBigNumber) {
      this.pushTagged(Ls, 'big_number', () => this.stack.pushBytes(Ls, reply.value.toString()));
    } else if (reply instanceof RespVerbatim) {
      this.pushTagged(Ls, 'verbatim_string', () => {
        lw.lua_createtable(Ls, 0, 2);
        this.stack.pushBytes(Ls, reply.format);
        lw.lua_setfield(Ls, -2, 'format');
        this.stack.pushBytes(Ls, reply.text);
        lw.lua_setfield(Ls, -2, 'string');
      });
    } else if (reply instanceof RespMap) {
      this.pushTagged(Ls, 'map', () => {
        lw.lua_createtable(Ls, 0, reply.entries.length);
        for (const [k, v] of reply.entries) {
          this.pushReply3(Ls, k);
          this.pushReply3(Ls, v);
          lw.lua_settable(Ls, -3);
        }
      });
    } else if (reply instanceof RespSet) {
      this.pushTagged(Ls, 'set', () => {
        lw.lua_createtable(Ls, 0, reply.items.length);
        for (const item of reply.items) {
          this.pushReply3(Ls, item);
          lw.lua_pushboolean(Ls, 1);
          lw.lua_settable(Ls, -3);
        }
      });
    } else if (reply instanceof RespPairs) {
      this.pushReply3(
        Ls,
        reply.pairs.map(([a, b]) => [a, b]),
      );
    } else if (reply instanceof RespPush) this.pushReply3(Ls, reply.items);
    else if (Array.isArray(reply)) {
      lw.lua_createtable(Ls, reply.length, 0);
      reply.forEach((item, i) => {
        this.pushReply3(Ls, item);
        lw.lua_rawseti(Ls, -2, BigInt(i + 1));
      });
    } else this.pushReply(Ls, reply);
  }

  // ──────────────────────────────────────────────
  // Lua → Redis
  // ──────────────────────────────────────────────

  /** Lua value at `idx` → Redis reply, with Redis's conversion rules (numbers truncate, false → nil, {ok}/{err} tables). */
  toReply(idx: number): Reply {
    const { stack } = this;
    const { lw, L } = stack;
    const at = lw.lua_absindex(L, idx);
    switch (lw.lua_type(L, at)) {
      case LuaType.NIL:
        return null;
      case LuaType.BOOLEAN:
        if (this.script.resp === 3) return new RespBool(Boolean(lw.lua_toboolean(L, at)));
        return lw.lua_toboolean(L, at) ? 1 : null;
      case LuaType.NUMBER: {
        if (!lw.lua_isinteger(L, at)) return LuaReplyConverter.floatToInteger(lw.lua_tonumberx(L, at, null));
        const n = BigInt(lw.lua_tointegerx(L, at, null));
        return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
      }
      case LuaType.STRING:
        return stack.readBytes(L, at);
      case LuaType.TABLE: {
        if (lw.lua_getfield(L, at, 'err') === LuaType.STRING) {
          const msg = stack.readBytes(L, -1);
          lw.lua_settop(L, -2);
          return new RespError(msg);
        }
        lw.lua_settop(L, -2);
        if (lw.lua_getfield(L, at, 'ok') === LuaType.STRING) {
          // a status is one line: every CR and LF becomes a space
          const msg = stack.readBytes(L, -1).replace(LINE_BREAKS, ' ');
          lw.lua_settop(L, -2);
          return new Status(msg);
        }
        lw.lua_settop(L, -2);
        const typed = this.toTypedReply(at);
        if (typed !== undefined) return typed;
        const out: Reply[] = [];
        lw.lua_checkstack(L, 4);
        for (let i = 1; ; i++) {
          if (lw.lua_rawgeti(L, at, BigInt(i)) === LuaType.NIL) {
            lw.lua_settop(L, -2);
            break;
          }
          out.push(this.toReply(-1));
          lw.lua_settop(L, -2);
        }
        return out;
      }
      default:
        return null;
    }
  }

  /**
   * The message of the Lua error on top of the main stack, as Redis words it: the `err` field of an error table, else
   * "ERR " and the error as text (Lua 5.1 wording; a library error raised inside the prelude takes `where` instead of
   * its prelude position).
   */
  errorMessage(where = ''): string {
    const { stack } = this;
    const { lw, L } = stack;
    const type = lw.lua_type(L, -1);
    if (type === LuaType.TABLE) {
      const hasErr = lw.lua_getfield(L, -1, 'err') === LuaType.STRING;
      const err = hasErr ? stack.readBytes(L, -1) : null;
      lw.lua_settop(L, -2);
      if (err !== null) return err;
      return formatMessage(ScriptingMessages.ERR_PREFIXED, { message: ScriptingMessages.UNKNOWN_ERROR });
    }
    let text: string;
    if (type === LuaType.STRING) text = LuaReplyConverter.toLua51(stack.readBytes(L, -1).replace(PRELUDE_POSITION, where));
    else if (type === LuaType.USERDATA) text = ScriptingMessages.UNKNOWN_ERROR;
    else {
      // tostring() of anything else: nil, true, 42, function: 0x… (no __tostring of a user's userdata can run here)
      lw.luaL_tolstring(L, -1, null);
      text = stack.readBytes(L, -1);
      lw.lua_settop(L, -2);
    }
    return formatMessage(ScriptingMessages.ERR_PREFIXED, { message: text });
  }

  /** The error reply of a failed script or function `name` (error object on top of the main stack, raised at `line`). */
  scriptError(name: string, chunk: string, line: number): RespError {
    const message = this.errorMessage(`${chunk}:${line}: `);
    return new RespError(formatMessage(ScriptingMessages.SCRIPT_ERROR, { message, name, chunk, line: String(line) }));
  }

  /**
   * A Lua 5.4 error text in the Lua 5.1 wording Redis shows: variable information before the type
   * ("attempt to index local 't' (a nil value)"), quoted special tokens ("near '<eof>'"), and "'=' expected" where 5.4
   * says "syntax error".
   */
  static toLua51(message: string): string {
    return message
      .replace(VARINFO_54, (_m, op: string, type: string, kind: string, name: string) =>
        kind === 'constant' ? `attempt to ${op} a ${type} value` : `attempt to ${op} ${kind} '${name}' (a ${type} value)`,
      )
      .replace(STRING_ARITH_54, (_m, a: string, b: string) => `attempt to perform arithmetic on a ${a === 'number' ? b : a} value`)
      .replace(SPECIAL_TOKEN_54, " '<$1>'")
      .replace(SYNTAX_ERROR_54, ": '=' expected near ");
  }
}
