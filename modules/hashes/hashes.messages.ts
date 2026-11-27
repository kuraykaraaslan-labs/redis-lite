/**
 * Error replies of the hash commands, word for word as Redis sends them. Texts shared with other modules (syntax
 * error, not an integer, overflow…) live in `@/libs/resp/messages`. Templates: fill `{placeholders}` with formatMessage.
 */
export const HashesMessages = {
  // Stored values — HINCRBY, HINCRBYFLOAT
  HASH_NOT_INTEGER: 'ERR hash value is not an integer',
  HASH_NOT_FLOAT: 'ERR hash value is not a float',
  /** HINCRBYFLOAT with an infinite increment (refused before the key is read). */
  INCREMENT_NAN_OR_INF: 'ERR value is NaN or Infinity',
} as const;

export default HashesMessages;
