/**
 * Error replies of the string commands, word for word as Redis sends them. Texts shared with other modules (syntax
 * error, not an integer, overflow…) live in `@/libs/resp/messages`.
 */
export const StringsMessages = {
  DECREMENT_OVERFLOW: 'ERR decrement would overflow',
  OFFSET_OUT_OF_RANGE: 'ERR offset is out of range',
  STRING_TOO_LONG: 'ERR string exceeds maximum allowed size (proto-max-bulk-len)',
  LCS_NOT_STRINGS: 'ERR The specified keys must contain string values',
  LCS_LEN_AND_IDX: 'ERR If you want both the length and indexes, please just use IDX.',
} as const;

export default StringsMessages;
