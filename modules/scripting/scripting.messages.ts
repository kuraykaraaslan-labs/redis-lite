/**
 * Texts of the scripting module (EVAL, SCRIPT, FUNCTION, FCALL and the Lua engine), word for word as Redis sends them.
 * Texts shared with other modules (syntax error, wrong arity, unknown subcommand…) live in `@/libs/resp/messages`.
 * Templates: fill the `{placeholders}` with formatMessage() from `@/libs/message-format`.
 */
export const ScriptingMessages = {
  // ============================================================================
  // EVAL / EVALSHA / SCRIPT
  // ============================================================================
  NOSCRIPT: 'NOSCRIPT No matching script. Please use EVAL.',
  NUMKEYS_GREATER: "ERR Number of keys can't be greater than number of args",
  NUMKEYS_NEGATIVE: "ERR Number of keys can't be negative",
  NOTBUSY: 'NOTBUSY No scripts in execution right now.',
  COMPILE_SCRIPT: 'ERR Error compiling script (new function): {error}',

  // ============================================================================
  // FUNCTION / FCALL
  // ============================================================================
  LIBRARY_NOT_FOUND: 'ERR Library not found',
  RESTORE_POLICY: 'ERR Wrong restore policy given, value should be either FLUSH, APPEND or REPLACE.',
  RESTORE_CHECKSUM: 'ERR payload version or checksum are wrong',
  RESTORE_INVALID_PAYLOAD: 'ERR given payload is not a valid function dump',
  FUNCTION_HELP: 'FUNCTION <subcommand>',
  FUNCTION_NOT_FOUND: 'ERR Function not found',
  RO_WITH_WRITE_FLAG: 'ERR Can not execute a script with write flag using *_ro command.',
  LIBRARY_NAME_INVALID:
    'ERR Library names can only contain letters, numbers, or underscores(_) and must be at least one character long',
  ENGINE_NOT_FOUND: "ERR Engine '{engine}' not found",
  LIBRARY_EXISTS: "ERR Library '{name}' already exists",
  COMPILE_FUNCTION: 'ERR Error compiling function: {error}',
  REGISTER_FUNCTIONS: 'ERR Error registering functions: {error}',
  NO_FUNCTIONS: 'ERR No functions registered',
  FUNCTION_EXISTS: 'ERR Function {name} already exists',
  METADATA_MISSING: 'ERR Missing library metadata',
  METADATA_INVALID: 'ERR Invalid library metadata',
  METADATA_NAME_TWICE: 'ERR Invalid metadata value, name argument was given multiple times',
  METADATA_INVALID_VALUE: 'ERR Invalid metadata value given: {part}',
  METADATA_NO_NAME: 'ERR Library name was not given',

  // ============================================================================
  // redis.call / redis.pcall / redis.acl_check_cmd
  // ============================================================================
  READ_ONLY_SCRIPT: 'ERR Write commands are not allowed from read-only scripts.',
  CALL_NO_ARGUMENTS: 'ERR Please specify at least one argument for this redis lib call',
  CALL_BAD_ARGUMENT: 'ERR Lua redis lib command arguments must be strings or integers',
  CALL_OUTSIDE_SCRIPT: 'ERR redis.call outside of a script',
  ACL_CHECK_INVALID_COMMAND: 'ERR Invalid command passed to redis.acl_check_cmd()',

  // ============================================================================
  // Script errors
  // ============================================================================
  /** An error raised by a script: the Lua error text, then where it happened. */
  SCRIPT_ERROR: '{message} script: {name}, on @{chunk}:1.',
  /** A plain-text error (a Lua runtime error, an exception in the engine) as an error reply. */
  ERR_PREFIXED: 'ERR {message}',
  UNKNOWN_ERROR: 'unknown error',

  // ============================================================================
  // Internal errors (not replies: they mean the engine itself is broken)
  // ============================================================================
  PRELUDE_COMPILE_FAILED: 'Lua prelude failed to compile: {error}',
  PRELUDE_FAILED: 'Lua prelude failed: {error}',
  PRELUDE_CALL_FAILED: '{name} failed: {error}',
} as const;

export default ScriptingMessages;
