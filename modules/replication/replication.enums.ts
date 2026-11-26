/**
 * Enums of the replication module.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { z } from 'zod';

/** INFO `role` / ROLE: this server's role (Redis still prints `slave`). */
export const ReplicationRoleEnum = z.enum(['master', 'slave']);

/**
 * Replica side: the state of the link to the master, as ROLE reports it. `connect`: must connect; `connecting`: the
 * TCP connection or the handshake is in progress; `sync`: receiving the RDB; `connected`: online.
 */
export const LinkStateEnum = z.enum(['connect', 'connecting', 'sync', 'connected']);

/** Master side: a replica connection's state (INFO `slaveN:…,state=`). */
export const ReplicaStateEnum = z.enum(['wait_bgsave', 'send_bulk', 'online']);

/** INFO `master_failover_state`. */
export const FailoverStateEnum = z.enum(['no-failover', 'waiting-for-sync', 'failover-in-progress']);

/** `repl-diskless-load`. */
export const DisklessLoadEnum = z.enum(['disabled', 'on-empty-db', 'swapdb']);

/** REPLCONF options this server understands. */
export const ReplconfOptionEnum = z.enum(['listening-port', 'ip-address', 'capa', 'ack', 'getack', 'rdb-only', 'rdb-filter-only']);

// ============================================================================
// Type Exports
// ============================================================================

export type ReplicationRole = z.infer<typeof ReplicationRoleEnum>;
export type LinkState = z.infer<typeof LinkStateEnum>;
export type ReplicaState = z.infer<typeof ReplicaStateEnum>;
export type FailoverState = z.infer<typeof FailoverStateEnum>;
export type DisklessLoad = z.infer<typeof DisklessLoadEnum>;
export type ReplconfOption = z.infer<typeof ReplconfOptionEnum>;
