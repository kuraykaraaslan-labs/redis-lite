/**
 * Error replies of the set commands, word for word as Redis sends them. Texts shared with other modules (syntax error,
 * count must be positive…) live in `@/libs/resp/messages`.
 */
export const SetsMessages = {
  // SINTERCARD
  NUMKEYS_POSITIVE: 'ERR numkeys should be greater than 0',
  NUMKEYS_GREATER: "ERR Number of keys can't be greater than number of args",
  LIMIT_NEGATIVE: "ERR LIMIT can't be negative",
} as const;

export default SetsMessages;
