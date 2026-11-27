import { formatMessage } from '@/libs/message-format';
import { RespError } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import { Block } from '@/modules/command/command.service';
import type { RedisLiteServer } from '@/modules/server/server.service';

import type LuaReplyConverter from './scripting.convert.engine';
import { LUA_MASKCOUNT, LUA_REGISTRYINDEX, LuaStatus } from './scripting.enums';
import ScriptingMessages from './scripting.messages';
import type LuaStack from './scripting.stack.engine';
import type { LuaState, RunningScript, ScriptState } from './scripting.types';

/** How a script starts: what it is, who runs it, and whether it may be suspended once busy. */
export interface ScriptLaunch {
  kind: RunningScript['kind'];
  name: string;
  command: string[];
  chunk: string;
  client: RunningScript['client'];
  readOnly: boolean;
  /** Cooperative mode and a top-level command (not EXEC, not a script): the script may yield to the event loop. */
  canSuspend: boolean;
  /** Pushes the function to run on the thread; false when there is none. */
  pushFunction: (thread: LuaState) => boolean;
  /** Pushes the arguments on the thread; returns their count. */
  pushArgs: (thread: LuaState) => number;
}

/**
 * Runs scripts and functions in Lua threads (coroutines), so that a long script can be suspended and resumed.
 *
 * A count hook runs every HOOK_COUNT VM instructions. Once a script has run for busy-reply-threshold ms it is busy:
 * - SCRIPT KILL / FUNCTION KILL set `killed`, and the hook then raises "Script killed by user with SCRIPT KILL..."
 *   (a plain Lua error, as in Redis: a pcall in the script catches it);
 * - in cooperative mode (a top-level command, `canSuspend`), the hook yields the thread every SLICE_MS ms when the
 *   thread can yield (not inside a C call such as table.sort, string.gsub or a library function): the command answers
 *   with a Block (the client waits, its later commands stay queued), the event loop serves the other clients (the
 *   dispatcher answers them BUSY through `busyRefusal`), and the script resumes on the next turn of the loop. Its reply
 *   is sent with RedisLiteServer.releaseBlocked(). The script's writes stay one propagation unit (MULTI … EXEC).
 */
export default class LuaScriptRunner {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────
  /** VM instructions between two hook calls (a JS call each: cheap at this rate). */
  private static readonly HOOK_COUNT = 10_000;
  /** Run time of one slice of a busy script before the event loop gets a turn. */
  private static readonly SLICE_MS = 20;

  /** The script or function being run, from its start to its reply. */
  running: RunningScript | null = null;
  /** int* that lua_resume() writes its result count to. */
  private readonly nresults: number;
  /** The hook (a WASM function pointer), set on every script thread. */
  private readonly hookPointer: number;
  /** A thread ready for the next script (threads are reused: lua_resetthread() after each run). */
  private spare: { thread: LuaState; ref: number } | null = null;

  constructor(
    private readonly server: RedisLiteServer,
    private readonly stack: LuaStack,
    private readonly converter: LuaReplyConverter,
    private readonly script: ScriptState,
  ) {
    const { lw } = stack;
    this.nresults = lw.module._malloc(4);
    this.hookPointer = lw.module.addFunction((Ls: LuaState) => this.hook(Ls), 'vii');
    server.onClose(() => this.abort());
  }

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** The count hook: marks the script busy, raises the kill error, yields a busy script in cooperative mode. */
  private hook(Ls: LuaState): void {
    const r = this.running;
    if (!r) return;
    const { lw } = this.stack;
    const now = Date.now();
    if (r.killed) {
      this.stack.pushBytes(Ls, ScriptingMessages.KILLED);
      lw.lua_error(Ls);
      return;
    }
    if (!r.busy && r.thresholdMs > 0 && now - r.startedAt >= r.thresholdMs) r.busy = true;
    const sliceOver = now - r.sliceStartedAt >= LuaScriptRunner.SLICE_MS;
    if (r.busy && r.canSuspend && sliceOver && Ls === r.thread && lw.lua_isyieldable(Ls)) {
      r.hookYielded = true;
      lw.lua_yieldk(Ls, 0, 0, null);
    }
  }

  /** The line of the innermost frame of user code on the script's thread (failed or suspended). */
  private errorLine(r: RunningScript): number {
    const { lw, L } = this.stack;
    this.stack.callHelper('error_line', 1, () => {
      lw.lua_rawgeti(L, LUA_REGISTRYINDEX, BigInt(r.threadRef));
      return 1;
    });
    const line = Number(lw.lua_tointegerx(L, -1, null));
    lw.lua_settop(L, -2);
    return line > 0 ? line : 1;
  }

  /** Runs the thread for one slice: the reply when it ended, undefined when the hook suspended it. */
  private resume(r: RunningScript, nargs: number): Reply | undefined {
    const { lw, L } = this.stack;
    r.sliceStartedAt = Date.now();
    let ended = true;
    try {
      const status = lw.lua_resume(r.thread, L, nargs, this.nresults);
      if (status === LuaStatus.YIELD && r.hookYielded) {
        r.hookYielded = false;
        ended = false;
        return undefined;
      }
      if (status === LuaStatus.OK) {
        const n = lw.module.getValue(this.nresults, 'i32') as number;
        if (n === 0) lw.lua_pushnil(L);
        else {
          lw.lua_xmove(r.thread, L, n);
          lw.lua_settop(L, -n);
        }
        return this.converter.toReply(-1);
      }
      const line = this.errorLine(r);
      if (status === LuaStatus.YIELD) {
        // the script's own coroutine.yield(): the Lua 5.1 main thread cannot yield
        const message = formatMessage(ScriptingMessages.ERR_PREFIXED, { message: ScriptingMessages.YIELD_OUTSIDE_COROUTINE });
        const where = { name: r.name, chunk: r.chunk, line: String(line) };
        return new RespError(formatMessage(ScriptingMessages.SCRIPT_ERROR, { message, ...where }));
      }
      lw.lua_xmove(r.thread, L, 1);
      const error = this.converter.scriptError(r.name, r.chunk, line);
      if (error !== null) return error;
      // an error table without a usable `err` field: Redis 7.0 goes down without a reply; only this client's
      // connection is dropped here
      if (r.client.socket) this.server.connections.killClient(r.client);
      return new RespError(formatMessage(ScriptingMessages.ERR_PREFIXED, { message: ScriptingMessages.UNKNOWN_ERROR }));
    } catch (error) {
      // a failure of the engine itself: the thread is not reused
      r.aborted = true;
      throw error;
    } finally {
      if (ended) this.finish(r);
    }
  }

  /**
   * A thread for the next script: the spare one, or a new one (marked as a script thread for coroutine.running()).
   */
  private takeThread(): { thread: LuaState; ref: number } {
    const spare = this.spare;
    if (spare) {
      this.spare = null;
      return spare;
    }
    const { lw, L } = this.stack;
    const thread = lw.lua_newthread(L);
    const ref = lw.luaL_ref(L, LUA_REGISTRYINDEX);
    this.stack.callHelper('mark_thread', 0, () => {
      lw.lua_rawgeti(L, LUA_REGISTRYINDEX, BigInt(ref));
      return 1;
    });
    return { thread, ref };
  }

  /** The script ended (or was dropped): resets the script state, and its thread for the next script. */
  private finish(r: RunningScript): void {
    const { lw, L } = this.stack;
    lw.lua_settop(L, 0);
    // a dropped thread, or one the hook raised the kill error in (Lua leaves its hooks disabled after that), is released
    if (r.aborted || r.killed) lw.luaL_unref(L, LUA_REGISTRYINDEX, r.threadRef);
    else {
      // resetting leaves the error object of a failed thread on its stack
      lw.lua_resetthread(r.thread);
      lw.lua_settop(r.thread, 0);
      this.spare = { thread: r.thread, ref: r.threadRef };
    }
    if (this.running === r) this.running = null;
    this.script.client = null;
    this.script.resp = 2;
    this.script.readOnly = false;
    this.script.wrote = false;
  }

  /** The next slice of a suspended script, on a later turn of the event loop; its reply goes to the waiting client. */
  private continueLater(r: RunningScript): void {
    setImmediate(() => {
      if (r.aborted) return;
      let reply: Reply | undefined;
      try {
        reply = this.resume(r, 0);
      } catch (error) {
        reply = new RespError(formatMessage(ScriptingMessages.ERR_PREFIXED, { message: (error as Error).message }));
      }
      if (reply === undefined) {
        this.continueLater(r);
        return;
      }
      this.server.persistence.propagator.exit();
      this.server.releaseBlocked(r.client, reply);
      this.server.serveReadyKeys();
    });
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /**
   * Starts a script or function: its reply, or a Block when it was suspended (cooperative mode; the reply is sent when it
   * ends). The caller made sure nothing else is running.
   */
  start(launch: ScriptLaunch): Reply | Block {
    const { lw } = this.stack;
    const { thread, ref: threadRef } = this.takeThread();
    if (!launch.pushFunction(thread)) {
      lw.lua_settop(thread, 0);
      this.spare = { thread, ref: threadRef };
      return new RespError(ScriptingMessages.FUNCTION_NOT_FOUND);
    }
    const nargs = launch.pushArgs(thread);
    // The hook costs a call per VM instruction in Lua 5.4: only scripts that can be suspended (and so reached by
    // SCRIPT KILL) get it. Coroutines the script creates inherit it.
    if (launch.canSuspend) lw.lua_sethook(thread, this.hookPointer, LUA_MASKCOUNT, LuaScriptRunner.HOOK_COUNT);
    else lw.lua_sethook(thread, null, 0, 0);
    const now = Date.now();
    const r: RunningScript = {
      kind: launch.kind,
      name: launch.name,
      command: launch.command,
      client: launch.client,
      thread,
      threadRef,
      chunk: launch.chunk,
      startedAt: now,
      sliceStartedAt: now,
      thresholdMs: this.server.config.num('busy-reply-threshold'),
      busy: false,
      canSuspend: launch.canSuspend,
      suspended: false,
      hookYielded: false,
      killed: false,
      aborted: false,
    };
    this.running = r;
    this.script.client = launch.client;
    this.script.resp = 2;
    this.script.readOnly = launch.readOnly;
    this.script.wrote = false;
    const reply = this.resume(r, nargs);
    if (reply !== undefined) return reply;
    r.suspended = true;
    // the writes of the rest of the script join the ones of this first slice: one execution unit
    this.server.persistence.propagator.enter();
    this.continueLater(r);
    return new Block([], 0, () => undefined);
  }

  /** SCRIPT KILL (`eval`) / FUNCTION KILL (`function`): OK, or the error reply. */
  kill(kind: RunningScript['kind']): RespError | null {
    const r = this.running;
    if (!r || !r.suspended) return new RespError(ScriptingMessages.NOTBUSY);
    if (r.kind !== kind) {
      return new RespError(r.kind === 'function' ? ScriptingMessages.BUSY_FUNCTION : ScriptingMessages.BUSY_SCRIPT);
    }
    if (this.script.wrote) return new RespError(ScriptingMessages.UNKILLABLE);
    r.killed = true;
    return null;
  }

  /** The server closes: a suspended script is dropped (no reply). */
  abort(): void {
    const r = this.running;
    if (!r) return;
    r.aborted = true;
    this.finish(r);
    if (r.suspended) this.server.persistence.propagator.exit();
  }
}
