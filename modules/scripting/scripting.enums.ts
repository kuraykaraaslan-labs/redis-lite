import { z } from 'zod';

// ============================================================================
// Subcommands and options (lowercase: arguments are compared lowercased, as Redis does)
// ============================================================================

export const ScriptSubcommandEnum = z.enum(['load', 'exists', 'flush', 'kill']);

export const FunctionSubcommandEnum = z.enum(['load', 'delete', 'flush', 'list', 'stats', 'dump', 'restore', 'kill', 'help']);

/** FUNCTION RESTORE's policy (default APPEND). */
export const FunctionRestorePolicyEnum = z.enum(['flush', 'append', 'replace']);

// ============================================================================
// Lua C API constants (lua.h)
// ============================================================================

/** LUA_REGISTRYINDEX: pseudo-index of the registry, where compiled scripts are kept by reference. */
export const LUA_REGISTRYINDEX = -1000000 - 1000;

/** lua_type() results used by the engine. */
export const LuaType = {
  NIL: 0,
  BOOLEAN: 1,
  NUMBER: 3,
  STRING: 4,
  TABLE: 5,
} as const;

// ============================================================================
// Type Exports
// ============================================================================

export type ScriptSubcommand = z.infer<typeof ScriptSubcommandEnum>;
export type FunctionSubcommand = z.infer<typeof FunctionSubcommandEnum>;
export type FunctionRestorePolicy = z.infer<typeof FunctionRestorePolicyEnum>;
