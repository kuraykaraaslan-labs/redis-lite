/**
 * Replica side of the replication runtime: following a master (REPLICAOF host port), loading its RDB into a fresh
 * dataset, applying its command stream, acknowledging it, and going back to master (REPLICAOF NO ONE) with the PSYNC2
 * ID shift so other replicas can continue.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * The stream runs as the master client (CLIENT LIST flag M), through the normal dispatcher, which lets it write on a
 * read-only replica. While it runs, keys whose TTL elapsed are still visible to it (replicas never expire keys
 * themselves; they wait for the master's DEL). The replica's offset advances per command, but at transaction
 * boundaries only: the bytes of a MULTI … EXEC enter the offset and the backlog once the EXEC ran, so a link lost
 * inside a transaction resumes from its start. Sub-replicas receive the master's bytes unchanged.
 */
import type { Socket } from 'node:net';

import Logger from '@/libs/logger';

import PersistenceService from '@/modules/persistence/persistence.service';
import type { Client } from '@/modules/server/server.service';
import TrackingService from '@/modules/tracking/tracking.service';

import { ReplicationBacklog } from './replication.backlog.structure';
import { ReplicaLink } from './replication.link';
import type { LinkHost } from './replication.link';
import ReplicationMessages from './replication.messages';
import { ReplicationPrimary } from './replication.primary';
import { ReplicationState } from './replication.state';
import type { StreamCommand } from './replication.types';

export abstract class ReplicationReplica extends ReplicationPrimary implements LinkHost {
  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  /** The link to the master (null on a master). */
  link: ReplicaLink | null = null;
  /** The client the master's stream runs as, while the link is up. */
  masterClient: Client | null = null;
  /** The master client's database, kept across reconnections (a partial resync continues the same stream). */
  private masterDb = 0;
  /** Stream bytes of a transaction still open on the master client (not in the offset yet). */
  private pendingTx: Buffer[] = [];
  private pendingTxBytes = 0;
  /** The offset the local AOF had fsynced at the last ACK (FACK). */
  private fsyncedOffset = 0;
  /** False until this server has a history to offer in PSYNC (a server started as a replica has none). */
  protected hasHistory = true;

  // ──────────────────────────────────────────────
  // LinkHost
  // ──────────────────────────────────────────────

  /** Whether the link sends PSYNC … FAILOVER (Replication: a failover is handing over to its target). */
  abstract failoverPsync(): boolean;

  /** The master refused PSYNC (Replication: a failover target refused to take over). */
  abstract onPsyncError(message: string): void;

  get config(): LinkHost['config'] {
    return this.server.config;
  }

  listeningPort(): number {
    return this.server.options.port;
  }

  psyncArgs(): [string, string] {
    return this.hasHistory ? [this.replid, String(this.offset + 1)] : ['?', '-1'];
  }

  onFullSync(replid: string, offset: number, payload: Buffer): void {
    Logger.info(ReplicationMessages.LOG_FULL_SYNC, { replid, offset, bytes: payload.length });
    const server = this.server;
    // repl-diskless-load disabled: the payload goes to the RDB file first (only when this server persists at all)
    if (this.cfg('repl-diskless-load') === 'disabled' && server.options.persistence) {
      const path = server.persistence.rdbPath;
      PersistenceService.writeAtomicSync(path, `${path}.replica-tmp`, payload);
    }
    try {
      server.persistence.replaceDataset(payload);
    } catch (error) {
      Logger.warn(ReplicationMessages.LOG_LOAD_FAILED, { err: (error as Error).message });
      throw error;
    }
    TrackingService.flushed(server.tracking);
    server.evictor.clearPool();
    // a new history: sub-replicas must sync again
    this.disconnectReplicas();
    this.replid = replid;
    this.replid2 = ReplicationState.NO_REPLID;
    this.secondOffset = -1;
    this.offset = offset;
    this.backlog = new ReplicationBacklog(this.num('repl-backlog-size'), offset);
    this.hasHistory = true;
    this.masterDb = 0;
  }

  onContinue(replid: string | null): void {
    Logger.info(ReplicationMessages.LOG_PARTIAL_SYNC, { replid: replid ?? this.replid, offset: this.offset });
    if (replid && replid !== this.replid) {
      // the master's history has a new ID (it was promoted): ours becomes the secondary one; sub-replicas learn it
      this.replid2 = this.replid;
      this.secondOffset = this.offset + 1;
      this.replid = replid;
      this.disconnectReplicas();
    }
    this.ensureBacklog();
  }

  onOnline(socket: Socket): void {
    const client = this.server.attachClient(socket);
    client.isMaster = true;
    client.dbIndex = this.masterDb;
    client.lastCommand = 'NULL';
    this.masterClient = client;
    this.sendAck();
  }

  onCommand(cmd: StreamCommand): void {
    const client = this.masterClient;
    if (!client) return;
    client.netIn += cmd.bytes.length;
    client.lastActiveAt = Date.now();
    if (cmd.argv.length) {
      const expiry = this.server.keyExpiry;
      expiry.mode = 'stream';
      try {
        this.server.runAsMaster(client, cmd.argv);
      } finally {
        expiry.mode = this.role === 'slave' ? 'replica' : 'active';
      }
    }
    if (this.masterClient !== client) return;
    this.masterDb = client.dbIndex;
    this.pendingTx.push(Buffer.from(cmd.bytes));
    this.pendingTxBytes += cmd.bytes.length;
    if (client.multi) return;
    const data = this.pendingTx.length === 1 ? this.pendingTx[0] : Buffer.concat(this.pendingTx);
    this.pendingTx = [];
    this.pendingTxBytes = 0;
    this.feedStream(data);
  }

  onDown(): void {
    this.dropMasterClient();
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  /** Forgets the master client (its unfinished transaction and unapplied bytes go with it). */
  protected dropMasterClient(): void {
    const client = this.masterClient;
    this.masterClient = null;
    this.pendingTx = [];
    this.pendingTxBytes = 0;
    if (client) this.server.killClient(client);
  }

  /** slave_read_repl_offset: what was read from the master, an open transaction included. */
  get readOffset(): number {
    return this.offset + this.pendingTxBytes;
  }

  /** REPLCONF ACK <offset> [FACK <offset>] (FACK: the offset the local AOF has fsynced; sent while the AOF is on). */
  protected sendAck(): void {
    const persistence = this.server.persistence;
    if (persistence.aofFsynced) this.fsyncedOffset = this.offset;
    this.link?.sendAck(this.offset, persistence.aofEnabled ? this.fsyncedOffset : null);
  }

  // ──────────────────────────────────────────────
  // Role changes
  // ──────────────────────────────────────────────

  /** Follows host:port from now on (REPLICAOF host port, the replicaof directive). */
  protected setMaster(host: string, port: number): void {
    const wasMaster = this.role === 'master';
    this.link?.close();
    this.link = null;
    this.dropMasterClient();
    this.role = 'slave';
    this.server.keyExpiry.mode = 'replica';
    if (wasMaster) {
      // its replicas reconnect and find out about the new history through PSYNC
      this.disconnectReplicas();
      this.releaseWaiters();
    }
    this.server.config.set('replicaof', `${host} ${port}`);
    this.link = new ReplicaLink(this, host, port);
    this.link.connect();
  }

  /** Back to master (REPLICAOF NO ONE, a FAILOVER target): a new ID, the old one kept as secondary (PSYNC2). */
  protected unsetMaster(): void {
    if (this.role === 'master') return;
    this.link?.close();
    this.link = null;
    this.dropMasterClient();
    this.role = 'master';
    this.server.keyExpiry.mode = 'active';
    this.shiftReplId();
    this.streamDb = -1;
    this.ensureBacklog();
    this.disconnectReplicas();
    this.server.config.set('replicaof', '');
    Logger.info(ReplicationMessages.LOG_PROMOTED, { replid: this.replid, replid2: this.replid2, secondOffset: this.secondOffset });
  }

  /** Whether this server can serve a PSYNC: a master always, a replica only while its own link is up. */
  protected canServeSync(): boolean {
    return this.role === 'master' || Boolean(this.link?.connected && this.masterClient);
  }
}
