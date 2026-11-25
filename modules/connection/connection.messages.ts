/**
 * Replies of the connection commands (PING, AUTH, HELLO, SELECT, CLIENT, RESET…), word for word as Redis sends them.
 * Texts shared with other modules (syntax error, not an integer, arity…) live in `@/libs/resp/messages`.
 */
export const ConnectionMessages = {
  // Authentication and handshake
  WRONGPASS: 'WRONGPASS invalid username-password pair or user is disabled.',
  AUTH_NO_PASSWORD: 'ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?',
  NOPROTO: 'NOPROTO unsupported protocol version',
  HELLO_PROTOCOL_NOT_INTEGER: 'ERR Protocol version is not an integer or out of range',
  HELLO_NOAUTH:
    'NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time',

  // Session
  DB_INDEX: 'ERR DB index is out of range',
  CLUSTER_DISABLED: 'ERR This instance has cluster support disabled',
  RESET_STATUS: 'RESET',

  // CLIENT
  NAME_INVALID: 'ERR Client names cannot contain spaces, newlines or special characters.',
  CLIENT_ID_INVALID: 'ERR Invalid client ID',
  CLIENT_ID_POSITIVE: 'ERR client-id should be greater than 0',
  NO_SUCH_CLIENT: 'ERR No such client',
  UNBLOCK_REASON: 'ERR CLIENT UNBLOCK reason should be TIMEOUT or ERROR',
  PAUSE_TIMEOUT_NOT_INTEGER: 'ERR timeout is not an integer or out of range',
  TIMEOUT_NEGATIVE: 'ERR timeout is negative',

  // Templates: fill the {placeholders} with formatMessage() from @/libs/message-format
  HELLO_SYNTAX: "ERR Syntax error in HELLO option '{option}'",
  CLIENT_TYPE_UNKNOWN: "ERR Unknown client type '{type}'",
  NO_SUCH_USER: "ERR No such user '{user}'",
  SETINFO_UNRECOGNIZED: "ERR Unrecognized option '{option}'",
  SETINFO_INVALID: 'ERR {option} cannot contain spaces, newlines or special characters.',
} as const;

export default ConnectionMessages;
