/** Replies of the transaction commands (MULTI, EXEC, DISCARD, WATCH), word for word as Redis sends them. */
export const TransactionsMessages = {
  MULTI_NESTED: 'ERR MULTI calls can not be nested',
  EXEC_WITHOUT_MULTI: 'ERR EXEC without MULTI',
  DISCARD_WITHOUT_MULTI: 'ERR DISCARD without MULTI',
  WATCH_IN_MULTI: 'ERR WATCH inside MULTI is not allowed',
  EXECABORT: 'EXECABORT Transaction discarded because of previous errors.',

  // Redis execCommand(): a queued command became forbidden between MULTI and EXEC
  ACL_CHANGED:
    'NOPERM ACLs rules changed between the moment the transaction was accumulated and the EXEC call. This command is no longer allowed for the following reason: {reason}',
  ACL_REASON_COMMAND: 'no permission to execute the command or subcommand',
  ACL_REASON_KEY: 'no permission to touch the specified keys',
  ACL_REASON_CHANNEL: 'no permission to access one of the channels used as arguments',
} as const;

export default TransactionsMessages;
