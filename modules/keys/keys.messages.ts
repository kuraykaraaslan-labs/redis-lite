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
  OBJECT_HELP: [
    'OBJECT <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
    'ENCODING <key>',
    '    Return the kind of internal representation used in order to store the value',
    '    associated with a <key>.',
    'FREQ <key>',
    '    Return the access frequency index of the <key>. The returned integer is',
    '    proportional to the logarithm of the recent access frequency of the key.',
    'IDLETIME <key>',
    '    Return the idle time of the <key>, that is the approximated number of',
    '    seconds elapsed since the last access to the key.',
    'REFCOUNT <key>',
    '    Return the number of references of the value associated with the specified',
    '    <key>.',
    'HELP',
    '    Print this help.',
  ],

  // SORT
  SORT_NOT_DOUBLE: "ERR One or more scores can't be converted into double",

  // DUMP / RESTORE
  DUMP_CHECKSUM: 'ERR DUMP payload version or checksum are wrong',
  BAD_DATA_FORMAT: 'ERR Bad data format',
  INVALID_TTL: 'ERR Invalid TTL value, must be >= 0',
  INVALID_IDLETIME: 'ERR Invalid IDLETIME value, must be >= 0',
  INVALID_FREQ: 'ERR Invalid FREQ value, must be >= 0 and <= 255',
  BUSYKEY: 'BUSYKEY Target key name already exists.',
} as const;

export default KeysMessages;
