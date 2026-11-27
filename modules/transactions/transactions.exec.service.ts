import { formatMessage } from '@/libs/message-format';
import { NULL_ARRAY, RespError } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { AclDenial } from '@/modules/acl/acl.types';
import { Block, NO_REPLY } from '@/modules/command/command.service';
import type { CommandContext, HandlerResult } from '@/modules/command/command.types';
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

  /**
   * Clients running EXEC → the replies the current queued command wrote itself (SUBSCRIBE's pushes). Redis appends
   * them to the client's output in place, so they land inside EXEC's array instead of before it.
   */
  private static readonly inlined = new WeakMap<Client, Reply[]>();

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** A command that writes its own replies (the (UN)SUBSCRIBE family) hands them to EXEC; false outside EXEC. */
  static inlineReply(client: Client, reply: Reply): boolean {
    const sink = TransactionsExecService.inlined.get(client);
    if (!sink) return false;
    sink.push(reply);
    return true;
  }

  /** EXEC: one reply per queued command; null when a WATCHed key changed, EXECABORT when queueing failed. */
  static exec(ctx: CommandContext): Reply {
    const { server, client } = ctx;
    const queued = client.multi;
    if (!queued) return new RespError(TransactionsMessages.EXEC_WITHOUT_MULTI);
    const aborted = client.multiError;
    const dirty = client.watched.dirty || server.watchedKeyExpired(client);
    client.multi = null;
    client.multiError = false;
    client.watched.clear();
    if (aborted) return new RespError(TransactionsMessages.EXECABORT);
    if (dirty) return NULL_ARRAY;
    const replies: Reply[] = [];
    client.inExec = true;
    client.execQueued = queued.length;
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
        const sink: Reply[] = [];
        TransactionsExecService.inlined.set(client, sink);
        let r: HandlerResult;
        try {
          r = server.execute(client, argv, { inScript: false, noBlock: true });
        } finally {
          TransactionsExecService.inlined.delete(client);
        }
        // a command answering with several pushes (SUBSCRIBE a b) adds them all; Redis still counts it as one reply
        if (r === NO_REPLY && sink.length) replies.push(...sink);
        else replies.push(r instanceof Block || r === NO_REPLY ? NULL_ARRAY : r);
      }
    } finally {
      client.inExec = false;
    }
    return replies;
  }
}
