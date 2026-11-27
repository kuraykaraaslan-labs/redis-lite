/**
 * Replica side: the connection to the master and the documented handshake (replication page, PSYNC / REPLCONF
 * command pages):
 *
 *   PING → AUTH [masteruser] masterauth → REPLCONF listening-port <port> → [REPLCONF ip-address <ip>]
 *   → REPLCONF capa eof capa psync2 → PSYNC <replid> <offset> [FAILOVER]
 *
 * then either `+FULLRESYNC <replid> <offset>` and the RDB payload, or `+CONTINUE [<replid>]`, then the command stream.
 * The handshake is pipelined (the master answers in order). Every second while connected the replica sends
 * `REPLCONF ACK <offset>`.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * A stateful component (one per REPLICAOF target): the socket, the handshake step and the reader. What the link
 * receives is handed to its host (ReplicationReplica), which owns the dataset side.
 */
import { connect } from 'node:net';
import type { Socket } from 'node:net';

import Logger from '@/libs/logger';

import PersistenceService from '@/modules/persistence/persistence.service';

import type { LinkState } from './replication.enums';
import ReplicationMessages from './replication.messages';
import { ReplicationStreamReader } from './replication.stream';
import type { PsyncReply, StreamCommand } from './replication.types';

/** What the link needs from the replica runtime. */
export interface LinkHost {
  config: { get(name: string): string | undefined; num(name: string): number };
  /** The port this server listens on (REPLCONF listening-port unless replica-announce-port is set). */
  listeningPort(): number;
  /** PSYNC arguments: the cached history and the next offset wanted, or `?` / `-1`. */
  psyncArgs(): [string, string];
  /** Send PSYNC … FAILOVER (a coordinated failover asked this replica's master to step down). */
  failoverPsync(): boolean;
  /** `+FULLRESYNC` was answered and the whole payload arrived. Throws when it cannot be loaded. */
  onFullSync(replid: string, offset: number, payload: Buffer): void;
  /** `+CONTINUE [replid]`. */
  onContinue(replid: string | null): void;
  /** The link is up (after a full or partial sync): the stream follows. */
  onOnline(socket: Socket): void;
  /** One command of the stream. */
  onCommand(cmd: StreamCommand): void;
  /** The link is down (it reconnects by itself unless closed). */
  onDown(): void;
  /** The master refused PSYNC (FAILOVER rejected, NOMASTERLINK…). */
  onPsyncError(message: string): void;
}

export class ReplicaLink {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Reconnection delay (Redis retries from its once-a-second replication cron). */
  private static readonly RETRY_MS = 1000;

  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  state: LinkState = 'connect';
  /** Unix ms of the last bytes from the master (master_last_io_seconds_ago). */
  lastIo = Date.now();
  /** Unix ms the link went down (master_link_down_since_seconds); null while up. */
  downSince: number | null = Date.now();
  /** Sync attempts since the link was last up / in total (INFO master_current_sync_attempts / master_total_sync_attempts). */
  attempts = 0;
  totalAttempts = 0;
  /** Bytes of the stream read but maybe not applied yet (slave_read_repl_offset is the host's offset plus these). */
  readonly reader = new ReplicationStreamReader();
  private socket: Socket | null = null;
  /** Handlers of the pipelined handshake replies, in order; null once the stream runs. */
  private expect: Array<(line: string) => void> | null = null;
  private retry: NodeJS.Timeout | null = null;
  private closed = false;
  /** A full sync in progress: the history `+FULLRESYNC` announced. */
  private pending: { replid: string; offset: number } | null = null;

  constructor(
    private readonly host: LinkHost,
    readonly masterHost: string,
    readonly masterPort: number,
  ) {}

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private send(argv: string[]): void {
    this.socket?.write(Buffer.from(PersistenceService.encodeAofCommand(argv), 'latin1'));
  }

  private fail(reason: string, context: Record<string, unknown> = {}): void {
    Logger.warn(ReplicationMessages.LOG_HANDSHAKE_ERROR, { reason, master: `${this.masterHost}:${this.masterPort}`, ...context });
    this.drop();
  }

  /** Closes the socket; the link goes back to `connect` and retries. */
  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    this.expect = null;
    socket?.destroy();
    const wasUp = this.state === 'connected';
    this.state = 'connect';
    this.downSince ??= Date.now();
    if (wasUp) Logger.warn(ReplicationMessages.LOG_LINK_LOST, { master: `${this.masterHost}:${this.masterPort}` });
    this.host.onDown();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, ReplicaLink.RETRY_MS);
    this.retry.unref();
  }

  private handshake(): void {
    const cfg = this.host.config;
    const steps: Array<{ argv: string[]; check: (line: string) => boolean }> = [];
    // PING: a master that wants AUTH answers NOAUTH / NOPERM, which is fine since AUTH follows
    steps.push({ argv: ['PING'], check: (l) => l[0] === '+' || /^-(NOAUTH|NOPERM|ERR operation not permitted)/.test(l) });
    const auth = cfg.get('masterauth') ?? '';
    if (auth) {
      const user = cfg.get('masteruser') ?? '';
      steps.push({ argv: user ? ['AUTH', user, auth] : ['AUTH', auth], check: (l) => l[0] === '+' });
    }
    const announcedPort = cfg.num('replica-announce-port');
    steps.push({ argv: ['REPLCONF', 'listening-port', String(announcedPort || this.host.listeningPort())], check: () => true });
    const ip = cfg.get('replica-announce-ip') ?? '';
    if (ip) steps.push({ argv: ['REPLCONF', 'ip-address', ip], check: () => true });
    steps.push({ argv: ['REPLCONF', 'capa', 'eof', 'capa', 'psync2'], check: () => true });
    const [replid, offset] = this.host.psyncArgs();
    const psync = ['PSYNC', replid, offset];
    if (this.host.failoverPsync()) psync.push('FAILOVER');
    this.expect = steps.map(({ argv, check }) => (line: string) => {
      if (!check(line)) this.fail(`${argv[0]} failed`, { reply: line.slice(0, 200) });
    });
    this.expect.push((line) => this.psyncReply(ReplicaLink.parsePsync(line)));
    for (const { argv } of steps) this.send(argv);
    this.send(psync);
  }

  private static parsePsync(line: string): PsyncReply {
    const full = /^\+FULLRESYNC ([0-9a-zA-Z]+) (\d+)$/.exec(line);
    if (full) return { kind: 'full', replid: full[1], offset: Number(full[2]) };
    const cont = /^\+CONTINUE(?: ([0-9a-zA-Z]+))?\s*$/.exec(line);
    if (cont) return { kind: 'continue', replid: cont[1] ?? null };
    return { kind: 'error', message: line.replace(/^-/, '') };
  }

  private psyncReply(reply: PsyncReply): void {
    this.expect = null;
    if (reply.kind === 'error') {
      this.host.onPsyncError(reply.message);
      this.fail('PSYNC refused', { reply: reply.message });
      return;
    }
    if (reply.kind === 'continue') {
      this.host.onContinue(reply.replid);
      this.online();
      return;
    }
    this.state = 'sync';
    this.pending = { replid: reply.replid, offset: reply.offset };
  }

  private online(): void {
    this.state = 'connected';
    this.downSince = null;
    this.attempts = 0;
    this.socket?.setTimeout(0);
    if (this.socket) this.host.onOnline(this.socket);
  }

  private onData(chunk: Buffer): void {
    this.lastIo = Date.now();
    this.reader.push(chunk);
    try {
      while (this.socket) {
        if (this.expect) {
          const line = this.reader.readLine();
          if (line === null) return;
          this.expect.shift()?.(line);
          continue;
        }
        if (this.state === 'sync') {
          if (!this.reader.beginPayload()) return;
          const payload = this.reader.pumpPayload();
          if (!payload) return;
          const pending = this.pending;
          this.pending = null;
          if (!pending) throw new Error('payload without FULLRESYNC');
          this.host.onFullSync(pending.replid, pending.offset, payload);
          this.online();
          continue;
        }
        if (this.state !== 'connected') return;
        const cmd = this.reader.readCommand();
        if (!cmd) return;
        this.host.onCommand(cmd);
      }
    } catch (error) {
      this.fail('protocol', { err: (error as Error).message });
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  get connected(): boolean {
    return this.state === 'connected';
  }

  /** Opens the connection and runs the handshake. */
  connect(): void {
    if (this.closed || this.socket) return;
    this.state = 'connecting';
    this.attempts++;
    this.totalAttempts++;
    Logger.info(ReplicationMessages.LOG_CONNECTING, { master: `${this.masterHost}:${this.masterPort}` });
    const socket = connect({ host: this.masterHost, port: this.masterPort });
    this.socket = socket;
    socket.setNoDelay(this.host.config.get('repl-disable-tcp-nodelay') !== 'yes');
    socket.setTimeout(this.host.config.num('repl-timeout') * 1000, () => {
      if (this.socket === socket && this.state !== 'connected') this.fail('timeout');
    });
    socket.on('connect', () => {
      if (this.socket === socket) this.handshake();
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.socket === socket) this.onData(chunk);
    });
    const lost = (): void => {
      if (this.socket === socket) this.drop();
    };
    socket.on('close', lost);
    socket.on('error', lost);
  }

  /** REPLCONF ACK <offset>. */
  sendAck(offset: number): void {
    if (!this.connected) return;
    this.send(['REPLCONF', 'ACK', String(offset)]);
  }

  /** repl-timeout: no data from an online master for that long drops the link. */
  checkTimeout(now: number): void {
    if (this.connected && now - this.lastIo > this.host.config.num('repl-timeout') * 1000) {
      Logger.warn(ReplicationMessages.LOG_TIMEOUT, { master: `${this.masterHost}:${this.masterPort}` });
      this.drop();
    }
  }

  /** Drops the connection now; it reconnects after the retry delay (CLIENT KILL of the master client). */
  reconnect(): void {
    if (this.socket) this.drop();
  }

  /** Stops for good (REPLICAOF NO ONE / another master / server close). */
  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    this.expect = null;
    this.state = 'connect';
    socket?.destroy();
  }
}
