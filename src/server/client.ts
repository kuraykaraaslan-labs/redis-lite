import type { Socket } from 'node:net';

import type { Reply } from '../resp';
import type { Protocol } from '../resp';
import { encode } from '../resp';

export interface Waiter {
  client: Client;
  /** `${db}:${key}` of every key the client waits on. */
  dbKeys: string[];
  retry: () => Reply | undefined;
  timeoutReply: Reply;
  timer: NodeJS.Timeout | null;
  done: boolean;
}

/** One connection's state. */
export class Client {
  name = '';
  libName = '';
  libVer = '';
  dbIndex = 0;
  /** Protocol negotiated with HELLO (2 by default). */
  resp: Protocol = 2;
  authenticated: boolean;
  readonly createdAt = Date.now();
  lastActiveAt = Date.now();
  lastCommand = 'NULL';

  /** MULTI state: null when not in a transaction. */
  multi: string[][] | null = null;
  multiError = false;
  /** WATCHed `${db}:${key}` → version at WATCH time. */
  readonly watched = new Map<string, number>();
  watchEpoch = 0;

  readonly channels = new Set<string>();
  readonly patterns = new Set<string>();
  readonly shardChannels = new Set<string>();
  /** CLIENT NO-TOUCH ON: reads do not update LRU/LFU (TOUCH still does). */
  noTouch = false;
  /** In MONITOR mode: receives every command the server runs. */
  monitor = false;

  blocked: Waiter | null = null;
  readonly pending: string[][] = [];
  closed = false;

  constructor(
    readonly id: number,
    readonly socket: Socket | null,
    requiresAuth: boolean,
  ) {
    this.authenticated = !requiresAuth;
  }

  get subscriptionCount(): number {
    return this.channels.size + this.patterns.size + this.shardChannels.size;
  }

  get address(): string {
    return this.socket ? `${this.socket.remoteAddress ?? '?'}:${this.socket.remotePort ?? 0}` : 'internal';
  }

  write(reply: Reply): void {
    if (this.closed || !this.socket) return;
    this.socket.write(encode(reply, this.resp));
  }
}
