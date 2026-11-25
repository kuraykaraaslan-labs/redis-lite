/**
 * Error replies of the list commands, word for word as Redis sends them. Texts shared with other modules (syntax
 * error, timeouts, count must be positive…) live in `@/libs/resp/messages`.
 */
export const ListsMessages = {
  // LSET
  NO_SUCH_KEY: 'ERR no such key',
  INDEX_OUT_OF_RANGE: 'ERR index out of range',

  // LMPOP / BLMPOP
  NUMKEYS_POSITIVE: 'ERR numkeys should be greater than 0',
  COUNT_POSITIVE: 'ERR count should be greater than 0',

  // LPOS
  RANK_ZERO:
    "ERR RANK can't be zero: use 1 to start from the first match, 2 from the second ... or use negative to start from the end of the list",
  COUNT_NEGATIVE: "ERR COUNT can't be negative",
  MAXLEN_NEGATIVE: "ERR MAXLEN can't be negative",
} as const;

export default ListsMessages;
