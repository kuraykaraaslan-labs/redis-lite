/**
 * Texts of the command layer (blocking timeouts, container help, subcommand errors), word for word as Redis sends them.
 * Texts shared with every module (syntax error, arity…) live in `@/libs/resp/messages`.
 */
export const CommandMessages = {
  TIMEOUT_NOT_FLOAT: 'ERR timeout is not a float or out of range',
  TIMEOUT_NEGATIVE: 'ERR timeout is negative',

  // Templates: fill the {placeholders} with formatMessage() from @/libs/message-format
  SUBCOMMAND_SYNTAX: "ERR unknown subcommand or wrong number of arguments for '{subcommand}'. Try {command} HELP.",
  HELP_HEADER: '{command} <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
  HELP_FOOTER_NAME: 'HELP',
  HELP_FOOTER_TEXT: '    Print this help.',
  BAD_ARGUMENT_SPEC: 'bad argument spec: {spec}',
} as const;

export default CommandMessages;
