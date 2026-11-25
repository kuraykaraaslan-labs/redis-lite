import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { RespParser } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type LuaReplyConverter from './scripting.convert.engine';
import ScriptingMessages from './scripting.messages';
import type LuaStack from './scripting.stack.engine';
import type { FunctionMeta, LibraryMetadata, LuaLibrary } from './scripting.types';

/**
 * Redis Functions: the FUNCTION libraries of one Lua state. Loading runs the library body under the prelude's
 * `__rl_begin_load` … `__rl_commit` protocol, which collects its redis.register_function calls.
 */
export default class LuaFunctionLibraries {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────
  private static readonly LIBRARY_NAME_RE = /^[A-Za-z0-9_]+$/;

  /** FUNCTION libraries by name. */
  readonly libraries = new Map<string, LuaLibrary>();

  constructor(
    private readonly stack: LuaStack,
    private readonly converter: LuaReplyConverter,
  ) {}

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /**
   * The `#!<engine> name=<lib>` shebang of FUNCTION LOAD (Redis functionExtractLibMetaData): split with sdssplitargs;
   * `name=` is the only accepted field.
   */
  private static parseMetadata(shebang: string, code: string): LibraryMetadata {
    if (!code.startsWith('#!')) throw new AppError(ScriptingMessages.METADATA_MISSING);
    const parts = RespParser.splitArgs(shebang);
    if (!parts || !parts.length) throw new AppError(ScriptingMessages.METADATA_INVALID);
    const engine = parts[0].slice(2);
    let name: string | null = null;
    for (const part of parts.slice(1)) {
      if (part.slice(0, 5).toLowerCase() === 'name=') {
        if (name !== null) throw new AppError(ScriptingMessages.METADATA_NAME_TWICE);
        name = part.slice(5);
        continue;
      }
      throw new AppError(formatMessage(ScriptingMessages.METADATA_INVALID_VALUE, { part }));
    }
    if (name === null) throw new AppError(ScriptingMessages.METADATA_NO_NAME);
    return { engine, name };
  }

  /** Calls a prelude helper with string arguments and returns its (converted) result. */
  private callGlobal(name: string, args: string[]): Reply {
    const { lw, L } = this.stack;
    lw.lua_getglobal(L, name);
    for (const a of args) this.stack.pushBytes(L, a);
    try {
      if (lw.lua_pcallk(L, args.length, 1, 0, 0, null) !== 0) {
        throw new Error(formatMessage(ScriptingMessages.PRELUDE_CALL_FAILED, { name, error: this.stack.errorText() }));
      }
      return this.converter.toReply(-1);
    } finally {
      lw.lua_settop(L, 0);
    }
  }

  /** Aborts a load in progress and throws `message`. */
  private abort(message: string): never {
    this.callGlobal('__rl_abort_load', []);
    throw new AppError(message);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** FUNCTION LOAD: runs the library body, collecting redis.register_function calls. Returns the library name. */
  load(code: string, replace: boolean): string {
    const { lw, L } = this.stack;
    const newline = code.indexOf('\n');
    const { engine, name: libName } = LuaFunctionLibraries.parseMetadata(newline < 0 ? code : code.slice(0, newline), code);
    if (!LuaFunctionLibraries.LIBRARY_NAME_RE.test(libName)) throw new AppError(ScriptingMessages.LIBRARY_NAME_INVALID);
    if (engine.toLowerCase() !== 'lua') throw new AppError(formatMessage(ScriptingMessages.ENGINE_NOT_FOUND, { engine }));
    const existing = this.libraries.get(libName);
    if (existing && !replace) throw new AppError(formatMessage(ScriptingMessages.LIBRARY_EXISTS, { name: libName }));

    // Keep line numbers: the shebang line becomes an empty line.
    const body = newline < 0 ? '' : `\n${code.slice(newline + 1)}`;
    this.callGlobal('__rl_begin_load', []);
    const loadError = this.stack.load(body, '@user_function');
    if (loadError !== null) this.abort(formatMessage(ScriptingMessages.COMPILE_FUNCTION, { error: loadError }));
    if (lw.lua_pcallk(L, 0, 0, 0, 0, null) !== 0) {
      const msg = this.stack.errorText();
      lw.lua_settop(L, 0);
      this.abort(formatMessage(ScriptingMessages.REGISTER_FUNCTIONS, { error: msg }));
    }
    const names = this.callGlobal('__rl_finish_load', []) as string[];
    if (!names.length) this.abort(ScriptingMessages.NO_FUNCTIONS);
    for (const fn of names) {
      const owner = this.owner(fn);
      if (owner && owner !== libName) this.abort(formatMessage(ScriptingMessages.FUNCTION_EXISTS, { name: fn }));
    }
    const meta = new Map<string, FunctionMeta>();
    for (const fn of names) {
      const raw = this.callGlobal('__rl_staged_meta', [fn]) as Reply[];
      meta.set(fn, { description: raw[0] === 1 ? (raw[1] as string) : null, flags: raw.slice(2) as string[] });
    }
    if (existing) for (const fn of existing.functions) this.callGlobal('__rl_unregister', [fn]);
    this.callGlobal('__rl_commit', []);
    this.libraries.set(libName, { name: libName, code, functions: names, meta });
    return libName;
  }

  /** FUNCTION DELETE: false when there is no such library. */
  delete(name: string): boolean {
    const lib = this.libraries.get(name);
    if (!lib) return false;
    for (const fn of lib.functions) this.callGlobal('__rl_unregister', [fn]);
    this.libraries.delete(name);
    return true;
  }

  /** The library that registered function `fn`. */
  owner(fn: string): string | undefined {
    for (const lib of this.libraries.values()) if (lib.functions.includes(fn)) return lib.name;
    return undefined;
  }

  /** Description and flags of function `fn`. */
  meta(fn: string): FunctionMeta | undefined {
    for (const lib of this.libraries.values()) {
      const meta = lib.meta.get(fn);
      if (meta) return meta;
    }
    return undefined;
  }
}
