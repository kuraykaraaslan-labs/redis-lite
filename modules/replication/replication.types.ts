/**
 * Domain types of the replication module.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import type { ReplicaState } from './replication.enums';

/**
 * Master side: what the master knows of one replica connection (held on its Client as `client.replica`). Set by the
 * first REPLCONF; the connection is a replica once PSYNC / SYNC was accepted (`attached`).
 */
export interface ReplicaInfo {
  /** PSYNC / SYNC accepted: the connection receives the replication stream and gets no replies. */
  attached: boolean;
  state: ReplicaState;
  /** REPLCONF listening-port (0 when not announced). */
  listeningPort: number;
  /** REPLCONF ip-address (replica-announce-ip), or null: the connection's address is used. */
  announcedIp: string | null;
  /** REPLCONF capa eof: accepts the diskless EOF-marker payload. */
  capaEof: boolean;
  /** REPLCONF capa psync2: understands `+CONTINUE <new replid>`. */
  capaPsync2: boolean;
  /** Offset of the last REPLCONF ACK. */
  ackOffset: number;
  /** FACK of the last REPLCONF ACK: the replica's offset its AOF has fsynced (WAITAOF); -1 until one arrives. */
  aofAckOffset: number;
  /** When the last REPLCONF ACK arrived (unix ms; lag = now - ackTime). */
  ackTime: number;
  /** Attached with PSYNC (a full sync starts with `+FULLRESYNC`) rather than the old SYNC. */
  psync: boolean;
  /** A diskless full sync waiting for repl-diskless-sync-delay. */
  pendingSync: NodeJS.Timeout | null;
}

/** The handshake answer to PSYNC. */
export type PsyncReply =
  | { kind: 'full'; replid: string; offset: number }
  | { kind: 'continue'; replid: string | null }
  | { kind: 'error'; message: string };

/** One command read from the master's stream, with the bytes it took on the wire. */
export interface StreamCommand {
  argv: string[];
  bytes: Buffer;
}

/** ROLE / INFO view of one attached replica. */
export interface ReplicaView {
  ip: string;
  port: number;
  state: ReplicaState;
  offset: number;
  lag: number;
}

/** FAILOVER arguments (after validation). */
export interface FailoverRequest {
  host: string | null;
  port: number | null;
  force: boolean;
  timeoutMs: number;
}
