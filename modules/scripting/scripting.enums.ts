import { z } from 'zod';

// ============================================================================
// Subcommands and options (lowercase: arguments are compared lowercased, as Redis does)
// ============================================================================

export const ScriptSubcommandEnum = z.enum(['load', 'exists', 'flush', 'kill', 'help']);

export const FunctionSubcommandEnum = z.enum(['load', 'delete', 'flush', 'list', 'stats', 'dump', 'restore', 'kill', 'help']);

/** FUNCTION RESTORE's policy (default APPEND). */
export const FunctionRestorePolicyEnum = z.enum(['flush', 'append', 'replace']);

// ============================================================================
// Lua C API constants (lua.h)
// ============================================================================

/** LUA_REGISTRYINDEX: pseudo-index of the registry, where compiled scripts are kept by reference. */
export const LUA_REGISTRYINDEX = -1000000 - 1000;

/** LUA_MULTRET: every result of a call. */
export const LUA_MULTRET = -1;

/** lua_type() results used by the engine. */
export const LuaType = {
  NIL: 0,
  BOOLEAN: 1,
  NUMBER: 3,
  STRING: 4,
  TABLE: 5,
  FUNCTION: 6,
  USERDATA: 7,
  THREAD: 8,
} as const;

/** lua_resume() / lua_pcall() status codes used by the engine. */
export const LuaStatus = {
  OK: 0,
  YIELD: 1,
} as const;

/** lua_sethook() mask of the count event. */
export const LUA_MASKCOUNT = 8;

// ============================================================================
// Scripts
// ============================================================================

/** The flags a script shebang (`#!lua flags=…`) or a function registration may carry, in Redis's canonical order. */
export const SCRIPT_FLAGS = ['no-writes', 'allow-oom', 'allow-stale', 'no-cluster', 'allow-cross-slot-keys'] as const;

/** What is running: an EVAL script or a FUNCTION (FCALL). */
export const ScriptKindEnum = z.enum(['eval', 'function']);

/** SCRIPT FLUSH / FUNCTION FLUSH mode. */
export const FlushModeEnum = z.enum(['sync', 'async']);

// ============================================================================
// Type Exports
// ============================================================================

export type ScriptSubcommand = z.infer<typeof ScriptSubcommandEnum>;
export type FunctionSubcommand = z.infer<typeof FunctionSubcommandEnum>;
export type FunctionRestorePolicy = z.infer<typeof FunctionRestorePolicyEnum>;
export type ScriptKind = z.infer<typeof ScriptKindEnum>;
export type ScriptFlag = (typeof SCRIPT_FLAGS)[number];
