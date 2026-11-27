import type { Socket } from 'node:net';

import { formatMessage } from '@/libs/message-format';
import { RespError, RespParser } from '@/libs/resp';

import MemoryService from '@/modules/memory/memory.service';
import TrackingService from '@/modules/tracking/tracking.service';

import { Client } from './server.client';
import type { RedisLiteServer } from './server.core';
import ServerMessages from './server.messages';
import type { PauseMode } from './server.types';

/** PROTO_IOBUF_LEN: the query buffer has room for at least this much before each read. */
const READ_LEN = 16 * 1024;

/** Connections and their I/O: accepting sockets, parsing requests, running a client's queued commands, closing. */
export class ServerConnections {
  /** What normal clients may not run now: FAILOVER and CLIENT PAUSE WRITE hold writes, CLIENT PAUSE ALL every command. */
  pauseMode: PauseMode | null = null;
  /** FAILOVER holds writes until resumeWrites(). */
  private failoverPause = false;
  /** CLIENT PAUSE: the mode and the end (ms) until CLIENT UNPAUSE or the timer. */
  private clientPause: { mode: PauseMode; end: number; timer: NodeJS.Timeout } | null = null;
  private nextClientId = 1;
  private readonly clientsById = new Map<number, Client>();
  private readonly pausedClients = new Set<Client>();

  constructor(private readonly server: RedisLiteServer) {}

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  accept(socket: Socket): void {
    const server = this.server;
    socket.setNoDelay(true);
    // clientSetDefaultAuth(): logged in as default when default is `on nopass`
    const client = new Client(this.nextClientId++, socket, !server.acl.defaultLoginAllowed(), server.defaultUser);
    server.clients.add(client);
    this.clientsById.set(client.id, client);
    server.stats.connections++;
    const parser = new RespParser({ maxBulkLen: () => server.config.num('proto-max-bulk-len') });
    socket.on('data', (chunk: Buffer) => {
      client.netIn += chunk.length;
      if (client.protocolError) return;
      // readQueryFromClient makes room for a 16 KB read (non-greedy) when the buffer has less
      if (client.queryBuf.cap < READ_LEN) client.queryBuf = MemoryService.sdsFresh(READ_LEN);
      const { commands, error } = parser.parse(chunk);
      for (let i = 0; i < commands.length; i++) client.pending.push(commands[i]);
      if (error !== null) client.protocolError = error;
      this.drain(client);
    });
    const cleanup = () => this.disconnect(client);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  /** A client on a socket this server opened itself (the replication link): listed and killable, no request parsing. */
  attachClient(socket: Socket): Client {
    const client = new Client(this.nextClientId++, socket, false, null);
    this.server.clients.add(client);
    this.clientsById.set(client.id, client);
    this.server.stats.connections++;
    return client;
  }

  /** Parks a client whose next command is a write while writes are paused; it runs again on resumeWrites(). */
  parkForPause(client: Client, argv: string[]): void {
    client.pending.unshift(argv);
    client.paused = true;
    this.pausedClients.add(client);
  }

  /** FAILOVER: write commands of normal clients wait until resumeWrites(). */
  pauseWrites(): void {
    this.failoverPause = true;
    this.updatePauseMode();
  }

  resumeWrites(): void {
    this.failoverPause = false;
    this.updatePauseMode();
  }

  /**
   * CLIENT PAUSE timeout mode: a pause already running keeps the stricter mode and the later end of the two. Paused
   * clients run again on CLIENT UNPAUSE or when the time is up.
   */
  pauseClients(mode: PauseMode, ms: number): void {
    const now = Date.now();
    const current = this.clientPause;
    const end = Math.max(now + ms, current?.end ?? 0);
    const strict: PauseMode = mode === 'all' || current?.mode === 'all' ? 'all' : 'write';
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(() => this.unpauseClients(), Math.max(0, end - now));
    timer.unref();
    this.clientPause = { mode: strict, end, timer };
    this.updatePauseMode();
  }

  /** CLIENT UNPAUSE, or the CLIENT PAUSE timeout. */
  unpauseClients(): void {
    if (this.clientPause) clearTimeout(this.clientPause.timer);
    this.clientPause = null;
    this.updatePauseMode();
  }

  clientById(id: number): Client | undefined {
    return this.clientsById.get(id);
  }

  /** A client that is not attached to a socket (embedded use, tests). */
  createInternalClient(): Client {
    return new Client(this.nextClientId++, null, false, null);
  }

  /** Closes a connection at once (CLIENT KILL) and forgets its state. */
  killClient(client: Client): void {
    this.disconnect(client);
    client.socket?.destroy();
  }

  disconnect(client: Client): void {
    const server = this.server;
    if (client.closed) return;
    server.stats.netIn += client.netIn;
    server.stats.netOut += client.netOut;
    client.closed = true;
    server.clients.delete(client);
    this.clientsById.delete(client.id);
    client.watched.clear();
    this.pausedClients.delete(client);
    if (client.replica) server.replication.detach(client);
    if (client.tracking) TrackingService.disable(server.tracking, client);
    if (client.blocked) server.blocking.unblock(client.blocked);
    server.pubsub.forget(client);
  }

  /**
   * Runs the client's queued commands until it blocks. The socket is corked meanwhile, so the replies of a pipelined
   * batch leave in one write instead of one syscall each (same bytes, same order; `end()` flushes a corked socket).
   */
  drain(client: Client): void {
    const socket = client.socket;
    socket?.cork();
    try {
      while (!client.closed && !client.blocked && !client.paused && client.pending.length) {
        const argv = client.pending.shift() as string[];
        this.server.dispatcher.runTopLevel(client, argv);
        if (client.closeAfterReply) {
          client.pending.length = 0;
          socket?.end();
          this.disconnect(client);
        }
      }
      if (client.protocolError && !client.closed && !client.blocked && !client.paused && !client.pending.length && !client.protocolErrorSent) {
        client.protocolErrorSent = true;
        client.write(new RespError(formatMessage(ServerMessages.GENERIC_ERROR, { message: client.protocolError })), true);
        socket?.end();
      }
    } finally {
      if (socket && socket.writableCorked > 0) socket.uncork();
    }
  }

  /** Server close: every socket is destroyed and every client forgotten. */
  closeAll(): void {
    const server = this.server;
    this.pausedClients.clear();
    this.unpauseClients();
    for (const client of server.clients) {
      client.closed = true;
      client.socket?.destroy();
    }
    server.clients.clear();
    this.clientsById.clear();
    server.keyspace.watches.clear();
  }

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Recomputes the pause mode from FAILOVER and CLIENT PAUSE; clients parked by a mode that ended run again. */
  private updatePauseMode(): void {
    const pause = this.clientPause;
    const before = this.pauseMode;
    this.pauseMode = pause?.mode === 'all' ? 'all' : pause || this.failoverPause ? 'write' : null;
    if (this.pauseMode === before || this.pauseMode === 'all') return;
    // a lighter pause: the dispatcher parks again the clients whose next command is still held
    const clients = [...this.pausedClients];
    this.pausedClients.clear();
    for (const client of clients) {
      client.paused = false;
      this.drain(client);
    }
  }
}
