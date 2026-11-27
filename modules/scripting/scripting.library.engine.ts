import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { RespParser } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import LuaReplyConverter from './scripting.convert.engine';
import ScriptingMessages from './scripting.messages';
import type LuaStack from './scripting.stack.engine';
import type { FunctionMeta, LibraryMetadata, LuaLibrary } from './scripting.types';

/**
 * Redis Functions: the FUNCTION libraries of one Lua state. Loading runs the library body under the prelude's
 * begin_load … commit protocol (RL helpers), which gives the body its load-time environment and collects its
 * redis.register_function calls. Function names are unique case-insensitively across libraries (FCALL ignores case).
 */
export default class LuaFunctionLibraries {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────
  private static readonly LIBRARY_NAME_RE = /^[A-Za-z0-9_]+$/;

  /** FUNCTION libraries by name. */
  readonly libraries = new Map<string, LuaLibrary>();
  /**
   * Each function by lowercased name: its library and its name as registered (of names differing only in case, the
   * last registered, like the prelude's table of callable functions).
   */
  private readonly owners = new Map<string, { library: LuaLibrary; name: string }>();

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

  /** Calls an RL helper with string arguments and returns its (converted) result. */
  private callHelper(name: string, args: string[]): Reply {
    const { lw, L } = this.stack;
    this.stack.callHelper(name, 1, () => {
      for (const a of args) this.stack.pushBytes(L, a);
      return args.length;
    });
    try {
      return this.converter.toReply(-1);
    } finally {
      lw.lua_settop(L, 0);
    }
  }

  /** Aborts a load in progress and throws `message`. */
  private abort(message: string): never {
    this.callHelper('abort_load', []);
    throw new AppError(message);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /**
   * FUNCTION LOAD (and FUNCTION RESTORE, `restore`): runs the library body, collecting redis.register_function calls.
   * Returns the library name.
   */
  load(code: string, replace: boolean, restore = false): string {
    const { lw, L } = this.stack;
    const newline = code.indexOf('\n');
    const { engine, name: libName } = LuaFunctionLibraries.parseMetadata(newline < 0 ? code : code.slice(0, newline), code);
    if (!LuaFunctionLibraries.LIBRARY_NAME_RE.test(libName)) throw new AppError(ScriptingMessages.LIBRARY_NAME_INVALID);
    if (engine.toLowerCase() !== 'lua') throw new AppError(formatMessage(ScriptingMessages.ENGINE_NOT_FOUND, { engine }));
    const existing = this.libraries.get(libName);
    if (existing && !replace) {
      const text = restore ? ScriptingMessages.RESTORE_LIBRARY_EXISTS : ScriptingMessages.LIBRARY_EXISTS;
      throw new AppError(formatMessage(text, { name: libName }));
    }

    // Keep line numbers: the shebang line becomes an empty line.
    const body = newline < 0 ? '' : `\n${code.slice(newline + 1)}`;
    const loadError = this.stack.load(body, '@user_function');
    if (loadError !== null) {
      throw new AppError(formatMessage(ScriptingMessages.COMPILE_FUNCTION, { error: LuaReplyConverter.toLua51(loadError) }));
    }
    // begin_load(chunk) gives the chunk the libraries' environment; the chunk stays below the helper's (absent) result
    lw.lua_pushvalue(L, -1);
    this.stack.callHelper('begin_load', 0, () => {
      lw.lua_rotate(L, -2, 1);
      return 1;
    });
    if (lw.lua_pcallk(L, 0, 0, 0, 0, null) !== 0) {
      const msg = this.converter.errorMessage() ?? formatMessage(ScriptingMessages.ERR_PREFIXED, { message: ScriptingMessages.UNKNOWN_ERROR });
      lw.lua_settop(L, 0);
      this.abort(formatMessage(ScriptingMessages.REGISTER_FUNCTIONS, { error: msg }));
    }
    const names = this.callHelper('finish_load', []) as string[];
    if (!names.length) this.abort(ScriptingMessages.NO_FUNCTIONS);
    for (const fn of names) {
      const owner = this.owners.get(fn.toLowerCase());
      if (owner && owner.library.name !== libName) this.abort(formatMessage(ScriptingMessages.FUNCTION_EXISTS, { name: fn }));
    }
    const meta = new Map<string, FunctionMeta>();
    for (const fn of names) {
      const raw = this.callHelper('staged_meta', [fn]) as Reply[];
      meta.set(fn, { description: raw[0] === 1 ? (raw[1] as string) : null, flags: raw.slice(2) as string[] });
    }
    if (existing) this.delete(libName);
    this.callHelper('commit', []);
    const library: LuaLibrary = { name: libName, code, functions: [...names].sort(), meta };
    this.libraries.set(libName, library);
    for (const fn of names) this.owners.set(fn.toLowerCase(), { library, name: fn });
    return libName;
  }

  /** FUNCTION DELETE: false when there is no such library. */
  delete(name: string): boolean {
    const lib = this.libraries.get(name);
    if (!lib) return false;
    for (const fn of lib.functions) {
      this.callHelper('unregister', [fn]);
      this.owners.delete(fn.toLowerCase());
    }
    this.libraries.delete(name);
    return true;
  }

  /** The library that registered function `fn` (case-insensitive). */
  owner(fn: string): string | undefined {
    return this.owners.get(fn.toLowerCase())?.library.name;
  }

  /** Function `fn` (case-insensitive): its name as registered, description and flags. */
  find(fn: string): ({ name: string } & FunctionMeta) | undefined {
    const owner = this.owners.get(fn.toLowerCase());
    const meta = owner?.library.meta.get(owner.name);
    return owner && meta ? { name: owner.name, ...meta } : undefined;
  }
}
