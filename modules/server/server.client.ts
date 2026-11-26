import type { Socket } from 'node:net';

import type { Reply } from '@/libs/resp';
import type { Protocol } from '@/libs/resp';
import { encode, RespPush } from '@/libs/resp';

import type { AclUser } from '@/modules/acl/acl.structure';
import type { ReplicaInfo } from '@/modules/replication/replication.types';

import { WatchedKeys } from './server.watch';

export interface Waiter {
  client: Client;
  /** `${db}:${key}` of every key the client waits on. */
  dbKeys: string[];
  retry: () => Reply | undefined;
  timeoutReply: Reply;
  timer: NodeJS.Timeout | null;
  done: boolean;
  /** The blocked command (ACL permissions are checked again before it is served, like Redis reprocessing it). */
  argv?: string[];
}

/** One connection's state. */
export class Client {
  name = '';
  libName = '';
  libVer = '';
  dbIndex = 0;
  /** Protocol negotiated with HELLO (2 by default). */
  resp: Protocol = 2;
  /** Logged in: false only while the default user requires a password and the client has not authenticated yet. */
  authenticated: boolean;
  /** The ACL user of the connection (`default` until AUTH); null = internal superuser client (no ACL checks). */
  user: AclUser | null;
  /** Running the queued commands of EXEC (Redis keeps CLIENT_MULTI set then: ACL LOG context `multi`). */
  inExec = false;
  readonly createdAt = Date.now();
  lastActiveAt = Date.now();
  /** Full name (`client|info`) of the last command run, for CLIENT LIST `cmd=`. */
  lastCommand = 'NULL';
  /** Commands run by this connection (CLIENT LIST `tot-cmds`). */
  commandsProcessed = 0;
  /** Bytes read / written (CLIENT LIST `tot-net-in` / `tot-net-out`). */
  netIn = 0;
  netOut = 0;

  /** MULTI state: null when not in a transaction. */
  multi: string[][] | null = null;
  multiError = false;
  /** WATCHed keys and whether one of them changed since (registered in the server's ServerWatches). */
  readonly watched = new WatchedKeys();

  readonly channels = new Set<string>();
  readonly patterns = new Set<string>();
  readonly shardChannels = new Set<string>();
  /** CLIENT NO-TOUCH ON: reads do not update LRU/LFU (TOUCH still does). */
  noTouch = false;
  /** In MONITOR mode: receives every command the server runs. */
  monitor = false;
  /** CLIENT TRACKING ON and its REDIRECT target (0 = none). */
  tracking = false;
  trackingRedirect = 0;
  /** Tracking options: BCAST, OPTIN, OPTOUT, NOLOOP; the BCAST prefixes ('' = every key). */
  trackingBcast = false;
  trackingOptin = false;
  trackingOptout = false;
  trackingNoloop = false;
  readonly trackingPrefixes = new Set<string>();
  /** CLIENT CACHING YES / NO, for the next command (or transaction / script) only. */
  trackingCaching: 'yes' | 'no' | null = null;
  /** The REDIRECT client went away (CLIENT LIST flag R, TRACKINGINFO broken_redirect). */
  trackingRedirectBroken = false;
  /** CLIENT NO-EVICT ON. */
  noEvict = false;
  /** CLIENT REPLY OFF: no replies at all. */
  replyOff = false;
  /** CLIENT REPLY SKIP: the next command's reply is suppressed. */
  skipNext = false;
  /** The reply of the command being run is suppressed (CLIENT REPLY SKIP / OFF itself). */
  skipCurrent = false;
  /** Close the connection once the current reply is written (CLIENT KILL of oneself). */
  closeAfterReply = false;
  /** Protocol error that stopped the request parser; sent once the commands before it have been served. */
  protocolError: string | null = null;
  protocolErrorSent = false;

  /** Replication, master side: set by REPLCONF / PSYNC on a replica's connection (CLIENT LIST flag S). */
  replica: ReplicaInfo | null = null;
  /** Replication, replica side: this is the connection the master's stream runs on (CLIENT LIST flag M). */
  isMaster = false;
  /** master_repl_offset after this client's last propagated write (what WAIT / WAITAOF wait for). */
  woff = 0;

  /** Its next command is a write waiting for writes to resume (FAILOVER pauses them). */
  paused = false;

  blocked: Waiter | null = null;
  readonly pending: string[][] = [];
  closed = false;

  constructor(
    readonly id: number,
    readonly socket: Socket | null,
    requiresAuth: boolean,
    user: AclUser | null = null,
  ) {
    this.authenticated = !requiresAuth;
    this.user = user;
  }

  get subscriptionCount(): number {
    return this.channels.size + this.patterns.size + this.shardChannels.size;
  }

  get address(): string {
    return this.socket ? `${this.socket.remoteAddress ?? '?'}:${this.socket.remotePort ?? 0}` : 'internal';
  }

  /**
   * Sends a reply. CLIENT REPLY OFF / SKIP suppress everything except out-of-band pushes, unless `force`. Replication
   * connections (the master's, an attached replica's) get no replies at all.
   */
  write(reply: Reply, force = false): void {
    if (this.closed || !this.socket) return;
    // a master never reads replies from its replica, and a replica's connection carries the stream only
    if (this.isMaster || this.replica?.attached) return;
    if (!force && (this.replyOff || this.skipCurrent) && !(reply instanceof RespPush)) return;
    const data = encode(reply, this.resp);
    this.netOut += data.length;
    this.socket.write(data);
  }
}
