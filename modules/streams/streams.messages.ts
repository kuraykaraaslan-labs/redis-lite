/**
 * Error replies and help texts of the stream commands, word for word as Redis sends them. Texts shared with other
 * modules (syntax error, not an integer, negative timeout, arity, unknown subcommand) live in `@/libs/resp/messages`.
 * Templates: fill the `{placeholders}` with formatMessage() from `@/libs/message-format`.
 */
export const StreamsMessages = {
  // ============================================================================
  // IDs
  // ============================================================================
  ID_INVALID: 'ERR Invalid stream ID specified as stream command argument',
  ID_SMALL: 'ERR The ID specified in XADD is equal or smaller than the target stream top item',
  ID_ZERO: 'ERR The ID specified in XADD must be greater than 0-0',
  ID_SEQ_OVERFLOW: 'ERR Elements are too large to be stored',
  ID_EXHAUSTED: 'ERR The stream has exhausted the last possible ID, unable to add more items',
  INVALID_START_ID: 'ERR invalid start ID for the interval',
  INVALID_END_ID: 'ERR invalid end ID for the interval',

  // ============================================================================
  // XADD / XTRIM
  // ============================================================================
  MAXLEN_AND_MINID: 'ERR syntax error, MAXLEN and MINID options at the same time are not compatible',
  MAXLEN_NEGATIVE: 'ERR The MAXLEN argument must be >= 0.',
  LIMIT_NEGATIVE: 'ERR The LIMIT argument must be >= 0.',
  LIMIT_WITHOUT_STRATEGY: 'ERR syntax error, LIMIT cannot be used without specifying a trimming strategy',
  XTRIM_WITHOUT_STRATEGY: 'ERR syntax error, XTRIM must be called with a trimming strategy',
  LIMIT_WITHOUT_APPROX: 'ERR syntax error, LIMIT cannot be used without the special ~ option',

  // ============================================================================
  // XREAD / XREADGROUP
  // ============================================================================
  TIMEOUT_NOT_INTEGER: 'ERR timeout is not an integer or out of range',
  GROUP_XREADGROUP_ONLY: 'ERR The GROUP option is only supported by XREADGROUP. You called XREAD instead.',
  NOACK_XREADGROUP_ONLY: 'ERR The NOACK option is only supported by XREADGROUP. You called XREAD instead.',
  MISSING_GROUP: 'ERR Missing GROUP option for XREADGROUP',
  UNBALANCED_XREAD: "ERR Unbalanced 'xread' list of streams: for each stream key an ID or '$' must be specified.",
  UNBALANCED_XREADGROUP: "ERR Unbalanced 'xreadgroup' list of streams: for each stream key an ID or '>' must be specified.",
  XREAD_NEW_ID: 'ERR The > ID can be specified only when calling XREADGROUP using the GROUP <group> <consumer> option.',
  XREADGROUP_DOLLAR:
    'ERR The $ ID is meaningless in the context of XREADGROUP: you want to read the history of this consumer by specifying a proper ID, or use the > ID to get new messages. The $ ID would just return an empty result set.',
  NOGROUP_XREADGROUP: "NOGROUP No such key '{key}' or consumer group '{group}' in XREADGROUP with GROUP option",
  UNBLOCKED_KEY_DELETED: 'UNBLOCKED the stream key no longer exists',
  UNBLOCKED_GROUP_DELETED: 'NOGROUP the consumer group this client was blocked on no longer exists',

  // ============================================================================
  // Consumer groups: XGROUP, XPENDING, XCLAIM, XAUTOCLAIM
  // ============================================================================
  NOGROUP: "NOGROUP No such key '{key}' or consumer group '{group}'",
  NOGROUP_FOR_KEY: "NOGROUP No such consumer group '{group}' for key name '{key}'",
  BUSYGROUP: 'BUSYGROUP Consumer Group name already exists',
  XGROUP_NO_KEY:
    'ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.',
  ENTRIESREAD_INVALID: 'ERR value for ENTRIESREAD must be positive or -1',
  SUBCOMMAND_SYNTAX: "ERR unknown subcommand or wrong number of arguments for '{subcommand}'. Try {command} HELP.",
  XCLAIM_MIN_IDLE_INVALID: 'ERR Invalid min-idle-time argument for XCLAIM',
  XCLAIM_IDLE_INVALID: 'ERR Invalid IDLE option argument for XCLAIM',
  XCLAIM_TIME_INVALID: 'ERR Invalid TIME option argument for XCLAIM',
  XCLAIM_RETRYCOUNT_INVALID: 'ERR Invalid RETRYCOUNT option argument for XCLAIM',
  XCLAIM_UNKNOWN_OPTION: "ERR Unrecognized XCLAIM option '{option}'",
  XAUTOCLAIM_MIN_IDLE_INVALID: 'ERR Invalid min-idle-time argument for XAUTOCLAIM',
  COUNT_NOT_POSITIVE: 'ERR COUNT must be > 0',

  // ============================================================================
  // XINFO / XSETID
  // ============================================================================
  NO_SUCH_KEY: 'ERR no such key',
  ENTRIES_ADDED_NEGATIVE: 'ERR entries_added must be positive',
  XSETID_BELOW_MAX_DELETED_ARG: 'ERR The ID specified in XSETID is smaller than the provided max_deleted_entry_id',
  XSETID_BELOW_TOP_ITEM: 'ERR The ID specified in XSETID is smaller than the target stream top item',
  XSETID_ENTRIES_ADDED_SMALL: 'ERR The entries_added specified in XSETID is smaller than the target stream length',

  // ============================================================================
  // Help replies
  // ============================================================================
  XGROUP_HELP: [
    'XGROUP <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
    'CREATE <key> <groupname> <id|$> [option]',
    '    Create a new consumer group. Options are:',
    '    * MKSTREAM',
    '      Create the empty stream if it does not exist.',
    '    * ENTRIESREAD entries_read',
    "      Set the group's entries_read counter (internal use).",
    'CREATECONSUMER <key> <groupname> <consumer>',
    '    Create a new consumer in the specified group.',
    'DELCONSUMER <key> <groupname> <consumer>',
    '    Remove the specified consumer.',
    'DESTROY <key> <groupname>',
    '    Remove the specified group.',
    'SETID <key> <groupname> <id|$> [ENTRIESREAD entries_read]',
    '    Set the current group ID and entries_read counter.',
    'HELP',
    '    Print this help.',
  ],
  XINFO_HELP: [
    'XINFO <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
    'CONSUMERS <key> <groupname>',
    '    Show consumers of <groupname>.',
    'GROUPS <key>',
    '    Show the stream consumer groups.',
    'STREAM <key> [FULL [COUNT <count>]',
    '    Show information about the stream.',
    'HELP',
    '    Print this help.',
  ],
} as const;

export default StreamsMessages;
