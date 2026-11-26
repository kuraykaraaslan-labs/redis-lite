import { LuaWasm } from 'wasmoon';

import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { RespError, RespParser } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
import type { Block } from '@/modules/command/command.service';
import type { Client, RedisLiteServer } from '@/modules/server/server.service';

import LuaRedisBridge from './scripting.bridge.engine';
import LuaReplyConverter from './scripting.convert.engine';
import { LUA_REGISTRYINDEX, LuaType, SCRIPT_FLAGS } from './scripting.enums';
import type { ScriptFlag, ScriptKind } from './scripting.enums';
import LuaFunctionLibraries from './scripting.library.engine';
import ScriptingMessages from './scripting.messages';
import { LUA_PRELUDE } from './scripting.prelude';
import LuaScriptRunner from './scripting.runner.engine';
import LuaStack from './scripting.stack.engine';
import type { CompiledScript, LuaLibrary, RunningScript, ScriptState } from './scripting.types';

/** How a script or function is called: by whom, and whether it may be suspended once busy. */
export interface ScriptCall {
  client: Client;
  /** The command as sent (FUNCTION STATS). */
  command: string[];
  /** EVAL_RO / EVALSHA_RO / FCALL_RO. */
  readOnly: boolean;
  /** A top-level command (not inside EXEC or a script): a busy script may yield to the event loop. */
  topLevel: boolean;
}

/**
 * Redis scripting on top of Lua 5.4 (wasmoon, WASM), one Lua state per server, made to look like the Lua 5.1 of Redis
 * by the prelude. This class compiles and runs scripts and functions; the work is shared with its parts:
 * - LuaStack (`scripting.stack.engine.ts`): byte-exact strings, chunks, globals, the C trampoline, the prelude helpers;
 * - LuaReplyConverter (`scripting.convert.engine.ts`): Redis replies ⇄ Lua values, error replies, Lua 5.1 error texts;
 * - LuaRedisBridge (`scripting.bridge.engine.ts`): redis.call / pcall / acl_check_cmd / setresp / sha1hex;
 * - LuaScriptRunner (`scripting.runner.engine.ts`): threads, busy scripts, SCRIPT KILL / FUNCTION KILL;
 * - LuaFunctionLibraries (`scripting.library.engine.ts`): FUNCTION libraries.
 */
export class LuaEngine {
  private readonly compiled = new Map<string, CompiledScript>();
  /** The running script, shared with the converter, the bridge and the runner. */
  private readonly script: ScriptState = { client: null, resp: 2, readOnly: false, wrote: false };
  private readonly converter: LuaReplyConverter;
  private readonly functions: LuaFunctionLibraries;
  private readonly runner: LuaScriptRunner;
  /** FUNCTION libraries by name. */
  readonly libraries: Map<string, LuaLibrary>;
  /**
   * Cooperative mode: a busy script (past busy-reply-threshold) run by a top-level command yields to the event loop, so
   * other clients get BUSY and SCRIPT KILL / FUNCTION KILL / SHUTDOWN NOSAVE can reach it. It needs the dispatcher to
   * refuse other commands with `busyRefusal()` while a script is suspended (atomicity): the server turns it on together
   * with that check. Off, a script runs to its end in one go (an endless loop blocks the server).
   */
  cooperative = false;

  private constructor(
    server: RedisLiteServer,
    private readonly stack: LuaStack,
  ) {
    this.converter = new LuaReplyConverter(stack, this.script);
    this.functions = new LuaFunctionLibraries(stack, this.converter);
    this.libraries = this.functions.libraries;
    this.runner = new LuaScriptRunner(server, stack, this.converter, this.script);
    new LuaRedisBridge(server, stack, this.converter, this.script).register();
    stack.registerTrampoline();
    stack.registerNewproxy();
  }

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /**
   * The flags of a `#!lua flags=…` shebang line (split like sdssplitargs); throws AppError on an invalid one. Only
   * `flags=` is accepted, with flags from SCRIPT_FLAGS.
   */
  private static parseShebang(line: string): ScriptFlag[] {
    const parts = RespParser.splitArgs(line);
    if (!parts || !parts.length) throw new AppError(ScriptingMessages.SHEBANG_INVALID);
    if (parts[0] !== '#!lua') throw new AppError(formatMessage(ScriptingMessages.SHEBANG_ENGINE, { engine: parts[0] }));
    const flags = new Set<string>();
    for (const option of parts.slice(1)) {
      if (!option.startsWith('flags=')) throw new AppError(formatMessage(ScriptingMessages.SHEBANG_OPTION, { option }));
      const value = option.slice(6);
      if (value === '') continue;
      for (const flag of value.split(',')) {
        if (!(SCRIPT_FLAGS as readonly string[]).includes(flag)) {
          throw new AppError(formatMessage(ScriptingMessages.SHEBANG_FLAG, { flag }));
        }
        flags.add(flag);
      }
    }
    return SCRIPT_FLAGS.filter((f) => flags.has(f));
  }

  /** A script cannot start while another one is suspended (the dispatcher refuses most commands then anyway). */
  private busyError(): RespError | null {
    const r = this.runner.running;
    if (!r) return null;
    return new RespError(r.kind === 'function' ? ScriptingMessages.BUSY_FUNCTION : ScriptingMessages.BUSY_SCRIPT);
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

  /**
   * Compiles and caches a script; throws AppError on an invalid shebang or a syntax error. A `#!lua` shebang line is
   * compiled as an empty line (line numbers are kept).
   */
  compile(sha: string, body: string): CompiledScript {
    const existing = this.compiled.get(sha);
    if (existing !== undefined) return existing;
    let flags: ScriptFlag[] | null = null;
    let source = body;
    if (body.startsWith('#!')) {
      const newline = body.indexOf('\n');
      if (newline < 0) throw new AppError(ScriptingMessages.SHEBANG_INVALID);
      flags = LuaEngine.parseShebang(body.slice(0, newline));
      source = body.slice(newline);
    }
    const error = this.stack.load(source, '@user_script');
    if (error !== null) {
      this.stack.lw.lua_settop(this.stack.L, 0);
      throw new AppError(formatMessage(ScriptingMessages.COMPILE_SCRIPT, { error: LuaReplyConverter.toLua51(error) }));
    }
    const script = { ref: this.stack.lw.luaL_ref(this.stack.L, LUA_REGISTRYINDEX), flags };
    this.compiled.set(sha, script);
    return script;
  }

  /** SCRIPT FLUSH: forgets every compiled script. */
  flush(): void {
    for (const { ref } of this.compiled.values()) this.stack.lw.luaL_unref(this.stack.L, LUA_REGISTRYINDEX, ref);
    this.compiled.clear();
  }

  /** EVAL / EVALSHA (and the _RO variants): the reply, or a Block while a busy script runs on (cooperative mode). */
  run(call: ScriptCall, sha: string, body: string, keys: string[], argv: string[]): Reply | Block {
    const busy = this.busyError();
    if (busy) return busy;
    const { lw } = this.stack;
    const script = this.compile(sha, body);
    const noWrites = script.flags?.includes('no-writes') ?? false;
    // a shebang script without no-writes is a write script
    if (call.readOnly && script.flags !== null && !noWrites) return new RespError(ScriptingMessages.RO_WITH_WRITE_FLAG);
    this.stack.setGlobalArray('KEYS', keys);
    this.stack.setGlobalArray('ARGV', argv);
    return this.runner.start({
      kind: 'eval',
      name: sha,
      command: call.command,
      chunk: 'user_script',
      client: call.client,
      readOnly: call.readOnly || noWrites,
      canSuspend: this.cooperative && call.topLevel,
      pushFunction: (thread) => {
        lw.lua_rawgeti(thread, LUA_REGISTRYINDEX, BigInt(script.ref));
        return true;
      },
      pushArgs: () => 0,
    });
  }

  /** FCALL / FCALL_RO: calls a registered function (case-insensitive name) with (keys, args) tables. */
  callFunction(call: ScriptCall, name: string, keys: string[], args: string[]): Reply | Block {
    const fn = this.functions.find(name);
    if (!fn) return new RespError(ScriptingMessages.FUNCTION_NOT_FOUND);
    const noWrites = fn.flags.includes('no-writes');
    if (call.readOnly && !noWrites) return new RespError(ScriptingMessages.RO_WITH_WRITE_FLAG);
    const busy = this.busyError();
    if (busy) return busy;
    const { lw, L } = this.stack;
    return this.runner.start({
      kind: 'function',
      name: fn.name,
      command: call.command,
      chunk: 'user_function',
      client: call.client,
      readOnly: noWrites || call.readOnly,
      canSuspend: this.cooperative && call.topLevel,
      pushFunction: (thread) => {
        this.stack.callHelper('function_value', 1, () => {
          this.stack.pushBytes(L, name);
          return 1;
        });
        if (lw.lua_type(L, -1) === LuaType.NIL) return false;
        lw.lua_xmove(L, thread, 1);
        return true;
      },
      pushArgs: (thread) => {
        this.stack.pushArray(thread, keys);
        this.stack.pushArray(thread, args);
        return 2;
      },
    });
  }

  /** FUNCTION LOAD: returns the library name. `restore`: FUNCTION RESTORE's text for an existing library. */
  loadLibrary(code: string, replace: boolean, restore = false): string {
    const busy = this.busyError();
    if (busy) throw new AppError(busy.message);
    return this.functions.load(code, replace, restore);
  }

  /** FUNCTION DELETE: false when there is no such library. */
  deleteLibrary(name: string): boolean {
    return this.functions.delete(name);
  }

  /** The library that registered function `fn` (case-insensitive). */
  functionOwner(fn: string): string | undefined {
    return this.functions.owner(fn);
  }

  /** The script or function running (suspended) right now, if any. */
  get running(): RunningScript | null {
    return this.runner.running;
  }

  /** SCRIPT KILL / FUNCTION KILL: null when the script will stop, else the error reply (NOTBUSY, BUSY, UNKILLABLE). */
  kill(kind: ScriptKind): RespError | null {
    return this.runner.kill(kind);
  }

  /** Drops a suspended script without a reply (SHUTDOWN NOSAVE; also done when the server closes). */
  abort(): void {
    this.runner.abort();
  }

  /**
   * For the dispatcher, before it runs a top-level command: while a script is suspended (busy, cooperative mode), every
   * command without the allow_busy flag is refused with BUSY. SCRIPT KILL, FUNCTION KILL / STATS (and SHUTDOWN,
   * MULTI, AUTH…: allow_busy) pass; their handlers check the kind of script themselves.
   */
  busyRefusal(argv: string[]): RespError | null {
    const r = this.runner.running;
    if (!r || !r.suspended) return null;
    if (CommandService.lookupCommand(argv).meta?.flagSet.has('allow_busy')) return null;
    return this.busyError();
  }
}
