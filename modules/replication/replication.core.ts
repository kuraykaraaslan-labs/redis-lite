/**
 * Top layer of the replication runtime (`server.replication`): startup and shutdown, the once-a-second cron, the
 * command entry points (REPLICAOF, WAIT, FAILOVER), ROLE and INFO replication, and config hooks.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * FAILOVER follows the documented sequence: writes are paused (like CLIENT PAUSE WRITE), the master waits until a
 * replica (or the TO target) acknowledged the whole stream, demotes itself to a replica of it and sends
 * `PSYNC <replid> <offset> FAILOVER`, on which the target promotes itself and answers `+CONTINUE <new replid>`. Writes
 * resume once that answer came (they then meet a replica: READONLY). A timeout aborts while waiting for the sync,
 * unless FORCE, which goes ahead with the target anyway.
 */
import { AppError } from '@/libs/app-error';
import Logger from '@/libs/logger';
import { OK, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { HandlerResult } from '@/modules/command/command.types';
import type { Client } from '@/modules/server/server.service';

import type { FailoverState } from './replication.enums';
import ReplicationMessages from './replication.messages';
import { ReplicationReplica } from './replication.replica';
import type { FailoverRequest } from './replication.types';

/** The failover in progress. */
interface FailoverRun {
  /** The TO target as host / port, or null: the first replica that catches up. */
  host: string | null;
  port: number | null;
  force: boolean;
  /** Unix ms of the timeout, or null. */
  deadline: number | null;
}

export class Replication extends ReplicationReplica {
  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  failoverState: FailoverState = 'no-failover';
  private failover: FailoverRun | null = null;
  private timer: NodeJS.Timeout | null = null;

  // ──────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────

  /** Starts the cron; with a `replicaof` directive, starts following that master (with no history yet: PSYNC ? -1). */
  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.cron(Date.now()), 1000);
      this.timer.unref();
    }
    const target = Replication.parseTarget(this.cfg('replicaof'));
    if (target && this.role === 'master') {
      this.hasHistory = false;
      this.setMaster(target.host, target.port);
    }
  }

  /** Server close: the link, the cron, pending syncs and waiters. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.link?.close();
    this.link = null;
    for (const client of this.replicas) this.detach(client);
    this.releaseWaiters();
    this.server.resumeWrites();
  }

  /** `host port` (the replicaof directive), or null. */
  static parseTarget(value: string): { host: string; port: number } | null {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return null;
    return { host: parts[0], port: Number(parts[1]) };
  }

  // ──────────────────────────────────────────────
  // Cron
  // ──────────────────────────────────────────────

  /** Once a second: master duties, the replica's ACK and link timeout, failover progress. */
  cron(now = Date.now()): void {
    this.primaryCron(now);
    if (this.link) {
      this.link.checkTimeout(now);
      this.sendAck();
    }
    this.failoverStep(now);
  }

  // ──────────────────────────────────────────────
  // Config hooks
  // ──────────────────────────────────────────────

  /** CONFIG SET side effects. */
  onConfigChange(name: string): void {
    if (name === 'repl-backlog-size') this.backlog?.resize(this.num('repl-backlog-size'));
  }

  /** Whether eviction is off on this server (a replica with replica-ignore-maxmemory). */
  get ignoresMaxmemory(): boolean {
    return this.role === 'slave' && this.cfg('replica-ignore-maxmemory') === 'yes';
  }

  /** replica-serve-stale-data no and the link is down: only `stale` commands run (MASTERDOWN). */
  get servesStaleOnly(): boolean {
    return this.role === 'slave' && !this.link?.connected && this.cfg('replica-serve-stale-data') === 'no';
  }

  /** replica-read-only: writes from clients other than the master are refused (READONLY). */
  get readOnly(): boolean {
    return this.role === 'slave' && this.cfg('replica-read-only') === 'yes';
  }

  // ──────────────────────────────────────────────
  // Commands
  // ──────────────────────────────────────────────

  /** REPLICAOF host port. */
  replicaOf(host: string, port: number): Reply {
    if (this.failoverState !== 'no-failover') throw new AppError(ReplicationMessages.REPLICAOF_DURING_FAILOVER);
    const link = this.link;
    if (this.role === 'slave' && link && link.masterHost.toLowerCase() === host.toLowerCase() && link.masterPort === port) {
      return new Status(ReplicationMessages.ALREADY_CONNECTED);
    }
    this.setMaster(host, port);
    return OK;
  }

  /** REPLICAOF NO ONE. */
  replicaOfNoOne(): Reply {
    if (this.failoverState !== 'no-failover') throw new AppError(ReplicationMessages.REPLICAOF_DURING_FAILOVER);
    this.unsetMaster();
    return OK;
  }

  /** WAIT numreplicas timeout. */
  wait(client: Client, numreplicas: number, timeoutMs: number, noBlock: boolean): HandlerResult {
    if (this.role === 'slave') throw new AppError(ReplicationMessages.WAIT_ON_REPLICA);
    return this.waitAcks(client, numreplicas, timeoutMs, noBlock);
  }

  /** REPLCONF ACK also moves a failover forward. */
  override replicaAck(client: Client, offset: number): void {
    super.replicaAck(client, offset);
    this.failoverStep(Date.now());
  }

  /** REPLCONF GETACK on a replica (sent by the master through the stream): an ACK right away. */
  getAck(client: Client): void {
    if (client.isMaster) this.sendAck();
  }

  // ──────────────────────────────────────────────
  // FAILOVER
  // ──────────────────────────────────────────────

  /** FAILOVER [TO host port [FORCE]] [TIMEOUT ms]. */
  failoverStart(req: FailoverRequest): Reply {
    if (this.role === 'slave') throw new AppError(ReplicationMessages.FAILOVER_ON_REPLICA);
    if (this.failoverState !== 'no-failover') throw new AppError(ReplicationMessages.FAILOVER_IN_PROGRESS);
    if (req.force && (!req.timeoutMs || req.host === null)) throw new AppError(ReplicationMessages.FAILOVER_FORCE);
    const views = this.replicaViews();
    if (!views.length) throw new AppError(ReplicationMessages.FAILOVER_NO_REPLICAS);
    if (req.host !== null) {
      const target = views.find((v) => v.ip === req.host && v.port === req.port);
      if (!target) throw new AppError(ReplicationMessages.FAILOVER_NOT_A_REPLICA);
      if (target.state !== 'online') throw new AppError(ReplicationMessages.FAILOVER_NOT_ONLINE);
    }
    this.failover = { host: req.host, port: req.port, force: req.force, deadline: req.timeoutMs ? Date.now() + req.timeoutMs : null };
    this.setFailoverState('waiting-for-sync');
    this.server.pauseWrites();
    this.requestAcks();
    setImmediate(() => this.failoverStep(Date.now()));
    return OK;
  }

  /** FAILOVER ABORT. */
  failoverAbort(): Reply {
    if (this.failoverState === 'no-failover') throw new AppError(ReplicationMessages.FAILOVER_NOT_IN_PROGRESS);
    this.abortFailover('aborted by FAILOVER ABORT');
    return OK;
  }

  private setFailoverState(state: FailoverState): void {
    this.failoverState = state;
    Logger.info(ReplicationMessages.LOG_FAILOVER, { state });
  }

  /** Checks whether the failover can go ahead, or timed out. */
  private failoverStep(now: number): void {
    const run = this.failover;
    if (!run) return;
    if (this.failoverState === 'failover-in-progress') {
      if (run.deadline !== null && now >= run.deadline) this.abortFailover('timeout');
      return;
    }
    const candidate = this.replicaViews(now).find(
      (v) => v.state === 'online' && v.offset >= this.offset && (run.host === null || (v.ip === run.host && v.port === run.port)),
    );
    if (candidate) {
      this.proceedFailover(candidate.ip, candidate.port);
      return;
    }
    if (run.deadline !== null && now >= run.deadline) {
      if (run.force && run.host !== null && run.port !== null) this.proceedFailover(run.host, run.port);
      else this.abortFailover('timeout');
    }
  }

  /** Demote: follow the target and ask it to take over (PSYNC … FAILOVER). */
  private proceedFailover(host: string, port: number): void {
    const run = this.failover;
    if (!run) return;
    this.setFailoverState('failover-in-progress');
    this.setMaster(host, port);
  }

  /** Back to a plain master with the same history (nothing was written meanwhile); writes resume. */
  private abortFailover(reason: string): void {
    Logger.warn('[Replication.abortFailover] FAILOVER aborted', { reason });
    if (this.role === 'slave') {
      this.link?.close();
      this.link = null;
      this.dropMasterClient();
      this.role = 'master';
      this.server.keyExpiry.mode = 'active';
      this.streamDb = -1;
      this.server.config.set('replicaof', '');
    }
    this.endFailover();
  }

  private endFailover(): void {
    this.failover = null;
    this.setFailoverState('no-failover');
    this.server.resumeWrites();
  }

  /** The link asks whether to send PSYNC … FAILOVER. */
  failoverPsync(): boolean {
    return this.failoverState === 'failover-in-progress';
  }

  override onOnline(socket: Parameters<ReplicationReplica['onOnline']>[0]): void {
    super.onOnline(socket);
    // the target took over: the failover is complete
    if (this.failoverState === 'failover-in-progress') this.endFailover();
  }

  onPsyncError(message: string): void {
    if (this.failoverState === 'failover-in-progress') this.abortFailover(`target refused: ${message}`);
  }

  /** PSYNC … FAILOVER on the target: only from our own master's history, then promote and serve it. */
  protected acceptFailover(replid: string): string | null {
    if (this.role !== 'slave' || replid !== this.replid) return ReplicationMessages.PSYNC_FAILOVER_REFUSED;
    this.unsetMaster();
    return null;
  }

  // ──────────────────────────────────────────────
  // ROLE / INFO
  // ──────────────────────────────────────────────

  /** ROLE. */
  roleReply(): Reply {
    if (this.role === 'master') {
      return ['master', this.offset, this.replicaViews().map((v) => [v.ip, String(v.port), String(v.offset)])];
    }
    const link = this.link;
    return ['slave', link?.masterHost ?? '', link?.masterPort ?? 0, link?.state ?? 'connect', this.masterClient ? this.offset : -1];
  }

  /** INFO replication, in Redis's field order. */
  infoLines(now = Date.now()): string[] {
    const lines = [`role:${this.role}`];
    const link = this.link;
    if (this.role === 'slave' && link) {
      const sec = (ms: number): number => Math.floor((now - ms) / 1000);
      lines.push(
        `master_host:${link.masterHost}`,
        `master_port:${link.masterPort}`,
        `master_link_status:${link.connected ? 'up' : 'down'}`,
        `master_last_io_seconds_ago:${link.connected ? sec(link.lastIo) : -1}`,
        `master_sync_in_progress:${link.state === 'sync' ? 1 : 0}`,
        `slave_read_repl_offset:${this.readOffset}`,
        `slave_repl_offset:${this.offset}`,
      );
      if (link.state === 'sync') {
        const total = link.reader.total;
        const read = link.reader.received;
        lines.push(
          `master_sync_total_bytes:${total}`,
          `master_sync_read_bytes:${read}`,
          `master_sync_left_bytes:${total < 0 ? -1 : total - read}`,
          `master_sync_perc:${total > 0 ? ((read * 100) / total).toFixed(2) : '0.00'}`,
          `master_sync_last_io_seconds_ago:${sec(link.lastIo)}`,
        );
      }
      if (!link.connected) lines.push(`master_link_down_since_seconds:${link.downSince === null ? -1 : sec(link.downSince)}`);
      lines.push(
        `master_current_sync_attempts:${link.attempts}`,
        `master_total_sync_attempts:${link.totalAttempts}`,
        `slave_priority:${this.cfg('replica-priority')}`,
        `slave_read_only:${this.readOnly ? 1 : 0}`,
        `replica_announced:${this.cfg('replica-announced') === 'yes' ? 1 : 0}`,
      );
    }
    const views = this.replicaViews(now);
    lines.push(`connected_slaves:${views.length}`);
    if (this.num('min-replicas-to-write') > 0 && this.num('min-replicas-max-lag') > 0) lines.push(`min_slaves_good_slaves:${this.goodReplicas(now)}`);
    views.forEach((v, i) => lines.push(`slave${i}:ip=${v.ip},port=${v.port},state=${v.state},offset=${v.offset},lag=${v.lag}`));
    const backlog = this.backlog;
    lines.push(
      `master_failover_state:${this.failoverState}`,
      `master_replid:${this.replid}`,
      `master_replid2:${this.replid2}`,
      `master_repl_offset:${this.offset}`,
      `second_repl_offset:${this.secondOffset}`,
      `repl_backlog_active:${backlog ? 1 : 0}`,
      `repl_backlog_size:${backlog?.size ?? this.num('repl-backlog-size')}`,
      `repl_backlog_first_byte_offset:${backlog ? backlog.firstByteOffset : 0}`,
      `repl_backlog_histlen:${backlog?.histlen ?? 0}`,
    );
    return lines;
  }
}

export default Replication;
