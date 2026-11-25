/**
 * Replies of the pub/sub commands, word for word as Redis sends them. Texts shared with other modules (unknown
 * subcommand, wrong number of arguments…) live in `@/libs/resp/messages`.
 */
export const PubSubMessages = {
  // Templates: fill the {placeholders} with formatMessage() from @/libs/message-format
  DENY_BLOCKING: "ERR {command} isn't allowed for a DENY BLOCKING client",
  SUBCOMMAND_ARITY: "ERR wrong number of arguments for 'pubsub|{subcommand}' command",
  UNKNOWN_OR_ARITY: "ERR unknown subcommand or wrong number of arguments for '{subcommand}'. Try PUBSUB HELP.",

  /** PUBSUB HELP, one reply line per entry. */
  HELP: [
    'PUBSUB <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
    'CHANNELS [<pattern>]',
    "    Return the currently active channels matching a <pattern> (default: '*').",
    'NUMPAT',
    '    Return number of subscriptions to patterns.',
    'NUMSUB [<channel> ...]',
    '    Return the number of subscribers for the specified channels, excluding',
    '    pattern subscriptions(default: no channels).',
    'SHARDCHANNELS [<pattern>]',
    "    Return the currently active shard level channels matching a <pattern> (default: '*').",
    'SHARDNUMSUB [<shardchannel> ...]',
    '    Return the number of subscribers for the specified shard level channel(s)',
    'HELP',
    '    Print this help.',
  ],
} as const;

export default PubSubMessages;
