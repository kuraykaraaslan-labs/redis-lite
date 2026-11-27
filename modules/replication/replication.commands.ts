/**
 * Routing of the replication commands: name, arity, flags, then DTO → service. ROLE and WAIT are routed by
 * the server module (their DTOs are pinned there) and reach the same runtime.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import { FailoverDTO, PsyncDTO, ReplconfDTO, ReplicaOfDTO } from './replication.dto';
import ReplicationService from './replication.service';

const NOSCRIPT = { noscript: true } as const;

export const replicationCommands: CommandSpec[] = [
  { name: 'replicaof', arity: 3, flags: NOSCRIPT, handler: withDTO(ReplicaOfDTO, ReplicationService.replicaOf) },
  { name: 'slaveof', arity: 3, flags: NOSCRIPT, handler: withDTO(ReplicaOfDTO, ReplicationService.replicaOf) },
  { name: 'psync', arity: -3, flags: NOSCRIPT, handler: withDTO(PsyncDTO, ReplicationService.psync) },
  { name: 'sync', arity: 1, flags: NOSCRIPT, handler: (ctx) => ReplicationService.sync(ctx) },
  { name: 'replconf', arity: -1, flags: NOSCRIPT, handler: withDTO(ReplconfDTO, ReplicationService.replconf) },
  { name: 'failover', arity: -1, flags: NOSCRIPT, handler: withDTO(FailoverDTO, ReplicationService.failover) },
];
