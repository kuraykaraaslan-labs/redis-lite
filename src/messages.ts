/** Error replies, word for word as Redis 7.2 sends them (clients and BullMQ match on some of these). */
export enum RespMessages {
  WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value',
  NOT_INTEGER = 'ERR value is not an integer or out of range',
  NOT_FLOAT = 'ERR value is not a valid float',
  MIN_MAX_NOT_FLOAT = 'ERR min or max is not a float',
  MIN_MAX_NOT_STRING = 'ERR min or max not valid string range item',
  SYNTAX = 'ERR syntax error',
  NO_SUCH_KEY = 'ERR no such key',
  INCR_OVERFLOW = 'ERR increment or decrement would overflow',
  NAN_OR_INF = 'ERR increment would produce NaN or Infinity',
  HASH_NOT_INTEGER = 'ERR hash value is not an integer',
  HASH_NOT_FLOAT = 'ERR hash value is not a float',
  INVALID_EXPIRE = 'ERR invalid expire time in',
  INDEX_OUT_OF_RANGE = 'ERR index out of range',
  DB_INDEX = 'ERR DB index is out of range',
  INVALID_DB_INDEX = 'ERR invalid DB index',
  NOAUTH = 'NOAUTH Authentication required.',
  WRONGPASS = 'WRONGPASS invalid username-password pair or user is disabled.',
  AUTH_NO_PASSWORD = 'ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?',
  NOPROTO = 'NOPROTO unsupported protocol version',
  MULTI_NESTED = 'ERR MULTI calls can not be nested',
  EXEC_WITHOUT_MULTI = 'ERR EXEC without MULTI',
  DISCARD_WITHOUT_MULTI = 'ERR DISCARD without MULTI',
  WATCH_IN_MULTI = 'ERR WATCH inside MULTI is not allowed',
  EXECABORT = 'EXECABORT Transaction discarded because of previous errors.',
  NOSCRIPT = 'NOSCRIPT No matching script. Please use EVAL.',
  NUMKEYS_GREATER = "ERR Number of keys can't be greater than number of args",
  NUMKEYS_NEGATIVE = "ERR Number of keys can't be negative",
  NOT_ALLOWED_FROM_SCRIPT = 'ERR This Redis command is not allowed from script',
  SUBSCRIBE_CONTEXT = "ERR Can't execute '%s': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context",
  TIMEOUT_NEGATIVE = 'ERR timeout is negative',
  TIMEOUT_NOT_FLOAT = 'ERR timeout is not a float or out of range',
  STREAM_ID_INVALID = 'ERR Invalid stream ID specified as stream command argument',
  STREAM_ID_SMALL = 'ERR The ID specified in XADD is equal or smaller than the target stream top item',
  STREAM_ID_ZERO = 'ERR The ID specified in XADD must be greater than 0-0',
  BUSYGROUP = 'BUSYGROUP Consumer Group name already exists',
  XGROUP_NO_KEY = 'ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.',
  UNBALANCED_XREAD = "ERR Unbalanced 'xread' list of streams: for each stream key an ID or '$' must be specified.",
  UNBALANCED_XREADGROUP = "ERR Unbalanced 'xreadgroup' list of streams: for each stream key an ID or '>' must be specified.",
  XREADGROUP_DOLLAR = 'ERR The $ ID is meaningless in the context of XREADGROUP: you want to read the history of this consumer by specifying a proper ID, or use the > ID to get new messages. The $ ID would just return an empty result set.',
  NO_SUCH_KEY_STREAM = 'ERR no such key',
  LIMIT_NEGATIVE = 'ERR LIMIT can\'t be negative',
  XX_NX = 'ERR XX and NX options at the same time are not compatible',
  GT_LT_NX = 'ERR GT, LT, and/or NX options at the same time are not compatible',
  INCR_ONE_PAIR = 'ERR INCR option supports a single increment-element pair',
  SCORE_NAN = 'ERR resulting score is not a number (NaN)',
  OOM = 'OOM command not allowed when used memory > \'maxmemory\'.',
  BIT_OFFSET = 'ERR bit offset is not an integer or out of range',
  COUNT_POSITIVE = 'ERR value is out of range, must be positive',
}

export function unknownCommand(name: string, args: string[]): string {
  const shown = args.slice(0, 20).map((a) => `'${a.slice(0, 128)}'`).join(' ');
  return `ERR unknown command '${name}', with args beginning with: ${shown}${shown ? ' ' : ''}`;
}

export function wrongArity(name: string): string {
  return `ERR wrong number of arguments for '${name.toLowerCase()}' command`;
}

export function unknownSubcommand(sub: string, cmd: string): string {
  return `ERR unknown subcommand '${sub}'. Try ${cmd.toUpperCase()} HELP.`;
}
