/**
 * The internal commands replicas send their master: PSYNC, SYNC and REPLCONF (listening-port, ip-address, capa, ACK,
 * GETACK). After PSYNC / SYNC the connection carries the replication stream and gets no replies.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { OK } from '@/libs/resp';

import { NO_REPLY } from '@/modules/command/command.service';
import type { CommandContext, HandlerResult } from '@/modules/command/command.types';

import type { PsyncInput, ReplconfInput } from './replication.dto';

export default class ReplicationSyncService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static integer(raw: string | undefined): number | null {
    if (raw === undefined || !/^-?\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** PSYNC replicationid offset [FAILOVER]: +CONTINUE (partial) or +FULLRESYNC and the RDB, then the stream. */
  static psync(ctx: CommandContext, { replid, offset, failover }: PsyncInput): HandlerResult {
    return ctx.server.replication.psync(ctx.client, replid, offset, failover);
  }

  /** SYNC: the RDB then the stream, without the PSYNC handshake line. */
  static sync(ctx: CommandContext): HandlerResult {
    return ctx.server.replication.sync(ctx.client);
  }

  /**
   * REPLCONF option value …: OK for the handshake options; ACK (from a replica) and GETACK (from the master) are never
   * answered.
   */
  static replconf(ctx: CommandContext, { pairs }: ReplconfInput): HandlerResult {
    const S = ReplicationSyncService;
    const replication = ctx.server.replication;
    let reply: HandlerResult = OK;
    for (const { option, value } of pairs) {
      switch (option) {
        case 'listening-port':
        case 'ip-address':
        case 'capa':
          replication.replicaConfigure(ctx.client, option, value);
          break;
        case 'ack': {
          const offset = S.integer(value);
          if (offset !== null) replication.replicaAck(ctx.client, offset);
          reply = NO_REPLY;
          break;
        }
        case 'getack':
          replication.getAck(ctx.client);
          reply = NO_REPLY;
          break;
        case 'rdb-only':
        case 'rdb-filter-only':
          // a replica that only wants the RDB: accepted, the stream follows anyway
          break;
      }
    }
    return reply;
  }
}
