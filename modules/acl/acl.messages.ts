/**
 * Texts of the ACL module, word for word as Redis sends them (acl.c). Templates: fill the `{placeholders}` with
 * formatMessage() from `@/libs/message-format`.
 */
export const AclMessages = {
  // ============================================================================
  // Users (ACL SETUSER / DELUSER / GETUSER / DRYRUN / GENPASS / CAT)
  // ============================================================================
  USERNAME_SPACES: "ERR Usernames can't contain spaces or null characters",
  DEFAULT_UNDELETABLE: "ERR The 'default' user cannot be removed",
  GENPASS_RANGE: 'ERR ACL GENPASS argument must be the number of bits for the output password, a positive number up to 4096',
  USER_NOT_FOUND: "ERR User '{name}' not found",
  COMMAND_NOT_FOUND: "ERR Command '{name}' not found",
  /** `{name}` is cut to 128 characters. */
  UNKNOWN_CATEGORY: "ERR Unknown category '{name}'",
  UNMATCHED_PAREN: "ERR Unmatched parenthesis in acl selector starting at '{arg}'.",
  SETUSER_MODIFIER: "ERR Error in ACL SETUSER modifier '{op}': {error}",

  // ============================================================================
  // Rule errors (ACLSetUserStringError), by errno
  // ============================================================================
  RULE_ENOENT: 'Unknown command or category name in ACL',
  RULE_EINVAL: 'Syntax error',
  RULE_EEXIST:
    "Adding a pattern after the * pattern (or the 'allkeys' flag) is not valid and does not have any effect. " +
    "Try 'resetkeys' to start with an empty list of patterns",
  RULE_EISDIR:
    "Adding a pattern after the * pattern (or the 'allchannels' flag) is not valid and does not have any effect. " +
    "Try 'resetchannels' to start with an empty list of channels",
  RULE_ENODEV: 'The password you are trying to remove from the user does not exist',
  RULE_EBADMSG: 'The password hash must be exactly 64 characters and contain only lowercase hexadecimal characters',
  RULE_ECHILD: 'Allowing first-arg of a subcommand is not supported',

  // ============================================================================
  // Denials (getAclErrorMessage); the _VERBOSE forms are ACL DRYRUN's
  // ============================================================================
  DENIED_COMMAND: "User {username} has no permissions to run the '{object}' command",
  DENIED_KEY: 'No permissions to access a key',
  DENIED_KEY_VERBOSE: "No permissions to access the '{object}' key",
  DENIED_CHANNEL: 'No permissions to access a channel',
  DENIED_CHANNEL_VERBOSE: "No permissions to access the '{object}' channel",
  NOPERM: 'NOPERM {message}',

  // ============================================================================
  // ACL file (ACL LOAD / aclfile): the errors of every line are joined, then sent as one ERR
  // ============================================================================
  FILE_ERRORS: 'ERR {errors}',
  FILE_NO_USER_KEYWORD: '{filename}:{line} should start with user keyword. ',
  FILE_BAD_USERNAME: "'{filename}:{line}: username '{name}' contains invalid characters. ",
  FILE_DUPLICATE_USER: "WARNING: Duplicate user '{name}' found on line {line}. ",
  FILE_UNMATCHED_PAREN: '{filename}:{line}: Unmatched parenthesis in selector definition.',
  FILE_RULE_ERROR: "{filename}:{line}: Error in applying operation '{op}': {error}. ",
  FILE_SYNTAX_ERROR: '{filename}:{line}: {error}. ',

  // ============================================================================
  // Internal errors (not replies)
  // ============================================================================
  DEFAULT_USER_MISSING: 'ACL: default user missing',
} as const;

export default AclMessages;
