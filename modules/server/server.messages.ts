/**
 * Texts the server module emits (dispatcher errors, the server commands' replies, config and config-file errors), word
 * for word as Redis sends them. Texts shared with other modules (syntax error, arity, unknown subcommand…) live in
 * `@/libs/resp/messages`.
 */
export const ServerMessages = {
  // ============================================================================
  // Dispatcher
  // ============================================================================
  NOAUTH: 'NOAUTH Authentication required.',
  NO_MULTI: 'ERR Command not allowed inside a transaction',
  NOT_ALLOWED_FROM_SCRIPT: 'ERR This Redis command is not allowed from script',
  UNBLOCKED: 'UNBLOCKED client unblocked via CLIENT UNBLOCK',
  SUBSCRIBE_CONTEXT: "ERR Can't execute '{command}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context",
  EXECABORT_BECAUSE: 'EXECABORT Transaction discarded because of: {reason}',
  ACL_SCRIPT_FAILURE: 'ERR ACL failure in script: {reason}',
  /** An unexpected exception or a protocol error, answered as a plain ERR. */
  GENERIC_ERROR: 'ERR {message}',

  // ============================================================================
  // Startup, files and ACL file
  // ============================================================================
  DEFAULT_USER_MISSING: 'ACL default user missing',
  BAD_DIRECTIVE: "Bad directive or wrong number of arguments: '{name}'",
  INVALID_VALUE: "Invalid value for '{name}': {error}",
  CHDIR_FAILED: "Can't chdir to '{dir}': {error}",
  ACL_LOAD_OPEN: "ERR Error loading ACLs, opening file '{path}': {error}",
  ERRNO_ENOENT: 'No such file or directory',
  ERRNO_EACCES: 'Permission denied',
  ERRNO_EISDIR: 'Is a directory',
  ERRNO_ENOTDIR: 'Not a directory',
  ERRNO_EROFS: 'Read-only file system',
  ERRNO_ENOSPC: 'No space left on device',

  // ============================================================================
  // Config values and redis.conf
  // ============================================================================
  // UNCERTAIN: the wording of a malformed replicaof directive
  CONFIG_REPLICAOF: 'Invalid master port',
  CONFIG_BOOL: "argument must be 'yes' or 'no'",
  CONFIG_ENUM: 'argument(s) must be one of the following: {values}',
  CONFIG_INT: "argument couldn't be parsed into an integer",
  CONFIG_RANGE: 'argument must be between {min} and {max} inclusive',
  CONFIG_MEMORY: 'argument must be a memory value',
  CONFIG_KEYSPACE_EVENTS: "Invalid event class character. Use 'Ag$lshzxeKEtmdn'.",
  CONFIG_SAVE: 'Invalid save parameters',
  CONF_FATAL: "\n*** FATAL CONFIG FILE ERROR (Redis {version}) ***\nReading the configuration file, at line {line}\n>>> '{text}'\n{reason}",
  CONF_TOO_MANY_INCLUDES: "Fatal error, too many nested includes reading '{path}'",
  CONF_OPEN: "Fatal error, can't open config file '{path}': {error}",
  CONF_UNBALANCED_QUOTES: 'Unbalanced quotes in configuration line',
  CONF_BAD_DIRECTIVE: 'Bad directive or wrong number of arguments',

  // ============================================================================
  // CONFIG
  // ============================================================================
  CONFIG_SET_UNKNOWN: "ERR Unknown option or number of arguments for CONFIG SET - '{name}'",
  CONFIG_SET_FAILED: "ERR CONFIG SET failed (possibly related to argument '{name}') - {reason}",
  CONFIG_IMMUTABLE: "can't set immutable config",
  CONFIG_DUPLICATE: 'duplicate parameter',
  NO_CONFIG_FILE: 'ERR The server is running without a config file',

  // ============================================================================
  // COMMAND
  // ============================================================================
  COMMAND_INVALID: 'ERR Invalid command specified',
  COMMAND_NO_KEYS: 'ERR The command has no key arguments',
  COMMAND_INVALID_ARGC: 'ERR Invalid number of arguments specified for command',
  COMMAND_INVALID_ARGS: 'ERR Invalid arguments specified for command',

  // ============================================================================
  // ACL
  // ============================================================================
  NO_ACL_FILE:
    'ERR This Redis instance is not configured to use an ACL file. You may want to specify users via the ACL SETUSER command and then issue a CONFIG REWRITE (assuming you have a Redis configuration file set) in order to store users in the Redis configuration.',
  ACL_SAVE_FAILED: 'ERR There was an error trying to save the ACLs. Please check the server logs for more information',

  // ============================================================================
  // SLOWLOG / MONITOR / LATENCY
  // ============================================================================
  REDACTED: '(redacted)',
  SLOWLOG_MORE_ARGS: '... ({count} more arguments)',
  SLOWLOG_MORE_BYTES: '{prefix}... ({count} more bytes)',
  SLOWLOG_COUNT: 'ERR count should be greater than or equal to -1',
  LATENCY_NO_SAMPLES: "ERR No samples available for event '{event}'",
  LATENCY_DOCTOR_DISABLED:
    'I\'m sorry, Dave, I can\'t do that. Latency monitoring is disabled in this Redis instance. You may use "CONFIG SET latency-monitor-threshold <milliseconds>." in order to enable it. If we weren\'t in a deep space mission I\'d suggest to take a look at https://redis.io/topics/latency-monitor.\n',
  LATENCY_DOCTOR_OK:
    'Dave, no latency spike was observed during the lifetime of this Redis instance, not in the slightest bit. I honestly think you ought to sleep tonight.\n',

  // ============================================================================
  // MEMORY
  // ============================================================================
  MALLOC_STATS: 'Stats not supported for the current allocator',
  MEMORY_DOCTOR_EMPTY:
    "Hi Sam, this instance is empty or is using very little memory, my issues detector can't be used in these conditions. Please, leave for your mission on Earth and fill it with some data. The new Sam and I will be back to our programming as soon as I finished rebooting.\n",
  MEMORY_DOCTOR_OK: "Hi Sam, I can't find any memory issue in your instance. I can only account for what occurs on this base.\n",
  MEMORY_DOCTOR_HEADER: 'Sam, I detected a few issues in this Redis instance memory implants:\n\n',
  MEMORY_DOCTOR_FOOTER: "I'm here to keep you safe, Sam. I want to help you.\n",
  MEMORY_DOCTOR_PEAK:
    ' * Peak memory: In the past this instance used more than 150% the memory that is currently using. The allocator is normally not able to release memory after a peak, so you can expect to see a big fragmentation ratio, however this is actually harmless and is only due to the memory peak, and if the Redis instance Resident Set Size (RSS) is currently bigger than expected, the memory will be used as soon as you fill the Redis instance with more data. If the memory peak was only occasional and you want to try to reclaim memory, please try the MEMORY PURGE command, otherwise the only other option is to shutdown and restart the instance.\n\n',
  MEMORY_DOCTOR_BIG_CLIENTS:
    ' * Big client buffers: The clients output buffers in this instance are greater than 200K per client (on average). This may result from different causes, like Pub/Sub clients subscribed to channels bot not receiving data fast enough, so that data piles on the Redis instance output buffer, or clients sending commands with large replies or very large sequences of commands in the same pipeline. Please use the CLIENT LIST command in order to investigate the issue if it causes problems in your instance, or to understand better why certain clients are using a big amount of memory.\n\n',
  MEMORY_DOCTOR_SCRIPTS:
    " * Many scripts: There seem to be many cached scripts in this instance (more than 1000). This may be because scripts are generated and `EVAL`ed, instead of being parameterized (with KEYS and ARGV), `SCRIPT LOAD`ed and `EVALSHA`ed. Unless `SCRIPT FLUSH` is called periodically, the scripts' caches may end up consuming most of your memory.\n\n",

  // ============================================================================
  // Admin: MONITOR, SHUTDOWN, WAIT, WAITAOF, LOLWUT
  // ============================================================================
  MONITOR_CONTEXT: 'ERR MONITOR is not allowed in this context',
  NO_SHUTDOWN_IN_PROGRESS: 'ERR No shutdown in progress.',
  SHUTDOWN_FAILED: 'ERR Errors trying to SHUTDOWN. Check logs.',
  TIMEOUT_NOT_INTEGER: 'ERR timeout is not an integer or out of range',
  TIMEOUT_NEGATIVE: 'ERR timeout is negative',
  LOLWUT_5_CAPTION: '\nGeorg Nees - schotter, plotter on paper, 1968. Redis ver. {version}\n',
  LOLWUT_6_CAPTION: 'Dedicated to the 8 bit game developers of past and present.\nOriginal 8 bit image from Plaguemon by hikikomori. Redis ver. {version}\n',
  LOLWUT_CAPTION: 'Redis ver. {version}\n',

  // ============================================================================
  // DEBUG
  // ============================================================================
  NO_SUCH_KEY: 'ERR no such key',
  DEBUG_RELOAD_OPTIONS: 'ERR DEBUG RELOAD only supports the MERGE, NOFLUSH and NOSAVE options.',
  DEBUG_PACKED_THRESHOLD: 'ERR argument must be a memory value bigger than 1 and smaller than 4gb',
  DEBUG_NOT_LISTPACK: 'ERR Not a listpack encoded object.',
  DEBUG_NOT_QUICKLIST: 'ERR Not a quicklist encoded object.',
  DEBUG_LISTPACK_PRINTED: 'Listpack structure printed on stdout',
  DEBUG_QUICKLIST_PRINTED: 'Quicklist structure printed on stdout',
  DEBUG_STRINGMATCH: 'Apparently Redis did not crash: test passed',
  DEBUG_OBJECT:
    'Value at:{address} refcount:{refcount} encoding:{encoding}{serialized} lru:{lru} lru_seconds_idle:{idle}{quicklist}',
} as const;

export default ServerMessages;
