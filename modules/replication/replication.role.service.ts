/**
 * REPLICAOF / SLAVEOF and ROLE: switching and reporting the replication role. The state lives in the server's
 * Replication runtime (`ctx.server.replication`).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { ReplicaOfInput } from './replication.dto';

export default class ReplicationRoleService {
  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** REPLICAOF host port (follow that master) / REPLICAOF NO ONE (become a master). */
  static replicaOf(ctx: CommandContext, input: ReplicaOfInput): Reply {
    const replication = ctx.server.replication;
    return input.noOne ? replication.replicaOfNoOne() : replication.replicaOf(input.host, input.port);
  }

  /** ROLE: `master` with its offset and replicas, or `slave` with its master, link state and offset. */
  static role(ctx: CommandContext): Reply {
    return ctx.server.replication.roleReply();
  }
}
