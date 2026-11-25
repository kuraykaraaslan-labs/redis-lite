/**
 * Every text the persistence module emits, word for word as Redis sends or logs it: error replies of SAVE / BGSAVE /
 * BGREWRITEAOF / DEBUG RELOAD, status replies, MISCONF write denials and the errors raised while reading an RDB,
 * DUMP payload, AOF or manifest (those are plain `Error`s: they surface at startup or are mapped by the caller).
 * Templates have `{placeholders}` filled with `formatMessage` from `@/libs/message-format`.
 */
export const PersistenceMessages = {
  // ---- command replies --------------------------------------------------------------------------------------------
  BGSAVE_IN_PROGRESS: 'ERR Background save already in progress',
  SAVE_FAILED: 'ERR',
  BGSAVE_STARTED: 'Background saving started',
  BGSAVE_SCHEDULED: 'Background saving scheduled',
  AOF_REWRITE_STARTED: 'Background append only file rewriting started',
  AOF_REWRITE_SCHEDULED: 'Background append only file rewriting scheduled',
  AOF_REWRITE_FAILED: "ERR Can't execute an AOF background rewriting. Please check the server logs for more information.",
  RELOAD_FAILED: 'ERR Error trying to load the RDB dump, check server logs.',
  LOADAOF_FAILED: 'ERR Error loading the AOF, check server logs.',
  AOF_ENABLE_FAILED: 'Unable to turn on AOF. Check server logs.',

  // ---- write denial (writeCommandsDeniedByDiskError) ------------------------------------------------------------
  RDB_MISCONF:
    "MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist to disk. Commands that may modify the data set are disabled, because this instance is configured to report errors during writes if RDB snapshotting fails (stop-writes-on-bgsave-error option). Please check the Redis logs for details about the RDB error.",
  AOF_MISCONF: 'MISCONF Errors writing to the AOF file: {error}',

  // ---- RDB / DUMP format ------------------------------------------------------------------------------------------
  BAD_DATA_FORMAT: 'Bad data format',
  DUMP_PAYLOAD_INVALID: 'DUMP payload version or checksum are wrong',
  LISTPACK_INT_OUT_OF_RANGE: 'listpack integer out of range: {value}',
  MODULE_TYPES_UNSUPPORTED: 'Module data types are not supported',
  RDB_WRONG_SIGNATURE: 'Wrong signature trying to load DB from file',
  RDB_UNSUPPORTED_VERSION: "Can't handle RDB format version {version}",
  RDB_FUNCTION_PRE_GA: 'Pre-release function format not supported',
  RDB_MODULE_AUX: 'Module auxiliary data is not supported',
  RDB_WRONG_CHECKSUM: 'Wrong RDB checksum',

  // ---- loading ----------------------------------------------------------------------------------------------------
  TOO_MANY_DATABASES: 'FATAL: Data file was created with a Redis server configured to handle more than {databases} databases. Exiting',
  FUNCTIONS_ENGINE_NOT_READY: 'Cannot load functions: the scripting engine is not ready',
  AOF_FILE_MISSING: "The AOF file {file} doesn't exist",
  AOF_BAD_FORMAT: 'Bad file format reading the append only file',
  AOF_BAD_FORMAT_IN: '{error} {file}',
  AOF_BAD_SELECT: 'Bad SELECT index in the append only file {file}',
  AOF_UNKNOWN_COMMAND: "Unknown command '{command}' reading the append only file {file}",
  AOF_UNEXPECTED_EOF:
    "Unexpected end of file reading the append only file {file}. You can: 1) Make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>. 2) Alternatively you can set the 'aof-load-truncated' configuration option to yes and restart the server.",
  BGSAVE_CANCELLED: 'cancelled',

  // ---- AOF manifest -----------------------------------------------------------------------------------------------
  MANIFEST_INVALID: 'Invalid AOF manifest file format',
  MANIFEST_DUPLICATE_BASE: 'Found duplicate base file information',
  MANIFEST_NON_MONOTONIC: 'Found a non-monotonic sequence number',
} as const;

/** strerror() texts for the errno codes a disk write can fail with (they end up in MISCONF replies and logs). */
export const PersistenceErrnoMessages: Readonly<Record<string, string>> = {
  ENOSPC: 'No space left on device',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  EIO: 'Input/output error',
  EBADF: 'Bad file descriptor',
  EROFS: 'Read-only file system',
  EDQUOT: 'Disk quota exceeded',
  ENOENT: 'No such file or directory',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
};

export default PersistenceMessages;
