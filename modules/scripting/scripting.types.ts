import type { Client } from '@/modules/server/server.service';

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
 * client), the RESP version chosen with redis.setresp(), and whether write commands are refused.
 */
export interface ScriptState {
  client: Client | null;
  /** redis.setresp() of the running script (2 or 3). */
  resp: 2 | 3;
  /** EVAL_RO / EVALSHA_RO / FCALL_RO, or a no-writes function: write commands are refused. */
  readOnly: boolean;
}
