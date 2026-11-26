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
  SCRIPT_FLUSH_OPTION: 'ERR SCRIPT FLUSH only support SYNC|ASYNC option',
  SHEBANG_INVALID: 'ERR Invalid script shebang',
  SHEBANG_ENGINE: 'ERR Unexpected engine in script shebang: {engine}',
  SHEBANG_OPTION: 'ERR Unknown lua shebang option: {option}',
  SHEBANG_FLAG: 'ERR Unexpected flag in script shebang: {flag}',
  RO_WITH_WRITE_FLAG: 'ERR Can not execute a script with write flag using *_ro command.',
  SCRIPT_HELP: [
    'DEBUG (YES|SYNC|NO)',
    '    Set the debug mode for subsequent scripts executed.',
    'EXISTS <sha1> [<sha1> ...]',
    '    Return information about the existence of the scripts in the script cache.',
    'FLUSH [ASYNC|SYNC]',
    '    Flush the Lua scripts cache. Very dangerous on replicas.',
    '    When called without the optional mode argument, the behavior is determined by the',
    '    lazyfree-lazy-user-flush configuration directive. Valid modes are:',
    '    * ASYNC: Asynchronously flush the scripts cache.',
    '    * SYNC: Synchronously flush the scripts cache.',
    'KILL',
    '    Kill the currently executing Lua script.',
    'LOAD <script>',
    '    Load a script into the scripts cache without executing it.',
  ],

  // ============================================================================
  // Busy scripts (busy-reply-threshold, SCRIPT KILL / FUNCTION KILL)
  // ============================================================================
  BUSY_SCRIPT: 'BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.',
  BUSY_FUNCTION: 'BUSY Redis is busy running a script. You can only call FUNCTION KILL or SHUTDOWN NOSAVE.',
  UNKILLABLE:
    'UNKILLABLE Sorry the script already executed write commands against the dataset. You can either wait the script termination or kill the server in a hard way using the SHUTDOWN NOSAVE command.',
  /** The error a killed script raises (its reply adds the usual "script: …, on @…" suffix). */
  KILLED: 'Script killed by user with SCRIPT KILL...',
  /** coroutine.yield() in the script itself (the Lua 5.1 main thread cannot yield). */
  YIELD_OUTSIDE_COROUTINE: 'attempt to yield across metamethod/C-call boundary',

  // ============================================================================
  // FUNCTION / FCALL
  // ============================================================================
  LIBRARY_NOT_FOUND: 'ERR Library not found',
  RESTORE_POLICY: 'ERR Wrong restore policy given, value should be either FLUSH, APPEND or REPLACE.',
  RESTORE_CHECKSUM: 'ERR DUMP payload version or checksum are wrong',
  RESTORE_INVALID_PAYLOAD: 'ERR given payload is not a valid function dump',
  /** FUNCTION RESTORE … APPEND onto an existing library (FUNCTION LOAD quotes the name, RESTORE does not). */
  RESTORE_LIBRARY_EXISTS: 'ERR Library {name} already exists',
  FUNCTION_FLUSH_OPTION: 'ERR FUNCTION FLUSH only supports SYNC|ASYNC option',
  FUNCTION_LIST_UNKNOWN_ARGUMENT: 'ERR Unknown argument {argument}',
  FUNCTION_LIST_NO_LIBRARY_NAME: 'ERR library name argument was not given',
  FUNCTION_LOAD_UNKNOWN_OPTION: 'ERR Unknown option given: {option}',
  FCALL_BAD_NUMKEYS: 'ERR Bad number of keys provided',
  FUNCTION_HELP: [
    'LOAD [REPLACE] <FUNCTION CODE>',
    '    Create a new library with the given library name and code.',
    'DELETE <LIBRARY NAME>',
    '    Delete the given library.',
    'LIST [LIBRARYNAME PATTERN] [WITHCODE]',
    '    Return general information on all the libraries:',
    '    * Library name',
    '    * The engine used to run the Library',
    '    * Library description',
    '    * Functions list',
    '    * Library code (if WITHCODE is given)',
    '    It also possible to get only function that matches a pattern using LIBRARYNAME argument.',
    'STATS',
    '    Return information about the current function running:',
    '    * Function name',
    '    * Command used to run the function',
    '    * Duration in MS that the function is running',
    '    If no function is running, return nil',
    '    In addition, returns a list of available engines.',
    'KILL',
    '    Kill the current running function.',
    'FLUSH [ASYNC|SYNC]',
    '    Delete all the libraries.',
    '    When called without the optional mode argument, the behavior is determined by the',
    '    lazyfree-lazy-user-flush configuration directive. Valid modes are:',
    '    * ASYNC: Asynchronously flush the libraries.',
    '    * SYNC: Synchronously flush the libraries.',
    'DUMP',
    '    Return a serialized payload representing the current libraries, can be restored using FUNCTION RESTORE command',
    'RESTORE <PAYLOAD> [FLUSH|APPEND|REPLACE]',
    '    Restore the libraries represented by the given payload, it is possible to give a restore policy to',
    '    control how to handle existing libraries (default APPEND):',
    '    * FLUSH: delete all existing libraries.',
    '    * APPEND: appends the restored libraries to the existing libraries. On collision, abort.',
    '    * REPLACE: appends the restored libraries to the existing libraries, On collision, replace the old',
    '      libraries with the new libraries (notice that even on this option there is a chance of failure',
    '      in case of functions name collision with another library).',
  ],
  FUNCTION_NOT_FOUND: 'ERR Function not found',
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
  /** An error raised by a script: the error text, then where it happened. */
  SCRIPT_ERROR: '{message} script: {name}, on @{chunk}:{line}.',
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
