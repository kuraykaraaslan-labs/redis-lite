import { formatMessage } from '@/libs/message-format';
import { NULL_ARRAY, RespError } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { AclDenial } from '@/modules/acl/acl.types';
import { Block, NO_REPLY } from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';
import type { Client } from '@/modules/server/server.service';

import TransactionsMessages from './transactions.messages';

/** EXEC: runs the queued commands as one unit, unless the queue was flagged or a WATCHed key changed. */
export default class TransactionsExecService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Redis execCommand(): why a queued command became forbidden between MULTI and EXEC. */
  private static readonly ACL_REASONS: Record<AclDenial['reason'], string> = {
    command: TransactionsMessages.ACL_REASON_COMMAND,
    key: TransactionsMessages.ACL_REASON_KEY,
    channel: TransactionsMessages.ACL_REASON_CHANNEL,
  };

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** A WATCHed key changed since WATCH (its version moved). */
  private static watchDirty(ctx: CommandContext, client: Client): boolean {
    for (const [k, version] of client.watched) {
      const sep = k.indexOf(':');
      if (ctx.server.keyVersion(Number(k.slice(0, sep)), k.slice(sep + 1)) !== version) return true;
    }
    return false;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** EXEC: one reply per queued command; null when a WATCHed key changed, EXECABORT when queueing failed. */
  static exec(ctx: CommandContext): Reply {
    const { server, client } = ctx;
    const queued = client.multi;
    if (!queued) return new RespError(TransactionsMessages.EXEC_WITHOUT_MULTI);
    const aborted = client.multiError;
    const dirty = TransactionsExecService.watchDirty(ctx, client);
    client.multi = null;
    client.multiError = false;
    client.watched.clear();
    if (aborted) return new RespError(TransactionsMessages.EXECABORT);
    if (dirty) return NULL_ARRAY;
    const replies: Reply[] = [];
    client.inExec = true;
    try {
      for (const argv of queued) {
        // ACL permissions are checked again at EXEC time in case they changed after the commands were queued
        const denial = server.aclDenial(client, argv);
        if (denial) {
          client.lastCommand = 'exec';
          server.aclLogDenial(client, denial, 'multi');
          const message = formatMessage(TransactionsMessages.ACL_CHANGED, { reason: TransactionsExecService.ACL_REASONS[denial.reason] });
          server.countError(message);
          replies.push(new RespError(message));
          continue;
        }
        const r = server.execute(client, argv, { inScript: false, noBlock: true });
        replies.push(r instanceof Block || r === NO_REPLY ? NULL_ARRAY : r);
      }
    } finally {
      client.inExec = false;
    }
    return replies;
  }
}
