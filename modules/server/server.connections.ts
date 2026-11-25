import type { Socket } from 'node:net';

import { formatMessage } from '@/libs/message-format';
import { RespError, RespParser } from '@/libs/resp';

import { Client } from './server.client';
import type { RedisLiteServer } from './server.core';
import ServerMessages from './server.messages';

/** Connections and their I/O: accepting sockets, parsing requests, running a client's queued commands, closing. */
export class ServerConnections {
  private nextClientId = 1;
  private readonly clientsById = new Map<number, Client>();

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
      client.pending.push(...commands);
      if (error !== null) client.protocolError = error;
      this.drain(client);
    });
    const cleanup = () => this.disconnect(client);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
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
    if (client.tracking) server.tracking.disable(client);
    if (client.blocked) server.blocking.unblock(client.blocked);
    server.pubsub.forget(client);
  }

  /** Runs the client's queued commands until it blocks. */
  drain(client: Client): void {
    while (!client.closed && !client.blocked && client.pending.length) {
      const argv = client.pending.shift() as string[];
      this.server.dispatcher.runTopLevel(client, argv);
      if (client.closeAfterReply) {
        client.pending.length = 0;
        client.socket?.end();
        this.disconnect(client);
      }
    }
    if (client.protocolError && !client.closed && !client.blocked && !client.pending.length && !client.protocolErrorSent) {
      client.protocolErrorSent = true;
      client.write(new RespError(formatMessage(ServerMessages.GENERIC_ERROR, { message: client.protocolError })), true);
      client.socket?.end();
    }
  }

  /** Server close: every socket is destroyed and every client forgotten. */
  closeAll(): void {
    const server = this.server;
    for (const client of server.clients) {
      client.closed = true;
      client.socket?.destroy();
    }
    server.clients.clear();
    this.clientsById.clear();
  }
}
