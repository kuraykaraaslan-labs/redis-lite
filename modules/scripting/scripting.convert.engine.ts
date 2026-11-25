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
        if (!lw.lua_isinteger(L, at)) return Math.trunc(lw.lua_tonumberx(L, at, null));
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
          const msg = stack.readBytes(L, -1);
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

  /** The error a failed script (or function `name`) answers with, from the Lua error on top of the stack. */
  scriptError(name: string, chunk = 'user_script'): RespError {
    const { stack } = this;
    const { lw, L } = stack;
    const where = { name, chunk };
    if (lw.lua_type(L, -1) === LuaType.TABLE) {
      if (lw.lua_getfield(L, -1, 'err') === LuaType.STRING) {
        return new RespError(formatMessage(ScriptingMessages.SCRIPT_ERROR, { message: stack.readBytes(L, -1), ...where }));
      }
      const unknown = formatMessage(ScriptingMessages.ERR_PREFIXED, { message: ScriptingMessages.UNKNOWN_ERROR });
      return new RespError(formatMessage(ScriptingMessages.SCRIPT_ERROR, { message: unknown, ...where }));
    }
    const msg = lw.lua_type(L, -1) === LuaType.STRING ? stack.readBytes(L, -1) : ScriptingMessages.UNKNOWN_ERROR;
    const message = formatMessage(ScriptingMessages.ERR_PREFIXED, { message: msg });
    return new RespError(formatMessage(ScriptingMessages.SCRIPT_ERROR, { message, ...where }));
  }
}
