/**
 * Error replies of the keyspace (SCAN-family grammar), word for word as Redis sends them. Texts shared with other
 * modules (WRONGTYPE, syntax error…) live in `@/libs/resp/messages`.
 */
export const DatabaseMessages = {
  INVALID_CURSOR: 'ERR invalid cursor',
} as const;

export default DatabaseMessages;
