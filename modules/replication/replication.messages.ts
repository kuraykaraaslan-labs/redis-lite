/**
 * Error and status texts of the replication module, word for word as Redis sends them (from the command pages and
 * observed replies; the ones marked UNCERTAIN could not be confirmed from the documentation).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
export const ReplicationMessages = {
  // client-facing refusals
  READONLY: "READONLY You can't write against a read only replica.",
  MASTERDOWN: "MASTERDOWN Link with MASTER is down and replica-serve-stale-data is set to 'no'.",
  NOREPLICAS: 'NOREPLICAS Not enough good replicas to write.',

  // REPLICAOF / SLAVEOF
  ALREADY_CONNECTED: 'OK Already connected to specified master',
  // UNCERTAIN: REPLICAOF NO ONE / host port while a FAILOVER runs
  REPLICAOF_DURING_FAILOVER: 'ERR REPLICAOF not allowed while failing over.',

  // PSYNC / SYNC / REPLCONF
  NOMASTERLINK: "NOMASTERLINK Can't SYNC while not connected with my master",
  // UNCERTAIN: PSYNC … FAILOVER that does not come from this replica's master history
  PSYNC_FAILOVER_REFUSED: 'ERR PSYNC FAILOVER replid must match my replid.',
  REPLCONF_UNKNOWN: 'ERR Unrecognized REPLCONF option: {option}',

  // WAIT
  WAIT_ON_REPLICA:
    'ERR WAIT cannot be used with replica instances. Please also note that since Redis 4.0 if a replica is configured to be writable (which is not the default) writes to replicas are just local and are not propagated.',

  // FAILOVER (UNCERTAIN: wording of the less common refusals)
  FAILOVER_ON_REPLICA: 'ERR FAILOVER is not valid when server is a replica.',
  FAILOVER_NO_REPLICAS: 'ERR FAILOVER requires connected replicas.',
  FAILOVER_IN_PROGRESS: 'ERR FAILOVER already in progress.',
  FAILOVER_NOT_IN_PROGRESS: 'ERR FAILOVER is not in progress.',
  FAILOVER_NOT_A_REPLICA: 'ERR FAILOVER target HOST and PORT is not a replica.',
  FAILOVER_NOT_ONLINE: 'ERR FAILOVER target replica is not online.',
  FAILOVER_FORCE: 'ERR FAILOVER with force option requires both a timeout and target HOST and IP.',
  FAILOVER_TIMEOUT: 'ERR FAILOVER timeout must be greater than 0',

  // log lines (static texts, details in the log context)
  LOG_CONNECTING: '[ReplicaLink.connect] Connecting to MASTER',
  LOG_LINK_LOST: '[ReplicaLink.lost] Connection with master lost',
  LOG_HANDSHAKE_ERROR: '[ReplicaLink.handshake] Unexpected reply from master',
  LOG_FULL_SYNC: '[Replication.fullSync] Full resync from master',
  LOG_PARTIAL_SYNC: '[Replication.partialSync] Successful partial resynchronization with master',
  LOG_LOAD_FAILED: '[Replication.loadPayload] Failed loading the RDB received from the master',
  LOG_REPLICA_ATTACHED: '[ReplicationPrimary.psync] Replica attached',
  LOG_REPLICA_LOST: '[ReplicationPrimary.detach] Connection with replica lost',
  LOG_PROMOTED: '[Replication.becomeMaster] MASTER MODE enabled',
  LOG_FAILOVER: '[Replication.failover] Failover state changed',
  LOG_TIMEOUT: '[ReplicaLink.cron] MASTER timeout: no data nor PING received',
} as const;

export default ReplicationMessages;
