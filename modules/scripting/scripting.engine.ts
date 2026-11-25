import { LuaWasm } from 'wasmoon';

import { CommandError } from '@/libs/app-error';
import type { Reply } from '@/libs/resp';
import {
  NULL_ARRAY,
  RespBigNumber,
  RespBool,
  RespDouble,
  RespError,
  RespMap,
  RespPairs,
  RespParser,
  RespPush,
  RespSet,
  RespVerbatim,
  Status,
  toResp2,
} from '@/libs/resp';

import { Block, NO_REPLY } from '@/modules/command/command.handler';
import { COMMANDS } from '@/modules/command/command.registry';
import { lookupCommand } from '@/modules/command/command.meta';
import type { Client } from '@/modules/server/server.client';
import type { RedisLiteServer } from '@/modules/server/server.core';

import { sha1hex } from './scripting.commands';
import { LUA_PRELUDE } from './scripting.prelude';

const LUA_REGISTRYINDEX = -1000000 - 1000;
const T_NIL = 0;
const T_BOOLEAN = 1;
const T_NUMBER = 3;
const T_STRING = 4;
const T_TABLE = 5;

const READ_ONLY_SCRIPT_ERROR =
  'ERR Write commands are not allowed from read-only scripts.';

type LuaState = number;

/**
 * Redis scripting on top of Lua 5.4 (wasmoon, WASM). Talks to Lua through the raw C API so strings stay byte-exact:
 * every Redis value is a latin1 "binary string" on the JS side and the same bytes on the Lua side.
 */
export interface FunctionMeta {
  description: string | null;
  /** Flag names in Redis's canonical order (no-writes, allow-oom, allow-stale, no-cluster, allow-cross-slot-keys). */
  flags: string[];
}

export interface LuaLibrary {
  name: string;
  code: string;
  functions: string[];
  /** Description and flags per function name. */
  meta: Map<string, FunctionMeta>;
}

export class LuaEngine {
  private readonly refs = new Map<string, number>();
  /** FUNCTION libraries by name. */
  readonly libraries = new Map<string, LuaLibrary>();
  private client: Client | null = null;
  /** redis.setresp() of the running script (2 or 3). */
  private scriptResp: 2 | 3 = 2;
  /** EVAL_RO / EVALSHA_RO / FCALL_RO, or a no-writes function: write commands are refused. */
  private readOnly = false;

  private constructor(
    private readonly server: RedisLiteServer,
    private readonly lw: LuaWasm,
    private readonly L: LuaState,
  ) {}

  static async create(server: RedisLiteServer): Promise<LuaEngine> {
    const lw = await LuaWasm.initialize();
    const L = lw.luaL_newstate();
    lw.luaL_openlibs(L);
    const engine = new LuaEngine(server, lw, L);
    engine.registerFunction('__redis_call', (Ls) => engine.redisCall(Ls));
    engine.registerFunction('__redis_acl_check_cmd', (Ls) =>
      engine.aclCheckCmd(Ls),
    );
    engine.registerFunction('__redis_setresp', (Ls) => {
      engine.scriptResp = lw.lua_tointegerx(Ls, 1, null) === 3n ? 3 : 2;
      return 0;
    });
    engine.registerFunction('__redis_sha1hex', (Ls) => {
      engine.pushBytes(Ls, sha1hex(engine.readBytes(Ls, 1)));
      return 1;
    });
    const loaded = engine.load(LUA_PRELUDE, '=prelude');
    if (loaded !== null)
      throw new Error(`Lua prelude failed to compile: ${loaded}`);
    if (lw.lua_pcallk(L, 0, 0, 0, 0, null) !== 0)
      throw new Error(`Lua prelude failed: ${engine.readBytes(L, -1)}`);
    lw.lua_settop(L, 0);
    return engine;
  }

  /** Compiles and caches a script; throws CommandError on a syntax error. */
  compile(sha: string, body: string): number {
    const existing = this.refs.get(sha);
    if (existing !== undefined) return existing;
    const error = this.load(body, '@user_script');
    if (error !== null) {
      this.lw.lua_settop(this.L, 0);
      throw new CommandError(
        `ERR Error compiling script (new function): ${error}`,
      );
    }
    const ref = this.lw.luaL_ref(this.L, LUA_REGISTRYINDEX);
    this.refs.set(sha, ref);
    return ref;
  }

  flush(): void {
    for (const ref of this.refs.values())
      this.lw.luaL_unref(this.L, LUA_REGISTRYINDEX, ref);
    this.refs.clear();
  }

  /** EVAL / EVALSHA (and the _RO variants with `readOnly`). */
  run(
    client: Client,
    sha: string,
    body: string,
    keys: string[],
    argv: string[],
    readOnly = false,
  ): Reply {
    const { lw, L } = this;
    const ref = this.compile(sha, body);
    this.setGlobalArray('KEYS', keys);
    this.setGlobalArray('ARGV', argv);
    lw.lua_rawgeti(L, LUA_REGISTRYINDEX, BigInt(ref));
    return this.invoke(client, 0, readOnly, () => this.scriptError(sha));
  }

  /** Calls the function on the stack with `nargs` arguments under a script context; converts its result or error. */
  private invoke(
    client: Client,
    nargs: number,
    readOnly: boolean,
    onError: () => RespError,
  ): Reply {
    const { lw, L } = this;
    const saved = {
      client: this.client,
      resp: this.scriptResp,
      readOnly: this.readOnly,
    };
    this.client = client;
    this.scriptResp = 2;
    this.readOnly = readOnly;
    try {
      if (lw.lua_pcallk(L, nargs, 1, 0, 0, null) !== 0) return onError();
      return this.toReply(-1);
    } finally {
      this.client = saved.client;
      this.scriptResp = saved.resp;
      this.readOnly = saved.readOnly;
      lw.lua_settop(L, 0);
    }
  }

  // ---- Redis Functions ---------------------------------------------------------------------------------------

  /** FUNCTION LOAD: runs the library body, collecting redis.register_function calls. Returns the library name. */
  loadLibrary(code: string, replace: boolean): string {
    const newline = code.indexOf('\n');
    const { engine, name: libName } = parseLibraryMetadata(
      newline < 0 ? code : code.slice(0, newline),
      code,
    );
    if (!/^[A-Za-z0-9_]+$/.test(libName))
      throw new CommandError(
        'ERR Library names can only contain letters, numbers, or underscores(_) and must be at least one character long',
      );
    if (engine.toLowerCase() !== 'lua')
      throw new CommandError(`ERR Engine '${engine}' not found`);
    const existing = this.libraries.get(libName);
    if (existing && !replace)
      throw new CommandError(`ERR Library '${libName}' already exists`);

    // Keep line numbers: the shebang line becomes an empty line.
    const body = newline < 0 ? '' : `\n${code.slice(newline + 1)}`;
    this.callGlobal('__rl_begin_load', []);
    const loadError = this.load(body, `@user_function`);
    if (loadError !== null) {
      this.callGlobal('__rl_abort_load', []);
      throw new CommandError(`ERR Error compiling function: ${loadError}`);
    }
    if (this.lw.lua_pcallk(this.L, 0, 0, 0, 0, null) !== 0) {
      const msg = this.errorText();
      this.lw.lua_settop(this.L, 0);
      this.callGlobal('__rl_abort_load', []);
      throw new CommandError(`ERR Error registering functions: ${msg}`);
    }
    const names = this.callGlobal('__rl_finish_load', []) as string[];
    if (!names.length) {
      this.callGlobal('__rl_abort_load', []);
      throw new CommandError('ERR No functions registered');
    }
    for (const fn of names) {
      const owner = this.functionOwner(fn);
      if (owner && owner !== libName) {
        this.callGlobal('__rl_abort_load', []);
        throw new CommandError(`ERR Function ${fn} already exists`);
      }
    }
    const meta = new Map<string, FunctionMeta>();
    for (const fn of names) {
      const raw = this.callGlobal('__rl_staged_meta', [fn]) as Reply[];
      meta.set(fn, {
        description: raw[0] === 1 ? (raw[1] as string) : null,
        flags: raw.slice(2) as string[],
      });
    }
    if (existing)
      for (const fn of existing.functions)
        this.callGlobal('__rl_unregister', [fn]);
    this.callGlobal('__rl_commit', []);
    this.libraries.set(libName, {
      name: libName,
      code,
      functions: names,
      meta,
    });
    return libName;
  }

  deleteLibrary(name: string): boolean {
    const lib = this.libraries.get(name);
    if (!lib) return false;
    for (const fn of lib.functions) this.callGlobal('__rl_unregister', [fn]);
    this.libraries.delete(name);
    return true;
  }

  functionOwner(fn: string): string | undefined {
    for (const lib of this.libraries.values())
      if (lib.functions.includes(fn)) return lib.name;
    return undefined;
  }

  private functionMeta(fn: string): FunctionMeta | undefined {
    for (const lib of this.libraries.values()) {
      const meta = lib.meta.get(fn);
      if (meta) return meta;
    }
    return undefined;
  }

  /** FCALL / FCALL_RO (`readOnlyCommand`): calls a registered function with (keys, args) tables. */
  callFunction(
    client: Client,
    name: string,
    keys: string[],
    args: string[],
    readOnlyCommand = false,
  ): Reply {
    const meta = this.functionMeta(name);
    if (!meta) return new RespError('ERR Function not found');
    const noWrites = meta.flags.includes('no-writes');
    if (readOnlyCommand && !noWrites)
      return new RespError(
        'ERR Can not execute a script with write flag using *_ro command.',
      );
    const { lw, L } = this;
    lw.lua_getglobal(L, '__rl_call');
    this.pushBytes(L, name);
    this.pushArray(L, keys);
    this.pushArray(L, args);
    return this.invoke(client, 3, noWrites || readOnlyCommand, () =>
      this.scriptError(name, 'user_function'),
    );
  }

  /** Calls a prelude helper with string arguments and returns its (converted) result. */
  private callGlobal(name: string, args: string[]): Reply {
    const { lw, L } = this;
    lw.lua_getglobal(L, name);
    for (const a of args) this.pushBytes(L, a);
    try {
      if (lw.lua_pcallk(L, args.length, 1, 0, 0, null) !== 0)
        throw new Error(`${name} failed: ${this.errorText()}`);
      return this.toReply(-1);
    } finally {
      lw.lua_settop(L, 0);
    }
  }

  private errorText(): string {
    const { lw, L } = this;
    if (lw.lua_type(L, -1) === T_STRING) return this.readBytes(L, -1);
    if (
      lw.lua_type(L, -1) === T_TABLE &&
      lw.lua_getfield(L, -1, 'err') === T_STRING
    )
      return this.readBytes(L, -1);
    return 'unknown error';
  }

  private pushArray(Ls: LuaState, values: string[]): void {
    this.lw.lua_createtable(Ls, values.length, 0);
    values.forEach((v, i) => {
      this.pushBytes(Ls, v);
      this.lw.lua_rawseti(Ls, -2, BigInt(i + 1));
    });
  }

  // ---- redis.call --------------------------------------------------------------------------------------------

  /** The arguments of a redis lib call as strings, or the error Redis raises for them. */
  private readCallArgs(Ls: LuaState): string[] | { error: string } {
    const { lw } = this;
    const n = lw.lua_gettop(Ls);
    if (n === 0)
      return {
        error:
          'ERR Please specify at least one argument for this redis lib call',
      };
    const argv: string[] = [];
    for (let i = 1; i <= n; i++) {
      const t = lw.lua_type(Ls, i);
      if (t === T_STRING) argv.push(this.readBytes(Ls, i));
      else if (t === T_NUMBER) {
        argv.push(
          lw.lua_isinteger(Ls, i)
            ? String(lw.lua_tointegerx(Ls, i, null))
            : formatLuaFloat(lw.lua_tonumberx(Ls, i, null)),
        );
      } else
        return {
          error:
            'ERR Lua redis lib command arguments must be strings or integers',
        };
    }
    return argv;
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
      if (!meta)
        return this.pushCallError(
          Ls,
          'ERR Invalid command passed to redis.acl_check_cmd()',
        );
      const user = this.client?.user;
      const allowed = !user || this.server.aclCheckUser(user, argv, meta) === null;
      this.lw.lua_pushboolean(Ls, 1);
      this.lw.lua_pushboolean(Ls, allowed ? 1 : 0);
      return 2;
    } catch (error) {
      return this.pushCallError(Ls, `ERR ${(error as Error).message}`);
    }
  }

  /** `__redis_call(...)` → (ok: boolean, reply). Never raises from JS; the Lua wrapper raises for redis.call. */
  private redisCall(Ls: LuaState): number {
    const { lw } = this;
    try {
      const argv = this.readCallArgs(Ls);
      if (!Array.isArray(argv)) return this.pushCallError(Ls, argv.error);
      const client = this.client;
      if (!client)
        return this.pushCallError(Ls, 'ERR redis.call outside of a script');
      if (this.readOnly && this.isWriteCommand(argv))
        return this.pushCallError(Ls, READ_ONLY_SCRIPT_ERROR);
      const reply = this.server.execute(client, argv, {
        inScript: true,
        noBlock: true,
      });
      const value =
        reply instanceof Block || reply === NO_REPLY ? NULL_ARRAY : reply;
      lw.lua_pushboolean(Ls, value instanceof RespError ? 0 : 1);
      if (this.scriptResp === 3) this.pushReply3(Ls, value);
      else this.pushReply(Ls, toResp2(value));
      return 2;
    } catch (error) {
      return this.pushCallError(Ls, `ERR ${(error as Error).message}`);
    }
  }

  /** A known command with a valid arity that Redis flags `write` (unknown/arity/noscript errors are left to execute()). */
  private isWriteCommand(argv: string[]): boolean {
    const spec = COMMANDS.get(argv[0].toLowerCase());
    if (!spec?.flags?.write || spec.flags.noscript) return false;
    return spec.arity > 0
      ? argv.length === spec.arity
      : argv.length >= -spec.arity;
  }

  private pushCallError(Ls: LuaState, message: string): number {
    this.lw.lua_pushboolean(Ls, 0);
    this.pushReply(Ls, new RespError(message));
    return 2;
  }

  // ---- conversions -------------------------------------------------------------------------------------------

  private pushReply(Ls: LuaState, reply: Reply): void {
    const { lw } = this;
    lw.lua_checkstack(Ls, 4);
    if (reply === null || reply === NULL_ARRAY) lw.lua_pushboolean(Ls, 0);
    else if (typeof reply === 'string') this.pushBytes(Ls, reply);
    else if (typeof reply === 'number')
      lw.lua_pushinteger(Ls, BigInt(Math.trunc(reply)));
    else if (typeof reply === 'bigint') lw.lua_pushinteger(Ls, reply);
    else if (reply instanceof Status) {
      lw.lua_createtable(Ls, 0, 1);
      this.pushBytes(Ls, reply.value);
      lw.lua_setfield(Ls, -2, 'ok');
    } else if (reply instanceof RespError) {
      lw.lua_createtable(Ls, 0, 1);
      this.pushBytes(Ls, reply.message);
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
  private pushReply3(Ls: LuaState, reply: Reply): void {
    const { lw } = this;
    lw.lua_checkstack(Ls, 6);
    if (reply === null || reply === NULL_ARRAY) lw.lua_pushnil(Ls);
    else if (reply instanceof RespBool)
      lw.lua_pushboolean(Ls, reply.value ? 1 : 0);
    else if (reply instanceof RespDouble)
      this.pushTagged(Ls, 'double', () => lw.lua_pushnumber(Ls, reply.value));
    else if (reply instanceof RespBigNumber)
      this.pushTagged(Ls, 'big_number', () =>
        this.pushBytes(Ls, reply.value.toString()),
      );
    else if (reply instanceof RespVerbatim) {
      this.pushTagged(Ls, 'verbatim_string', () => {
        lw.lua_createtable(Ls, 0, 2);
        this.pushBytes(Ls, reply.format);
        lw.lua_setfield(Ls, -2, 'format');
        this.pushBytes(Ls, reply.text);
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
    } else if (reply instanceof RespPairs)
      this.pushReply3(
        Ls,
        reply.pairs.map(([a, b]) => [a, b]),
      );
    else if (reply instanceof RespPush) this.pushReply3(Ls, reply.items);
    else if (Array.isArray(reply)) {
      lw.lua_createtable(Ls, reply.length, 0);
      reply.forEach((item, i) => {
        this.pushReply3(Ls, item);
        lw.lua_rawseti(Ls, -2, BigInt(i + 1));
      });
    } else this.pushReply(Ls, reply);
  }

  /** Pushes `{[field] = value}` where `pushValue` pushes the value. */
  private pushTagged(Ls: LuaState, field: string, pushValue: () => void): void {
    this.lw.lua_createtable(Ls, 0, 1);
    pushValue();
    this.lw.lua_setfield(Ls, -2, field);
  }

  /** Raw field lookup on the table at absolute index `at`; leaves the value on the stack and returns its type. */
  private rawField(at: number, field: string): number {
    this.pushBytes(this.L, field);
    return this.lw.lua_rawget(this.L, at);
  }

  /** Lua value at `idx` → Redis reply, with Redis's conversion rules (numbers truncate, false → nil, {ok}/{err} tables). */
  private toReply(idx: number): Reply {
    const { lw, L } = this;
    const at = lw.lua_absindex(L, idx);
    switch (lw.lua_type(L, at)) {
      case T_NIL:
        return null;
      case T_BOOLEAN:
        if (this.scriptResp === 3)
          return new RespBool(Boolean(lw.lua_toboolean(L, at)));
        return lw.lua_toboolean(L, at) ? 1 : null;
      case T_NUMBER: {
        if (!lw.lua_isinteger(L, at))
          return Math.trunc(lw.lua_tonumberx(L, at, null));
        const n = BigInt(lw.lua_tointegerx(L, at, null));
        return n >= BigInt(Number.MIN_SAFE_INTEGER) &&
          n <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(n)
          : n;
      }
      case T_STRING:
        return this.readBytes(L, at);
      case T_TABLE: {
        if (lw.lua_getfield(L, at, 'err') === T_STRING) {
          const msg = this.readBytes(L, -1);
          lw.lua_settop(L, -2);
          return new RespError(msg);
        }
        lw.lua_settop(L, -2);
        if (lw.lua_getfield(L, at, 'ok') === T_STRING) {
          const msg = this.readBytes(L, -1);
          lw.lua_settop(L, -2);
          return new Status(msg);
        }
        lw.lua_settop(L, -2);
        const typed = this.toTypedReply(at);
        if (typed !== undefined) return typed;
        const out: Reply[] = [];
        lw.lua_checkstack(L, 4);
        for (let i = 1; ; i++) {
          if (lw.lua_rawgeti(L, at, BigInt(i)) === T_NIL) {
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

  /** RESP3-shaped tables a script can return: {double=n}, {big_number=s}, {verbatim_string={format,string}}, {map={…}}, {set={…}}. */
  private toTypedReply(at: number): Reply | undefined {
    const { lw, L } = this;
    lw.lua_checkstack(L, 6);
    const top = lw.lua_gettop(L);
    try {
      if (this.rawField(at, 'double') === T_NUMBER)
        return new RespDouble(lw.lua_tonumberx(L, -1, null));
      lw.lua_settop(L, -2);
      if (this.rawField(at, 'big_number') === T_STRING) {
        const text = this.readBytes(L, -1).replace(/[\r\n]/g, ' ');
        try {
          return new RespBigNumber(BigInt(text));
        } catch {
          return text;
        }
      }
      lw.lua_settop(L, -2);
      if (this.rawField(at, 'verbatim_string') === T_TABLE) {
        const vt = lw.lua_gettop(L);
        const format =
          this.rawField(vt, 'format') === T_STRING
            ? this.readBytes(L, -1)
            : null;
        lw.lua_settop(L, -2);
        const text =
          this.rawField(vt, 'string') === T_STRING
            ? this.readBytes(L, -1)
            : null;
        lw.lua_settop(L, -2);
        if (format !== null && text !== null && format.length === 3)
          return new RespVerbatim(text, format);
      }
      lw.lua_settop(L, -2);
      if (this.rawField(at, 'map') === T_TABLE) {
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
      if (this.rawField(at, 'set') === T_TABLE) {
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

  private scriptError(sha: string, chunk = 'user_script'): RespError {
    const { lw, L } = this;
    const suffix = ` script: ${sha}, on @${chunk}:1.`;
    if (lw.lua_type(L, -1) === T_TABLE) {
      if (lw.lua_getfield(L, -1, 'err') === T_STRING) {
        const msg = this.readBytes(L, -1);
        return new RespError(`${msg}${suffix}`);
      }
      return new RespError(`ERR unknown error${suffix}`);
    }
    const msg =
      lw.lua_type(L, -1) === T_STRING ? this.readBytes(L, -1) : 'unknown error';
    return new RespError(`ERR ${msg}${suffix}`);
  }

  // ---- raw helpers -------------------------------------------------------------------------------------------

  private registerFunction(name: string, fn: (L: LuaState) => number): void {
    const pointer = this.lw.module.addFunction(fn, 'ii');
    this.lw.lua_pushcclosure(this.L, pointer, 0);
    this.lw.lua_setglobal(this.L, name);
  }

  /** Loads a chunk; leaves the function on the stack and returns null, or returns the error message. */
  private load(source: string, chunkName: string): string | null {
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

  private pushBytes(Ls: LuaState, value: string): void {
    const m = this.lw.module;
    const bytes = Buffer.from(value, 'latin1');
    const p = m._malloc(bytes.length || 1);
    m.HEAPU8.set(bytes, p);
    m.ccall(
      'lua_pushlstring',
      'number',
      ['number', 'number', 'number'],
      [Ls, p, bytes.length],
    );
    m._free(p);
  }

  private readBytes(Ls: LuaState, idx: number): string {
    const m = this.lw.module;
    const lenPtr = m._malloc(4);
    const p = m.ccall(
      'lua_tolstring',
      'number',
      ['number', 'number', 'number'],
      [Ls, idx, lenPtr],
    ) as number;
    const len = m.getValue(lenPtr, 'i32') as number;
    m._free(lenPtr);
    if (!p) return '';
    return Buffer.from(m.HEAPU8.subarray(p, p + len)).toString('latin1');
  }

  /** KEYS / ARGV: globals are read-only for scripts, so they are written through the prelude's raw setter. */
  private setGlobalArray(name: string, values: string[]): void {
    const { lw, L } = this;
    lw.lua_getglobal(L, '__rl_set_global');
    this.pushBytes(L, name);
    this.pushArray(L, values);
    if (lw.lua_pcallk(L, 2, 0, 0, 0, null) !== 0) {
      const msg = this.errorText();
      lw.lua_settop(L, 0);
      throw new Error(`__rl_set_global failed: ${msg}`);
    }
  }
}

/** Lua float passed to redis.call: shortest round-trip form, like Redis 7 (fpconv_dtoa). */
function formatLuaFloat(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(0);
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  return String(n);
}

/**
 * The `#!<engine> name=<lib>` shebang of FUNCTION LOAD (Redis functionExtractLibMetaData): split with sdssplitargs; `name=` is
 * the only accepted field.
 */
function parseLibraryMetadata(
  shebang: string,
  code: string,
): { engine: string; name: string } {
  if (!code.startsWith('#!'))
    throw new CommandError('ERR Missing library metadata');
  const parts = RespParser.splitArgs(shebang);
  if (!parts || !parts.length)
    throw new CommandError('ERR Invalid library metadata');
  const engine = parts[0].slice(2);
  let name: string | null = null;
  for (const part of parts.slice(1)) {
    if (part.slice(0, 5).toLowerCase() === 'name=') {
      if (name !== null)
        throw new CommandError(
          'ERR Invalid metadata value, name argument was given multiple times',
        );
      name = part.slice(5);
      continue;
    }
    throw new CommandError(`ERR Invalid metadata value given: ${part}`);
  }
  if (name === null) throw new CommandError('ERR Library name was not given');
  return { engine, name };
}
