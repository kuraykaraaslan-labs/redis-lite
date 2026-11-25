import type { LuaWasm } from 'wasmoon';

import { formatMessage } from '@/libs/message-format';

import { LuaType } from './scripting.enums';
import ScriptingMessages from './scripting.messages';
import type { LuaState } from './scripting.types';

/**
 * Byte-exact access to one Lua state through the raw C API (wasmoon, WASM). Every Redis value is a latin1 "binary
 * string" on the JS side and the same bytes on the Lua side, so strings always cross through the WASM heap as bytes.
 */
export default class LuaStack {
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

  /** KEYS / ARGV: globals are read-only for scripts, so they are written through the prelude's raw setter. */
  setGlobalArray(name: string, values: string[]): void {
    const { lw, L } = this;
    lw.lua_getglobal(L, '__rl_set_global');
    this.pushBytes(L, name);
    this.pushArray(L, values);
    if (lw.lua_pcallk(L, 2, 0, 0, 0, null) !== 0) {
      const msg = this.errorText();
      lw.lua_settop(L, 0);
      throw new Error(formatMessage(ScriptingMessages.PRELUDE_CALL_FAILED, { name: '__rl_set_global', error: msg }));
    }
  }
}
