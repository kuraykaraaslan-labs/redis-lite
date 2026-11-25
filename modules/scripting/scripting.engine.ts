import { LuaWasm } from 'wasmoon';

import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { RespError } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { Client } from '@/modules/server/server.client';
import type { RedisLiteServer } from '@/modules/server/server.core';

import LuaRedisBridge from './scripting.bridge.engine';
import LuaReplyConverter from './scripting.convert.engine';
import { LUA_REGISTRYINDEX } from './scripting.enums';
import LuaFunctionLibraries from './scripting.library.engine';
import ScriptingMessages from './scripting.messages';
import { LUA_PRELUDE } from './scripting.prelude';
import LuaStack from './scripting.stack.engine';
import type { LuaLibrary, ScriptState } from './scripting.types';

export type { FunctionMeta, LuaLibrary } from './scripting.types';

/**
 * Redis scripting on top of Lua 5.4 (wasmoon, WASM), one Lua state per server. This class runs scripts and functions;
 * the work is shared with its parts:
 * - LuaStack (`scripting.stack.engine.ts`): byte-exact strings, chunks and globals through the raw C API;
 * - LuaReplyConverter (`scripting.convert.engine.ts`): Redis replies ⇄ Lua values;
 * - LuaRedisBridge (`scripting.bridge.engine.ts`): redis.call / pcall / acl_check_cmd / setresp / sha1hex;
 * - LuaFunctionLibraries (`scripting.library.engine.ts`): FUNCTION libraries.
 */
export class LuaEngine {
  private readonly refs = new Map<string, number>();
  /** The running script, shared with the converter and the bridge. */
  private readonly script: ScriptState = { client: null, resp: 2, readOnly: false };
  private readonly converter: LuaReplyConverter;
  private readonly functions: LuaFunctionLibraries;
  /** FUNCTION libraries by name. */
  readonly libraries: Map<string, LuaLibrary>;

  private constructor(
    server: RedisLiteServer,
    private readonly stack: LuaStack,
  ) {
    this.converter = new LuaReplyConverter(stack, this.script);
    this.functions = new LuaFunctionLibraries(stack, this.converter);
    this.libraries = this.functions.libraries;
    new LuaRedisBridge(server, stack, this.converter, this.script).register();
  }

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Calls the function on the stack with `nargs` arguments under a script context; converts its result or error. */
  private invoke(client: Client, nargs: number, readOnly: boolean, onError: () => RespError): Reply {
    const { lw, L } = this.stack;
    const saved = { ...this.script };
    this.script.client = client;
    this.script.resp = 2;
    this.script.readOnly = readOnly;
    try {
      if (lw.lua_pcallk(L, nargs, 1, 0, 0, null) !== 0) return onError();
      return this.converter.toReply(-1);
    } finally {
      this.script.client = saved.client;
      this.script.resp = saved.resp;
      this.script.readOnly = saved.readOnly;
      lw.lua_settop(L, 0);
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** sha1 hex digest of a binary (latin1) string: the id of a script. */
  static sha1hex(text: string): string {
    return LuaRedisBridge.sha1hex(text);
  }

  /** A new Lua state with the host functions registered and the prelude run. */
  static async create(server: RedisLiteServer): Promise<LuaEngine> {
    const lw = await LuaWasm.initialize();
    const L = lw.luaL_newstate();
    lw.luaL_openlibs(L);
    const stack = new LuaStack(lw, L);
    const engine = new LuaEngine(server, stack);
    const loaded = stack.load(LUA_PRELUDE, '=prelude');
    if (loaded !== null) throw new Error(formatMessage(ScriptingMessages.PRELUDE_COMPILE_FAILED, { error: loaded }));
    if (lw.lua_pcallk(L, 0, 0, 0, 0, null) !== 0) {
      throw new Error(formatMessage(ScriptingMessages.PRELUDE_FAILED, { error: stack.readBytes(L, -1) }));
    }
    lw.lua_settop(L, 0);
    return engine;
  }

  /** Compiles and caches a script; throws AppError on a syntax error. */
  compile(sha: string, body: string): number {
    const existing = this.refs.get(sha);
    if (existing !== undefined) return existing;
    const error = this.stack.load(body, '@user_script');
    if (error !== null) {
      this.stack.lw.lua_settop(this.stack.L, 0);
      throw new AppError(formatMessage(ScriptingMessages.COMPILE_SCRIPT, { error }));
    }
    const ref = this.stack.lw.luaL_ref(this.stack.L, LUA_REGISTRYINDEX);
    this.refs.set(sha, ref);
    return ref;
  }

  /** SCRIPT FLUSH: forgets every compiled script. */
  flush(): void {
    for (const ref of this.refs.values()) this.stack.lw.luaL_unref(this.stack.L, LUA_REGISTRYINDEX, ref);
    this.refs.clear();
  }

  /** EVAL / EVALSHA (and the _RO variants with `readOnly`). */
  run(client: Client, sha: string, body: string, keys: string[], argv: string[], readOnly = false): Reply {
    const { lw, L } = this.stack;
    const ref = this.compile(sha, body);
    this.stack.setGlobalArray('KEYS', keys);
    this.stack.setGlobalArray('ARGV', argv);
    lw.lua_rawgeti(L, LUA_REGISTRYINDEX, BigInt(ref));
    return this.invoke(client, 0, readOnly, () => this.converter.scriptError(sha));
  }

  /** FUNCTION LOAD: returns the library name. */
  loadLibrary(code: string, replace: boolean): string {
    return this.functions.load(code, replace);
  }

  /** FUNCTION DELETE: false when there is no such library. */
  deleteLibrary(name: string): boolean {
    return this.functions.delete(name);
  }

  /** The library that registered function `fn`. */
  functionOwner(fn: string): string | undefined {
    return this.functions.owner(fn);
  }

  /** FCALL / FCALL_RO (`readOnlyCommand`): calls a registered function with (keys, args) tables. */
  callFunction(client: Client, name: string, keys: string[], args: string[], readOnlyCommand = false): Reply {
    const meta = this.functions.meta(name);
    if (!meta) return new RespError(ScriptingMessages.FUNCTION_NOT_FOUND);
    const noWrites = meta.flags.includes('no-writes');
    if (readOnlyCommand && !noWrites) return new RespError(ScriptingMessages.RO_WITH_WRITE_FLAG);
    const { lw, L } = this.stack;
    lw.lua_getglobal(L, '__rl_call');
    this.stack.pushBytes(L, name);
    this.stack.pushArray(L, keys);
    this.stack.pushArray(L, args);
    return this.invoke(client, 3, noWrites || readOnlyCommand, () => this.converter.scriptError(name, 'user_function'));
  }
}
