/**
 * FAILOVER [TO host port [FORCE]] [ABORT] [TIMEOUT milliseconds]: a coordinated switch of the master role to one of
 * this master's replicas (the sequence is run by the server's Replication runtime).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { FailoverInput } from './replication.dto';

export default class ReplicationFailoverService {
  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  static failover(ctx: CommandContext, { abort, host, port, force, timeoutMs }: FailoverInput): Reply {
    const replication = ctx.server.replication;
    return abort ? replication.failoverAbort() : replication.failoverStart({ host, port, force, timeoutMs });
  }
}
