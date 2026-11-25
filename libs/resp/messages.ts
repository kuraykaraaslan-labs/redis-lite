import { formatMessage } from '@/libs/message-format';

/**
 * Error replies shared by several modules or by the `@/libs/schemas` primitives, word for word as Redis sends them:
 * clients and BullMQ match on some of these. A text used by one module only belongs in that module's
 * `<module>.messages.ts`.
 */
export const RespMessages = {
  WRONGTYPE: 'WRONGTYPE Operation against a key holding the wrong kind of value',
  NOT_INTEGER: 'ERR value is not an integer or out of range',
  NOT_FLOAT: 'ERR value is not a valid float',
  SYNTAX: 'ERR syntax error',
  INVALID_CURSOR: 'ERR invalid cursor',
  INCR_OVERFLOW: 'ERR increment or decrement would overflow',
  NAN_OR_INF: 'ERR increment would produce NaN or Infinity',
  INVALID_EXPIRE: "ERR invalid expire time in '{command}' command",
  TIMEOUT_NEGATIVE: 'ERR timeout is negative',
  TIMEOUT_NOT_FLOAT: 'ERR timeout is not a float or out of range',
  COUNT_POSITIVE: 'ERR value is out of range, must be positive',

  // Protocol errors of the request parser: sent as `-ERR <text>`, then the connection is closed
  PROTOCOL_ERROR: 'Protocol error',
  PROTOCOL_MBULK_TOO_BIG: 'Protocol error: too big mbulk count string',
  PROTOCOL_INVALID_MBULK: 'Protocol error: invalid multibulk length',
  PROTOCOL_BULK_TOO_BIG: 'Protocol error: too big bulk count string',
  PROTOCOL_INVALID_BULK: 'Protocol error: invalid bulk length',
  PROTOCOL_INLINE_TOO_BIG: 'Protocol error: too big inline request',
  PROTOCOL_UNBALANCED_QUOTES: 'Protocol error: unbalanced quotes in request',

  // Templates: fill the {placeholders} with formatMessage() from @/libs/message-format
  WRONG_ARITY: "ERR wrong number of arguments for '{command}' command",
  UNKNOWN_SUBCOMMAND: "ERR unknown subcommand '{subcommand}'. Try {command} HELP.",
  UNKNOWN_COMMAND: "ERR unknown command '{command}', with args beginning with: {args}",
  PROTOCOL_EXPECTED_DOLLAR: "Protocol error: expected '$', got '{got}'",
} as const;

export function unknownCommand(name: string, args: string[]): string {
  const shown = args.slice(0, 20).map((a) => `'${a.slice(0, 128)}'`).join(' ');
  return formatMessage(RespMessages.UNKNOWN_COMMAND, { command: name, args: shown ? `${shown} ` : '' });
}

export function wrongArity(name: string): string {
  return formatMessage(RespMessages.WRONG_ARITY, { command: name.toLowerCase() });
}

export function unknownSubcommand(sub: string, cmd: string): string {
  return formatMessage(RespMessages.UNKNOWN_SUBCOMMAND, { subcommand: sub, command: cmd.toUpperCase() });
}

export default RespMessages;
