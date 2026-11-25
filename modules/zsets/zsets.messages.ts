/**
 * Error replies of the sorted-set commands, word for word as Redis sends them. Texts shared with other modules (syntax
 * error, not an integer, WRONGTYPE, timeouts, COUNT must be positive…) live in `@/libs/resp/messages`.
 */
export const ZSetsMessages = {
  MIN_MAX_NOT_FLOAT: 'ERR min or max is not a float',
  MIN_MAX_NOT_STRING: 'ERR min or max not valid string range item',
  XX_NX: 'ERR XX and NX options at the same time are not compatible',
  GT_LT_NX: 'ERR GT, LT, and/or NX options at the same time are not compatible',
  INCR_ONE_PAIR: 'ERR INCR option supports a single increment-element pair',
  SCORE_NAN: 'ERR resulting score is not a number (NaN)',
  LIMIT_NEEDS_BY: 'ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX',
  WITHSCORES_BYLEX: 'ERR syntax error, WITHSCORES not supported in combination with BYLEX',
  LIMIT_NEGATIVE: "ERR LIMIT can't be negative",
  WEIGHT_NOT_FLOAT: 'ERR weight value is not a float',
  NUMKEYS_NOT_POSITIVE: 'ERR numkeys should be greater than 0',
  COUNT_NOT_POSITIVE: 'ERR count should be greater than 0',

  // Templates: fill the {placeholders} with formatMessage() from @/libs/message-format
  AT_LEAST_ONE_KEY: "ERR at least 1 input key is needed for '{command}' command",
} as const;

export default ZSetsMessages;
