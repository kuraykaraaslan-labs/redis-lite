import type { Socket } from 'node:net';

import { formatMessage } from '@/libs/message-format';
import { RespError, RespParser } from '@/libs/resp';

import TrackingService from '@/modules/tracking/tracking.service';

import { Client } from './server.client';
import type { RedisLiteServer } from './server.core';
import ServerMessages from './server.messages';

/** Connections and their I/O: accepting sockets, parsing requests, running a client's queued commands, closing. */
export class ServerConnections {
  /** FAILOVER: write commands of normal clients wait (Client.paused) until resumeWrites(). */
  writesPaused = false;
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

  resumeWrites(): void {
    this.writesPaused = false;
    const clients = [...this.pausedClients];
    this.pausedClients.clear();
    for (const client of clients) {
      client.paused = false;
      this.drain(client);
    }
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
    for (const client of server.clients) {
      client.closed = true;
      client.socket?.destroy();
    }
    server.clients.clear();
    this.clientsById.clear();
    server.keyspace.watches.clear();
  }
}
