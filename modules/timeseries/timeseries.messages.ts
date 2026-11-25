/**
 * Error replies of the time series commands (`ERR TSDB: …`), word for word as best documented / observed. Texts shared
 * with other modules (syntax error, WRONGTYPE, wrong arity…) live in `@/libs/resp/messages`.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
export const TimeseriesMessages = {
  // keys
  KEY_NOT_EXIST: 'ERR TSDB: the key does not exist',
  KEY_EXISTS: 'ERR TSDB: key already exists',

  // samples
  INVALID_TIMESTAMP: 'ERR TSDB: invalid timestamp, must be a nonnegative integer',
  INVALID_VALUE: 'ERR TSDB: invalid value',
  TIMESTAMP_TOO_OLD: 'ERR TSDB: Timestamp is older than retention',
  DUPLICATE_BLOCKED: 'ERR TSDB: Error at upsert, update is not supported when DUPLICATE_POLICY is set to BLOCK mode',
  INCRBY_TOO_OLD: 'ERR TSDB: timestamp must be equal to or higher than the maximum existing timestamp',

  // series options
  BAD_RETENTION: "ERR TSDB: Couldn't parse RETENTION",
  BAD_CHUNK_SIZE: "ERR TSDB: Couldn't parse CHUNK_SIZE",
  CHUNK_SIZE_RANGE: 'ERR TSDB: CHUNK_SIZE value must be a multiple of 8 in the range [48 .. 1048576]',
  BAD_DUPLICATE_POLICY: 'ERR TSDB: Unknown DUPLICATE_POLICY',
  BAD_ON_DUPLICATE: 'ERR TSDB: Unknown ON_DUPLICATE',
  BAD_ENCODING: 'ERR TSDB: unknown ENCODING parameter',
  BAD_IGNORE: "ERR TSDB: Couldn't parse IGNORE",
  BAD_LABELS: "ERR TSDB: Couldn't parse LABELS",

  // range queries
  BAD_FROM: 'ERR TSDB: wrong fromTimestamp',
  BAD_TO: 'ERR TSDB: wrong toTimestamp',
  BAD_COUNT: "ERR TSDB: Couldn't parse COUNT",
  BAD_ALIGN: 'ERR TSDB: unknown ALIGN parameter',
  ALIGN_WITHOUT_AGGREGATION: 'ERR TSDB: ALIGN parameter can only be used with AGGREGATION',
  BAD_AGGREGATION: "ERR TSDB: Couldn't parse AGGREGATION",
  UNKNOWN_AGGREGATION: 'ERR TSDB: Unknown aggregation type',
  BAD_BUCKET_DURATION: 'ERR TSDB: bucketDuration must be greater than zero',
  BAD_BUCKET_TIMESTAMP: 'ERR TSDB: unknown BUCKETTIMESTAMP parameter',
  BUCKET_TIMESTAMP_WITHOUT_AGGREGATION: 'ERR TSDB: BUCKETTIMESTAMP parameter can only be used with AGGREGATION',
  EMPTY_WITHOUT_AGGREGATION: 'ERR TSDB: EMPTY parameter can only be used with AGGREGATION',
  BAD_FILTER_BY_VALUE: "ERR TSDB: Couldn't parse FILTER_BY_VALUE",
  BAD_FILTER_BY_TS: "ERR TSDB: Couldn't parse FILTER_BY_TS",

  // multi-key queries
  MISSING_FILTER: 'ERR TSDB: missing FILTER argument',
  BAD_FILTER: 'ERR TSDB: failed parsing labels',
  NO_MATCHER: 'ERR TSDB: please provide at least one matcher',
  LABELS_CONFLICT: 'ERR TSDB: cannot accept WITHLABELS and SELECT_LABELS together',
  BAD_GROUPBY: "ERR TSDB: Couldn't parse GROUPBY",
  UNKNOWN_REDUCER: 'ERR TSDB: Unknown REDUCE type',

  // compaction rules
  SAME_KEYS: 'ERR TSDB: the source key and destination key should be different',
  DEST_HAS_SOURCE: 'ERR TSDB: the destination key already has a src rule',
  DEST_HAS_RULES: 'ERR TSDB: the destination key already has a dst rule',
  SOURCE_IS_DEST: 'ERR TSDB: the source key already has a source rule',
  RULE_NOT_FOUND: 'ERR TSDB: compaction rule does not exist',

  // config (CONFIG SET reasons, wrapped by the server's CONFIG SET failure text)
  BAD_COMPACTION_POLICY: 'Invalid compaction policy',
  BAD_IGNORE_MAX_VAL_DIFF: 'argument must be a non-negative number',
} as const;

export default TimeseriesMessages;
