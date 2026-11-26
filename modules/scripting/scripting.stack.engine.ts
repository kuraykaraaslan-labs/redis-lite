import type { LuaWasm } from 'wasmoon';

import { formatMessage } from '@/libs/message-format';

import { LUA_MULTRET, LUA_REGISTRYINDEX, LuaType } from './scripting.enums';
import ScriptingMessages from './scripting.messages';
import type { LuaState } from './scripting.types';

/**
 * Byte-exact access to one Lua state through the raw C API (wasmoon, WASM). Every Redis value is a latin1 "binary
 * string" on the JS side and the same bytes on the Lua side, so strings always cross through the WASM heap as bytes.
 */
export default class LuaStack {
  /** Registry reference of the real globals table (taken from the prelude on first use). */
  private globalsRef: number | null = null;

  constructor(
    readonly lw: LuaWasm,
    readonly L: LuaState,
  ) {}

  // ──────────────────────────────────────────────
  // Strings
  // ──────────────────────────────────────────────

  /** Pushes `value` (a binary string) as a Lua string. */
  pushBytes(Ls: LuaState, value: string): void {
    const m = this.lw.module;
    const bytes = Buffer.from(value, 'latin1');
    const p = m._malloc(bytes.length || 1);
    m.HEAPU8.set(bytes, p);
    m.ccall('lua_pushlstring', 'number', ['number', 'number', 'number'], [Ls, p, bytes.length]);
    m._free(p);
  }

  /** The string (or number, converted) at `idx` as a binary string; '' when it is neither. */
  readBytes(Ls: LuaState, idx: number): string {
    const m = this.lw.module;
    const lenPtr = m._malloc(4);
    const p = m.ccall('lua_tolstring', 'number', ['number', 'number', 'number'], [Ls, idx, lenPtr]) as number;
    const len = m.getValue(lenPtr, 'i32') as number;
    m._free(lenPtr);
    if (!p) return '';
    return Buffer.from(m.HEAPU8.subarray(p, p + len)).toString('latin1');
  }

  /** Pushes a Lua array table of strings. */
  pushArray(Ls: LuaState, values: string[]): void {
    this.lw.lua_createtable(Ls, values.length, 0);
    values.forEach((v, i) => {
      this.pushBytes(Ls, v);
      this.lw.lua_rawseti(Ls, -2, BigInt(i + 1));
    });
  }

  // ──────────────────────────────────────────────
  // Chunks, globals and errors
  // ──────────────────────────────────────────────

  /** Exposes a JS function to Lua as the global `name`. */
  registerFunction(name: string, fn: (L: LuaState) => number): void {
    const pointer = this.lw.module.addFunction(fn, 'ii');
    this.lw.lua_pushcclosure(this.L, pointer, 0);
    this.lw.lua_setglobal(this.L, name);
  }

  /** Loads a chunk; leaves the function on the stack and returns null, or returns the error message. */
  load(source: string, chunkName: string): string | null {
    const m = this.lw.module;
    const bytes = Buffer.from(source, 'latin1');
    const p = m._malloc(bytes.length || 1);
    m.HEAPU8.set(bytes, p);
    // mode = NULL (pointer 0): text and binary chunks allowed, as in Redis.
    const status = m.ccall(
      'luaL_loadbufferx',
      'number',
      ['number', 'number', 'number', 'string', 'number'],
      [this.L, p, bytes.length, chunkName, 0],
    ) as number;
    m._free(p);
    if (status === 0) return null;
    const msg = this.readBytes(this.L, -1);
    this.lw.lua_settop(this.L, -2);
    return msg;
  }

  /** Text of the error on top of the stack: a string, or the `err` field of an error table. */
  errorText(): string {
    const { lw, L } = this;
    if (lw.lua_type(L, -1) === LuaType.STRING) return this.readBytes(L, -1);
    if (lw.lua_type(L, -1) === LuaType.TABLE && lw.lua_getfield(L, -1, 'err') === LuaType.STRING) return this.readBytes(L, -1);
    return ScriptingMessages.UNKNOWN_ERROR;
  }

  /** Raw field lookup on the table at absolute index `at`; leaves the value on the stack and returns its type. */
  rawField(at: number, field: string): number {
    this.pushBytes(this.L, field);
    return this.lw.lua_rawget(this.L, at);
  }

  /** KEYS / ARGV: globals are read-only for scripts, so they are written raw into the real globals table. */
  setGlobalArray(name: string, values: string[]): void {
    const { lw, L } = this;
    if (this.globalsRef === null) {
      this.pushHelper('globals');
      this.globalsRef = lw.luaL_ref(L, LUA_REGISTRYINDEX);
    }
    lw.lua_rawgeti(L, LUA_REGISTRYINDEX, BigInt(this.globalsRef));
    this.pushBytes(L, name);
    this.pushArray(L, values);
    lw.lua_rawset(L, -3);
    lw.lua_settop(L, -2);
  }

  // ──────────────────────────────────────────────
  // Engine helpers and C trampolines
  // ──────────────────────────────────────────────

  /** Pushes the prelude's engine helper `RL[name]` (the RL table is kept in the registry, out of the scripts' reach). */
  pushHelper(name: string): void {
    const { lw, L } = this;
    lw.lua_getfield(L, LUA_REGISTRYINDEX, '__rl');
    lw.lua_getfield(L, -1, name);
    lw.lua_rotate(L, -2, 1);
    lw.lua_settop(L, -2);
  }

  /**
   * Calls `RL[name]` with the arguments `pushArgs` pushes (it returns their count) and leaves `nresults` results on the
   * stack. A failure is a bug of the engine: it throws.
   */
  callHelper(name: string, nresults: number, pushArgs: () => number = () => 0): void {
    const { lw, L } = this;
    this.pushHelper(name);
    if (lw.lua_pcallk(L, pushArgs(), nresults, 0, 0, null) !== 0) {
      const msg = this.errorText();
      lw.lua_settop(L, 0);
      throw new Error(formatMessage(ScriptingMessages.PRELUDE_CALL_FAILED, { name, error: msg }));
    }
  }

  /**
   * Registers `__rl_cwrap(f)`: a C function (a JS trampoline) that calls the Lua function f with its arguments and
   * returns all its results. Library functions written in Lua are wrapped with it so that they run under a C frame,
   * like the C libraries of Redis: the caller's frame survives a tail call, and errors can name the caller's position.
   */
  registerTrampoline(): void {
    const { lw } = this;
    const trampoline = lw.module.addFunction((Ls: LuaState) => {
      const n = lw.lua_gettop(Ls);
      lw.lua_pushvalue(Ls, lw.lua_upvalueindex(1));
      lw.lua_rotate(Ls, 1, 1);
      lw.lua_callk(Ls, n, LUA_MULTRET, 0, null);
      return lw.lua_gettop(Ls);
    }, 'ii');
    this.registerFunction('__rl_cwrap', (Ls) => {
      lw.lua_pushvalue(Ls, 1);
      lw.lua_pushcclosure(Ls, trampoline, 1);
      return 1;
    });
  }

  /** Registers `__rl_newproxy(arg)` (Lua 5.1 newproxy): a userdata, with a new metatable when arg is true, or arg's. */
  registerNewproxy(): void {
    const { lw } = this;
    this.registerFunction('__rl_newproxy', (Ls) => {
      const type = lw.lua_type(Ls, 1);
      lw.lua_newuserdatauv(Ls, 0, 0);
      if (type === LuaType.BOOLEAN && lw.lua_toboolean(Ls, 1)) {
        lw.lua_createtable(Ls, 0, 0);
        lw.lua_setmetatable(Ls, -2);
      } else if (type === LuaType.USERDATA && lw.lua_getmetatable(Ls, 1)) {
        lw.lua_setmetatable(Ls, -2);
      }
      return 1;
    });
  }
}
