/**
 * Texts of the generic key commands, word for word as Redis sends them. Texts shared with other modules (syntax error,
 * not an integer, wrong arity…) live in `@/libs/resp/messages`. Templates: fill `{placeholders}` with formatMessage.
 */
export const KeysMessages = {
  // Keyspace — RENAME, COPY, MOVE, SWAPDB
  NO_SUCH_KEY: 'ERR no such key',
  SAME_OBJECT: 'ERR source and destination objects are the same',
  DB_INDEX: 'ERR DB index is out of range',
  INVALID_FIRST_DB_INDEX: 'ERR invalid first DB index',
  INVALID_SECOND_DB_INDEX: 'ERR invalid second DB index',

  // Expiry — EXPIRE family
  UNSUPPORTED_OPTION: 'ERR Unsupported option {option}',
  EXPIRE_NX_CONFLICT: 'ERR NX and XX, GT or LT options at the same time are not compatible',
  EXPIRE_GT_LT_CONFLICT: 'ERR GT and LT options at the same time are not compatible',
  INVALID_EXPIRE: "ERR invalid expire time in '{command}' command",

  // OBJECT
  OBJECT_ARITY: "ERR wrong number of arguments for 'object|{subcommand}' command",
  LFU_NO_IDLETIME:
    'ERR An LFU maxmemory policy is selected, idle time not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.',
  LFU_NO_FREQ:
    'ERR An LFU maxmemory policy is not selected, access frequency not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.',

  // SORT
  SORT_NOT_DOUBLE: "ERR One or more scores can't be converted into double",

  // DUMP / RESTORE
  DUMP_CHECKSUM: 'ERR DUMP payload version or checksum are wrong',
  BAD_DATA_FORMAT: 'ERR Bad data format',
  INVALID_TTL: 'ERR Invalid TTL value, must be >= 0',
  INVALID_IDLETIME: 'ERR Invalid IDLETIME value, must be >= 0',
  INVALID_FREQ: 'ERR Invalid FREQ value, must be >= 0 and <= 255',
  BUSYKEY: 'BUSYKEY Target key name already exists.',

  // MIGRATE
  MIGRATE_KEYS_NEEDS_EMPTY_KEY: 'ERR When using MIGRATE KEYS option, the key argument must be set to the empty string',
  /** Status reply when none of the keys exists. */
  MIGRATE_NOKEY: 'NOKEY',
  MIGRATE_IO_CONNECT: 'IOERR error or timeout connecting to the client',
  MIGRATE_IO_WRITE: 'IOERR error or timeout writing to target instance',
  MIGRATE_IO_READ: 'IOERR error or timeout reading to target instance',
  /** `{error}` is the target's error line without its leading `-`. */
  MIGRATE_TARGET_ERROR: 'ERR Target instance replied with error: {error}',
} as const;

export default KeysMessages;
