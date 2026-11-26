/**
 * Master side of the replication runtime: replicas attaching (REPLCONF, PSYNC, SYNC), full and partial
 * resynchronization, the propagated command stream (the Propagator's replication sink, SELECT handling), REPLCONF ACK /
 * GETACK, WAIT / WAITAOF, min-replicas-to-write and the master's periodic duties (PING, replica timeouts, backlog TTL).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * A full sync takes the RDB snapshot synchronously (the point-in-time image a fork gives Redis) and sends it at once,
 * followed by the stream from the snapshot's offset; nothing can run in between, so no per-replica output buffer is
 * needed. With repl-diskless-sync the transfer waits repl-diskless-sync-delay seconds for more replicas, like Redis.
 */
import { randomBytes } from 'node:crypto';

import Logger from '@/libs/logger';
import { RespError } from '@/libs/resp';

import { Block, NO_REPLY } from '@/modules/command/command.service';
import type { HandlerResult } from '@/modules/command/command.types';
import type { PropagatedOp } from '@/modules/persistence/persistence.types';
import PersistenceService from '@/modules/persistence/persistence.service';
import type { Client } from '@/modules/server/server.service';

import ReplicationMessages from './replication.messages';
import { ReplicationState } from './replication.state';
import type { ReplicaView } from './replication.types';

/** A client blocked in WAIT / WAITAOF. */
interface WaitEntry {
  client: Client;
  block: Block;
  /** The offset the replicas must have acknowledged (the client's last write). */
  target: number;
  numreplicas: number;
  /** WAITAOF: [numlocal wanted, local fsync acknowledged]; null for WAIT. */
  aof: { numlocal: number; local: number } | null;
  timer: NodeJS.Timeout | null;
}

export abstract class ReplicationPrimary extends ReplicationState {
  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  /** The database the stream last SELECTed (-1: the next op emits SELECT). */
  protected streamDb = -1;
  private readonly waiters: WaitEntry[] = [];
  private getAckPending = false;
  private lastPing = Date.now();

  constructor(server: ConstructorParameters<typeof ReplicationState>[0]) {
    super(server);
    // the stream exists only while there is a backlog (a replica attached recently): otherwise nothing is recorded
    server.persistence.propagator.addSink(
      (ops) => this.feedOps(ops),
      () => this.role === 'master' && this.backlog !== null,
    );
  }

  // ──────────────────────────────────────────────
  // Hooks implemented by later layers
  // ──────────────────────────────────────────────

  /** Whether this server can serve a PSYNC now (a replica whose own link is down cannot). */
  protected abstract canServeSync(): boolean;

  /** PSYNC … FAILOVER from our master: become master first. Returns an error text when refused. */
  protected abstract acceptFailover(replid: string): string | null;

  // ──────────────────────────────────────────────
  // Stream
  // ──────────────────────────────────────────────

  /** The Propagator sink: one execution unit, SELECT emitted when the database changes. Ops for the AOF only are skipped. */
  protected feedOps(ops: readonly PropagatedOp[]): void {
    let out = '';
    for (const o of ops) {
      if (o.target === 'aof') continue;
      if (o.db >= 0 && o.db !== this.streamDb) {
        out += PersistenceService.encodeAofCommand(['SELECT', String(o.db)]);
        this.streamDb = o.db;
      }
      out += PersistenceService.encodeAofCommand(o.argv);
    }
    if (out) this.feedStream(Buffer.from(out, 'latin1'));
  }

  /** Feeds one command outside any unit (PING, REPLCONF GETACK). */
  protected feedCommand(argv: string[]): void {
    if (this.role === 'master') this.feedStream(Buffer.from(PersistenceService.encodeAofCommand(argv), 'latin1'));
  }

  // ──────────────────────────────────────────────
  // Attaching replicas
  // ──────────────────────────────────────────────

  /** REPLCONF listening-port / ip-address / capa from a (future) replica. */
  replicaConfigure(client: Client, option: string, value: string): void {
    const info = this.replicaInfo(client);
    if (option === 'listening-port') info.listeningPort = Number(value) || 0;
    else if (option === 'ip-address') info.announcedIp = value;
    else if (option === 'capa') {
      const capa = value.toLowerCase();
      if (capa === 'eof') info.capaEof = true;
      else if (capa === 'psync2') info.capaPsync2 = true;
    }
  }

  /**
   * PSYNC replid offset [FAILOVER]: `+CONTINUE` and the backlog from `offset` when this history (or the previous one,
   * up to second_repl_offset) still holds it, else `+FULLRESYNC <replid> <offset>` and the RDB. Writes the reply
   * itself: everything after it is the replication stream.
   */
  psync(client: Client, replid: string, offsetArg: string, failover: boolean): HandlerResult {
    if (client.replica?.attached) return NO_REPLY;
    if (failover) {
      const refusal = this.acceptFailover(replid);
      if (refusal) return new RespError(refusal);
    }
    if (!this.canServeSync()) return new RespError(ReplicationMessages.NOMASTERLINK);
    const info = this.replicaInfo(client);
    const offset = Number(offsetArg);
    const known = replid === this.replid || (replid === this.replid2 && offset <= this.secondOffset);
    if (known && Number.isSafeInteger(offset) && this.backlog?.covers(offset)) {
      this.attach(client);
      info.state = 'online';
      this.stats.syncPartialOk++;
      // a psync2 replica learns the current ID (it changes after a promotion); an older one gets a bare +CONTINUE
      this.writeRaw(client, info.capaPsync2 ? `+CONTINUE ${this.replid}\r\n` : '+CONTINUE\r\n');
      this.writeRaw(client, this.backlog.readFrom(offset));
      Logger.info(ReplicationMessages.LOG_REPLICA_ATTACHED, { addr: client.address, sync: 'partial', offset });
      return NO_REPLY;
    }
    if (replid !== '?') this.stats.syncPartialErr++;
    this.requestFullSync(client, true);
    return NO_REPLY;
  }

  /** SYNC: the pre-PSYNC protocol, always a full resync and no `+FULLRESYNC` line. */
  sync(client: Client): HandlerResult {
    if (client.replica?.attached) return NO_REPLY;
    if (!this.canServeSync()) return new RespError(ReplicationMessages.NOMASTERLINK);
    this.replicaInfo(client);
    this.requestFullSync(client, false);
    return NO_REPLY;
  }

  private attach(client: Client): void {
    const info = this.replicaInfo(client);
    info.attached = true;
    info.ackTime = Date.now();
    this.replicas.add(client);
    this.noReplicasSince = null;
    this.ensureBacklog();
  }

  private requestFullSync(client: Client, psync: boolean): void {
    const info = this.replicaInfo(client);
    info.psync = psync;
    this.attach(client);
    this.stats.syncFull++;
    info.state = 'wait_bgsave';
    const diskless = this.cfg('repl-diskless-sync') === 'yes' && info.capaEof;
    const delay = this.num('repl-diskless-sync-delay');
    const waiting = [...this.replicas].filter((c) => c.replica?.state === 'wait_bgsave').length;
    const max = this.num('repl-diskless-sync-max-replicas');
    if (diskless && delay > 0 && !(max > 0 && waiting >= max)) {
      info.pendingSync = setTimeout(() => this.startPendingSyncs(), delay * 1000);
      info.pendingSync.unref();
      return;
    }
    this.transfer([client]);
  }

  /** The delayed diskless transfer: every replica still waiting is served from one snapshot. */
  private startPendingSyncs(): void {
    const clients = [...this.replicas].filter((c) => c.replica?.state === 'wait_bgsave');
    for (const c of clients) {
      if (c.replica?.pendingSync) clearTimeout(c.replica.pendingSync);
      if (c.replica) c.replica.pendingSync = null;
    }
    if (clients.length) this.transfer(clients);
  }

  /** Snapshot now; `+FULLRESYNC` (PSYNC only), then the payload; the stream continues from the snapshot's offset. */
  private transfer(clients: Client[]): void {
    let rdb: Buffer;
    try {
      rdb = this.server.persistence.buildRdb();
    } catch (error) {
      Logger.warn('[ReplicationPrimary.transfer] Could not build the RDB for a full sync', { err: (error as Error).message });
      for (const c of clients) this.server.killClient(c);
      return;
    }
    // the replicas start from an empty client in db 0: the next command must SELECT
    this.streamDb = -1;
    for (const client of clients) {
      const info = client.replica;
      if (!info) continue;
      if (info.psync) this.writeRaw(client, `+FULLRESYNC ${this.replid} ${this.offset}\r\n`);
      if (this.cfg('repl-diskless-sync') === 'yes' && info.capaEof) {
        const mark = randomBytes(20).toString('hex');
        this.writeRaw(client, `$EOF:${mark}\r\n`);
        this.writeRaw(client, rdb);
        this.writeRaw(client, mark);
      } else {
        this.writeRaw(client, `$${rdb.length}\r\n`);
        this.writeRaw(client, rdb);
      }
      info.state = 'online';
      info.ackTime = Date.now();
      Logger.info(ReplicationMessages.LOG_REPLICA_ATTACHED, { addr: client.address, sync: 'full', bytes: rdb.length });
    }
  }

  // ──────────────────────────────────────────────
  // Acknowledgements
  // ──────────────────────────────────────────────

  /** REPLCONF ACK <offset> [FACK <aofoffset>] from an attached replica (never answered). */
  replicaAck(client: Client, offset: number, fack: number | null): void {
    const info = client.replica;
    if (!info?.attached) return;
    if (offset > info.ackOffset) info.ackOffset = offset;
    if (fack !== null && fack > info.aofAckOffset) info.aofAckOffset = fack;
    info.ackTime = Date.now();
    // the first ACK after a diskless load also confirms the replica is online
    if (info.state === 'send_bulk') info.state = 'online';
    this.serveWaiters();
  }

  /** Asks every replica for an ACK now (REPLCONF GETACK *, through the stream), at most once per tick. */
  protected requestAcks(): void {
    if (this.getAckPending || !this.replicas.size) return;
    this.getAckPending = true;
    setImmediate(() => {
      this.getAckPending = false;
      this.feedCommand(['REPLCONF', 'GETACK', '*']);
    });
  }

  /** Replicas whose acknowledged offset (FACK with `aof`) reached `target`. */
  protected countAcked(target: number, aof: boolean): number {
    let n = 0;
    for (const c of this.replicas) {
      const info = c.replica;
      if (info?.state === 'online' && (aof ? info.aofAckOffset : info.ackOffset) >= target) n++;
    }
    return n;
  }

  /** min-replicas-to-write: online replicas whose last ACK is at most min-replicas-max-lag seconds old. */
  goodReplicas(now = Date.now()): number {
    const maxLag = this.num('min-replicas-max-lag');
    let n = 0;
    for (const c of this.replicas) {
      const info = c.replica;
      if (info?.state === 'online' && Math.floor(now / 1000) - Math.floor(info.ackTime / 1000) <= maxLag) n++;
    }
    return n;
  }

  /** NOREPLICAS: a write must be refused (min-replicas-to-write and min-replicas-max-lag set, too few good replicas). */
  get notEnoughReplicas(): boolean {
    if (this.role !== 'master') return false;
    const want = this.num('min-replicas-to-write');
    return want > 0 && this.num('min-replicas-max-lag') > 0 && this.goodReplicas() < want;
  }

  // ──────────────────────────────────────────────
  // WAIT / WAITAOF
  // ──────────────────────────────────────────────

  /**
   * Blocks a client until `numreplicas` replicas acknowledged its last write (`aof`: WAITAOF, which also needs the
   * local fsync). Answers at once when already satisfied or when the client may not block (MULTI, scripts).
   */
  protected waitAcks(client: Client, numreplicas: number, timeoutMs: number, noBlock: boolean, aof: WaitEntry['aof']): HandlerResult {
    const target = client.woff;
    const reply = (): number | number[] => {
      const replicas = this.countAcked(target, aof !== null);
      return aof ? [aof.local, replicas] : replicas;
    };
    const satisfied = (): boolean => this.countAcked(target, aof !== null) >= numreplicas && (!aof || aof.local >= aof.numlocal);
    if (satisfied() || noBlock) return reply();
    const block = new Block([], 0, () => undefined, reply());
    const entry: WaitEntry = { client, block, target, numreplicas, aof, timer: null };
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => this.finishWait(entry), timeoutMs);
    }
    this.waiters.push(entry);
    this.requestAcks();
    return block;
  }

  private finishWait(entry: WaitEntry): void {
    const i = this.waiters.indexOf(entry);
    if (i >= 0) this.waiters.splice(i, 1);
    if (entry.timer) clearTimeout(entry.timer);
    const { client } = entry;
    // CLIENT UNBLOCK or a disconnect may have ended the wait already
    if (client.closed || client.blocked?.retry !== entry.block.retry) return;
    const replicas = this.countAcked(entry.target, entry.aof !== null);
    this.server.releaseBlocked(client, entry.aof ? [entry.aof.local, replicas] : replicas);
  }

  /** After an ACK: answers every waiter now satisfied. */
  private serveWaiters(): void {
    for (const entry of [...this.waiters]) {
      const enough = this.countAcked(entry.target, entry.aof !== null) >= entry.numreplicas;
      if (enough && (!entry.aof || entry.aof.local >= entry.aof.numlocal)) this.finishWait(entry);
      else if (entry.client.closed) this.waiters.splice(this.waiters.indexOf(entry), 1);
    }
  }

  /** Answers every waiter with what it has now (a role change, server close). */
  protected releaseWaiters(): void {
    for (const entry of [...this.waiters]) this.finishWait(entry);
  }

  // ──────────────────────────────────────────────
  // Views
  // ──────────────────────────────────────────────

  /** The attached replicas as ROLE / INFO show them. */
  replicaViews(now = Date.now()): ReplicaView[] {
    const out: ReplicaView[] = [];
    for (const c of this.replicas) {
      const info = c.replica;
      if (!info) continue;
      const remote = (c.socket?.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
      out.push({
        ip: info.announcedIp ?? remote,
        port: info.listeningPort,
        state: info.state,
        offset: info.ackOffset,
        lag: Math.floor(now / 1000) - Math.floor(info.ackTime / 1000),
      });
    }
    return out;
  }

  // ──────────────────────────────────────────────
  // Cron
  // ──────────────────────────────────────────────

  /** Once a second: PING every repl-ping-replica-period, newlines to waiting replicas, replica timeouts, backlog TTL. */
  protected primaryCron(now: number): void {
    if (this.role === 'master' && this.replicas.size && now - this.lastPing >= this.num('repl-ping-replica-period') * 1000) {
      this.lastPing = now;
      this.feedCommand(['PING']);
    }
    const timeoutMs = this.num('repl-timeout') * 1000;
    for (const client of [...this.replicas]) {
      const info = client.replica;
      if (!info) continue;
      if (info.state === 'wait_bgsave') this.writeRaw(client, '\n');
      else if (now - info.ackTime > timeoutMs) {
        Logger.warn('[ReplicationPrimary.primaryCron] Disconnecting timedout replica', { addr: client.address });
        this.detach(client);
        this.server.killClient(client);
      }
    }
    const ttl = this.num('repl-backlog-ttl');
    if (this.role === 'master' && this.backlog && ttl > 0 && this.noReplicasSince !== null && now - this.noReplicasSince > ttl * 1000) {
      this.freeBacklog();
    }
  }
}
