import type { Client } from '@/modules/server/server.service';

import type { ScriptFlag, ScriptKind } from './scripting.enums';

/** A `lua_State*` (a pointer into the WASM heap). */
export type LuaState = number;

/** Description and flags of a registered function (FUNCTION LIST). */
export interface FunctionMeta {
  description: string | null;
  /** Flag names in Redis's canonical order (no-writes, allow-oom, allow-stale, no-cluster, allow-cross-slot-keys). */
  flags: string[];
}

/** A FUNCTION library: its source and the functions it registered. */
export interface LuaLibrary {
  name: string;
  code: string;
  /** Function names as registered, sorted. */
  functions: string[];
  /** Description and flags per function name. */
  meta: Map<string, FunctionMeta>;
}

/** The `#!<engine> name=<lib>` shebang of a library. */
export interface LibraryMetadata {
  engine: string;
  name: string;
}

/**
 * State of the script being run, shared by reference between the engine parts: who runs it (redis.call executes as that
 * client), the RESP version chosen with redis.setresp(), whether write commands are refused, and whether one ran.
 */
export interface ScriptState {
  client: Client | null;
  /** redis.setresp() of the running script (2 or 3). */
  resp: 2 | 3;
  /** EVAL_RO / EVALSHA_RO / FCALL_RO, or a no-writes script / function: write commands are refused. */
  readOnly: boolean;
  /** A write command ran: SCRIPT KILL / FUNCTION KILL answer UNKILLABLE. */
  wrote: boolean;
}

/** A compiled EVAL script: its registry reference and the flags of its shebang (null without one). */
export interface CompiledScript {
  ref: number;
  flags: ScriptFlag[] | null;
}

/** The script or function being run (a Lua thread), from its start to its reply. */
export interface RunningScript {
  kind: ScriptKind;
  /** The sha (EVAL) or the function name as typed (FCALL), for error replies. */
  name: string;
  /** The command as sent (FUNCTION STATS `command`). */
  command: string[];
  client: Client;
  /** The `lua_State*` of the thread and its registry reference (keeps it from being collected). */
  thread: LuaState;
  threadRef: number;
  /** Chunk name in error replies: user_script or user_function. */
  chunk: string;
  startedAt: number;
  /** When the current slice started. */
  sliceStartedAt: number;
  /** busy-reply-threshold (ms) read when the script started; 0 = never busy. */
  thresholdMs: number;
  /** Past busy-reply-threshold: other clients get BUSY, SCRIPT KILL / FUNCTION KILL apply. */
  busy: boolean;
  /** May yield to the event loop once busy (a top-level command in cooperative mode). */
  canSuspend: boolean;
  /** Yielded at least once: the command's reply is sent later. */
  suspended: boolean;
  /** The count hook asked the thread to yield (any other yield is the script's own coroutine.yield). */
  hookYielded: boolean;
  killed: boolean;
  /** The server closed while the script was suspended: it is dropped without a reply. */
  aborted: boolean;
}
