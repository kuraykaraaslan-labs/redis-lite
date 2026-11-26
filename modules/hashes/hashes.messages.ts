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

  // FIELDS numfields field… — field TTL commands
  FIELDS_MISSING: 'ERR Mandatory argument FIELDS is missing or not at the right position',
  NUMFIELDS_POSITIVE: 'ERR Number of fields must be a positive integer',
  NUMFIELDS_MISMATCH: 'ERR The `numfields` parameter must match the number of arguments',

  // Field expiry — HEXPIRE family, HGETEX, HSETEX
  EXPIRE_NEGATIVE: 'ERR invalid expire time, must be >= 0',
  /** HSETEX reports the same text as HGETEX, naming 'hgetex' (Redis's wording). */
  INVALID_FIELD_EXPIRE: "ERR invalid expire time in 'hgetex' command",
  FNX_AND_FXX: 'ERR Only one of FXX or FNX arguments can be specified',
  ONE_EXPIRY_OPTION: 'ERR Only one of EX, PX, EXAT, PXAT or KEEPTTL arguments can be specified',
} as const;

export default HashesMessages;
