// Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';

import type { RedisLiteServer } from './server.core';

/** How often the active expiry cycle runs (Redis's default hz 10). */
const SWEEP_INTERVAL_MS = 100;
/** Keys examined per database per cycle. */
const SWEEP_KEYS_PER_DB = 200;

/**
 * Per-server stateful component: the TCP listener (bind, CONFIG SET port rebinding, close) and the active expiry timer.
 * A class rather than a static service because each server instance owns its own socket and timer.
 */
export class ServerListener {
  private net: Server | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly server: RedisLiteServer) {}

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Binds host:port; rejects when the port cannot be bound. */
  async open(): Promise<AddressInfo> {
    const { options } = this.server;
    const net = createServer((socket) => this.server.connections.accept(socket));
    this.net = net;
    try {
      await new Promise<void>((resolve, reject) => {
        net.once('error', reject);
        net.listen(options.port, options.host, () => {
          net.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.net = null;
      throw error;
    }
    return net.address() as AddressInfo;
  }

  /**
   * CONFIG SET port: listen on the new port, then close the old listener (its open connections stay). Port 0 stops
   * listening on TCP, as in Redis. Binding is asynchronous here: when the new port cannot be bound, the old listener
   * stays and `port` goes back to the port still in use.
   */
  rebind(port: number, closing: boolean): void {
    const server = this.server;
    const old = this.net;
    if (!old || closing || port === server.options.port) return;
    const previous = server.options.port;
    server.options.port = port;
    if (port === 0) {
      this.net = null;
      old.close();
      return;
    }
    const net = createServer((socket) => server.connections.accept(socket));
    net.once('error', (error) => {
      if (server.options.port !== port) return;
      server.options.port = previous;
      server.config.set('port', String(previous));
      server.log('warn', '[ServerListener.rebind] unable to listen on the new port', { port, error: String(error) });
    });
    net.listen(port, server.options.host, () => {
      if (this.net !== old || server.isClosing()) {
        net.close();
        return;
      }
      this.net = net;
      old.close();
    });
  }

  /** Starts the active expiry cycle; it pauses while active expiry is off or a busy script is suspended. */
  startSweep(): void {
    const server = this.server;
    this.sweepTimer = setInterval(() => {
      if (!server.activeExpire || server.scriptSuspended()) return;
      const now = Date.now();
      for (const db of server.databases) db.sweep(now, SWEEP_KEYS_PER_DB);
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** Stops the expiry cycle and closes the listener (open connections are closed by the caller). */
  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    const net = this.net;
    this.net = null;
    if (net) await new Promise<void>((resolve) => net.close(() => resolve()));
  }
}
