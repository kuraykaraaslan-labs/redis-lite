/**
 * Error replies of the bitmap commands, word for word as Redis sends them. Texts shared with other modules (syntax
 * error, not an integer…) live in `@/libs/resp/messages`. Templates: fill `{placeholders}` with formatMessage.
 */
export const BitmapsMessages = {
  // Offsets and bits — GETBIT, SETBIT, BITFIELD
  BIT_OFFSET: 'ERR bit offset is not an integer or out of range',
  BIT_VALUE: 'ERR bit is not an integer or out of range',

  // BITPOS
  BITPOS_BIT: 'ERR The bit argument must be 1 or 0.',

  // BITOP
  BITOP_NOT_SINGLE: 'ERR BITOP NOT must be called with a single source key.',
  BITOP_TWO_SOURCES: 'ERR BITOP {operation} must be called with at least two source keys.',

  // BITFIELD
  BITFIELD_TYPE: 'ERR Invalid bitfield type. Use something like i16 u8. Note that u64 is not supported but i64 is.',
  BITFIELD_OVERFLOW: 'ERR Invalid OVERFLOW type specified',
  BITFIELD_RO_GET_ONLY: 'ERR BITFIELD_RO only supports the GET subcommand',
} as const;

export default BitmapsMessages;
