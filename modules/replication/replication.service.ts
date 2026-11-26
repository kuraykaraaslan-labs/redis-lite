/**
 * The replication module's public API: one flat facade over the sub-services, plus the per-server runtime class
 * (Replication, built by server.core). Other modules import only this file (and the types / enums / messages).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import ReplicationFailoverService from './replication.failover.service';
import ReplicationRoleService from './replication.role.service';
import ReplicationSyncService from './replication.sync.service';

export { ReplicationFailoverService, ReplicationRoleService, ReplicationSyncService };
export { Replication } from './replication.core';

export default class ReplicationService {
  // Role — REPLICAOF / SLAVEOF, ROLE
  static replicaOf = ReplicationRoleService.replicaOf.bind(ReplicationRoleService);
  static role = ReplicationRoleService.role.bind(ReplicationRoleService);

  // Sync — PSYNC, SYNC, REPLCONF
  static psync = ReplicationSyncService.psync.bind(ReplicationSyncService);
  static sync = ReplicationSyncService.sync.bind(ReplicationSyncService);
  static replconf = ReplicationSyncService.replconf.bind(ReplicationSyncService);

  // Failover — FAILOVER
  static failover = ReplicationFailoverService.failover.bind(ReplicationFailoverService);
}
