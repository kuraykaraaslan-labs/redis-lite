/**
 * Replies of the pub/sub commands, word for word as Redis sends them. Texts shared with other modules (unknown
 * subcommand, wrong number of arguments…) live in `@/libs/resp/messages`.
 */
export const PubSubMessages = {
  // Templates: fill the {placeholders} with formatMessage() from @/libs/message-format
  DENY_BLOCKING: "ERR {command} isn't allowed for a DENY BLOCKING client",
  SUBCOMMAND_ARITY: "ERR wrong number of arguments for 'pubsub|{subcommand}' command",
  UNKNOWN_OR_ARITY: "ERR unknown subcommand or wrong number of arguments for '{subcommand}'. Try PUBSUB HELP.",
} as const;

export default PubSubMessages;
