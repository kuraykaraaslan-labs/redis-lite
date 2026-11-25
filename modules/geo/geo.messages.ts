/**
 * Error replies of the geo commands, word for word as Redis sends them. Texts shared with other modules (syntax error,
 * not a float, not an integer, WRONGTYPE…) live in `@/libs/resp/messages`.
 */
export const GeoMessages = {
  UNSUPPORTED_UNIT: 'ERR unsupported unit provided. please use M, KM, FT, MI',
  NEED_NUMERIC_RADIUS: 'ERR need numeric radius',
  RADIUS_NEGATIVE: 'ERR radius cannot be negative',
  NEED_NUMERIC_WIDTH: 'ERR need numeric width',
  NEED_NUMERIC_HEIGHT: 'ERR need numeric height',
  WIDTH_HEIGHT_NEGATIVE: 'ERR height or width cannot be negative',
  COUNT_NOT_POSITIVE: 'ERR COUNT must be > 0',
  SEARCHSTORE_WITH_OPTIONS: 'ERR GEOSEARCHSTORE is not compatible with WITHDIST, WITHHASH and WITHCOORD options',
  STORE_WITH_OPTIONS: 'ERR STORE option in GEORADIUS is not compatible with WITHDIST, WITHHASH and WITHCOORD options',
  ANY_REQUIRES_COUNT: 'ERR the ANY argument requires COUNT argument',
  MEMBER_NOT_DECODED: 'ERR could not decode requested zset member',

  // Templates: fill the {placeholders} with formatMessage() from @/libs/message-format
  INVALID_LON_LAT: 'ERR invalid longitude,latitude pair {lon},{lat}',
  // Redis formats these two with the command name as typed (argv[0]); the canonical uppercase name is used here.
  EXACTLY_ONE_FROM: 'ERR exactly one of FROMMEMBER or FROMLONLAT can be specified for {command}',
  EXACTLY_ONE_BY: 'ERR exactly one of BYRADIUS and BYBOX can be specified for {command}',
} as const;

export default GeoMessages;
