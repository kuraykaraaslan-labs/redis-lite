/**
 * Base layer of the per-server replication runtime: the replication identity (replication ID, secondary ID and
 * offsets), the backlog and the attached replicas, and feeding the replication stream.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * The runtime is one stateful object (one per server, `server.replication`), split by responsibility into layers, each
 * its own file:
 *
 *   ReplicationState → ReplicationPrimary (replicas attached to this server: PSYNC, the stream, acks, WAIT)
 *   → ReplicationReplica (this server as a replica: REPLICAOF, the link, loading, applying the stream)
 *   → Replication (cron, FAILOVER, ROLE / INFO, config hooks; replication.core.ts)
 *
 * Offsets follow INFO replication: `master_repl_offset` counts every byte ever fed to the stream under the current
 * history. A replica's stream is the master's, byte for byte, so after promotion its replicas can continue (PSYNC2):
 * the old ID becomes `master_replid2`, valid up to `second_repl_offset`.
 */
import { randomBytes } from 'node:crypto';

import Logger from '@/libs/logger';

import type { Client, RedisLiteServer } from '@/modules/server/server.service';

import { ReplicationBacklog } from './replication.backlog.structure';
import type { ReplicationRole } from './replication.enums';
import ReplicationMessages from './replication.messages';
import type { ReplicaInfo } from './replication.types';

export abstract class ReplicationState {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** master_replid2 when there is no secondary ID. */
  static readonly NO_REPLID = '0'.repeat(40);

  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  role: ReplicationRole = 'master';
  /** master_replid: the ID of the current history. */
  replid = ReplicationState.newReplId();
  /** master_replid2 / second_repl_offset: the previous history, valid up to that offset (PSYNC after promotion). */
  replid2 = ReplicationState.NO_REPLID;
  secondOffset = -1;
  /** master_repl_offset. */
  offset = 0;
  backlog: ReplicationBacklog | null = null;
  /** Connections attached as replicas (PSYNC / SYNC accepted). */
  readonly replicas = new Set<Client>();
  /** INFO stats sync_full / sync_partial_ok / sync_partial_err. */
  readonly stats = { syncFull: 0, syncPartialOk: 0, syncPartialErr: 0 };
  /** When the last replica went away (repl-backlog-ttl); null while replicas are attached. */
  protected noReplicasSince: number | null = Date.now();

  constructor(protected readonly server: RedisLiteServer) {}

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  static newReplId(): string {
    return randomBytes(20).toString('hex');
  }

  protected cfg(name: string): string {
    return this.server.config.get(name) ?? '';
  }

  protected num(name: string): number {
    return this.server.config.num(name);
  }

  get isReplica(): boolean {
    return this.role === 'slave';
  }

  /** The replica info of a connection, created on its first REPLCONF / PSYNC. */
  protected replicaInfo(client: Client): ReplicaInfo {
    client.replica ??= {
      attached: false,
      state: 'wait_bgsave',
      listeningPort: 0,
      announcedIp: null,
      capaEof: false,
      capaPsync2: false,
      ackOffset: 0,
      aofAckOffset: -1,
      ackTime: Date.now(),
      psync: true,
      pendingSync: null,
    };
    return client.replica;
  }

  // ──────────────────────────────────────────────
  // Replication ID
  // ──────────────────────────────────────────────

  /** DEBUG CHANGE-REPL-ID, and a fresh history: new ID, no secondary ID. */
  changeReplId(): void {
    this.replid = ReplicationState.newReplId();
    this.replid2 = ReplicationState.NO_REPLID;
    this.secondOffset = -1;
  }

  /** Promotion: the current history becomes the secondary one (valid up to the next byte) and a new one starts. */
  protected shiftReplId(): void {
    this.replid2 = this.replid;
    this.secondOffset = this.offset + 1;
    this.replid = ReplicationState.newReplId();
  }

  // ──────────────────────────────────────────────
  // Backlog
  // ──────────────────────────────────────────────

  /**
   * Creates the backlog (empty, starting after the current offset) when there is none. On a master that starts a new
   * history: writes made while there was no backlog were never fed to the stream, so a replica holding the old ID and
   * offset must not be able to continue from it (it gets a full sync instead).
   */
  protected ensureBacklog(): void {
    if (this.backlog) return;
    if (this.role === 'master') this.changeReplId();
    this.backlog = new ReplicationBacklog(this.num('repl-backlog-size'), this.offset);
  }

  protected freeBacklog(): void {
    this.backlog = null;
  }

  // ──────────────────────────────────────────────
  // Stream
  // ──────────────────────────────────────────────

  /**
   * Appends bytes to the replication stream: the offset moves, the backlog keeps them and every attached replica past
   * its full sync receives them.
   */
  protected feedStream(data: Buffer): void {
    if (!data.length || !this.backlog) return;
    this.offset += data.length;
    this.backlog.append(data);
    for (const client of this.replicas) {
      if (client.replica?.state !== 'wait_bgsave') this.writeRaw(client, data);
    }
  }

  /** Writes stream / handshake bytes to a replica connection (replies are suppressed for replicas, this is not). */
  protected writeRaw(client: Client, data: Buffer | string): void {
    const socket = client.socket;
    if (!socket || client.closed || socket.destroyed) return;
    const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    client.netOut += buf.length;
    socket.write(buf);
  }

  /** A replica connection closed (or was dropped): it is no longer fed. */
  detach(client: Client): void {
    const info = client.replica;
    if (!info) return;
    if (info.pendingSync) clearTimeout(info.pendingSync);
    info.pendingSync = null;
    if (this.replicas.delete(client)) {
      Logger.info(ReplicationMessages.LOG_REPLICA_LOST, { addr: client.address });
      if (!this.replicas.size) this.noReplicasSince = Date.now();
    }
  }

  /** Closes every attached replica connection (they reconnect and PSYNC again). */
  protected disconnectReplicas(): void {
    for (const client of [...this.replicas]) {
      this.detach(client);
      this.server.killClient(client);
    }
  }
}
