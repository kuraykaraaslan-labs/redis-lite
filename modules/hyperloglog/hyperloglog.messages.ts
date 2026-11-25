/**
 * Error replies of the HyperLogLog commands, word for word as Redis sends them. Texts shared with other modules live
 * in `@/libs/resp/messages`.
 */
export const HyperLogLogMessages = {
  WRONGTYPE: 'WRONGTYPE Key is not a valid HyperLogLog string value.',
  INVALID: 'INVALIDOBJ Corrupted HLL object detected',
  KEY_NOT_FOUND: 'ERR The specified key does not exist',
  NOT_SPARSE: 'ERR HLL encoding is not sparse',
  SELFTEST_SPARSE_NOT_USED: 'ERR TESTFAILED sparse encoding not used',
  SELFTEST_DISAGREE: 'ERR TESTFAILED dense/sparse disagree',

  // Templates: fill the {placeholders} with formatMessage() from @/libs/message-format
  DEBUG_WRONG_ARITY: "ERR Wrong number of arguments for the '{subcommand}' subcommand",
  DEBUG_UNKNOWN: "ERR Unknown PFDEBUG subcommand '{subcommand}'",
  SELFTEST_REGISTER: 'ERR TESTFAILED Register {index} should be {expected} but is {actual}',
  SELFTEST_TOO_BIG: 'ERR TESTFAILED Too big error. card:{card} abserr:{abserr}',
} as const;

export default HyperLogLogMessages;
