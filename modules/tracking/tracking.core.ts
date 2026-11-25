/**
 * Server-assisted client-side caching (CLIENT TRACKING), following the redis.io client-side caching docs and the
 * CLIENT TRACKING / CACHING / GETREDIR / TRACKINGINFO command pages.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * - Default mode: the keys a tracking client reads (read-only commands) are remembered in one invalidation table
 *   (key name → client ids; the database number is not part of it, as documented). When such a key is modified,
 *   expires or is evicted, every client remembered for it gets one invalidation message and the key leaves the table
 *   (the client must read it again to be tracked again).
 * - OPTIN / OPTOUT: reads are tracked only after CLIENT CACHING YES / unless CLIENT CACHING NO, for the next command
 *   (a whole MULTI/EXEC or script counts as one).
 * - BCAST: nothing is remembered; every modified key matching one of the client's prefixes ('' = all keys) is
 *   announced. Keys are collected and sent in one message per prefix after the current event-loop turn.
 * - NOLOOP: no invalidation for keys the client modified itself.
 * - REDIRECT: messages go to another connection. A RESP3 target gets the `invalidate` push; a RESP2 target gets a
 *   Pub/Sub message on `__redis__:invalidate` when it is subscribed to that channel. When the target is gone, a RESP3
 *   tracking client is told with a `tracking-redir-broken` push.
 * - FLUSHALL / FLUSHDB: every tracking client gets an invalidation with a null key list, and the table is emptied.
 * - tracking-table-max-keys: when the table grows larger, keys are dropped from it (oldest first) and invalidated as if
 *   they had been modified.
 * - Invalidations for the client running the current command are delivered after that command's reply.
 */
import type { Client } from '@/modules/server/server.service';

import type { BcastPrefix, TrackingHost, TrackingState } from './tracking.types';

/**
 * The per-server tracking state the server owns (a stateful component): the invalidation table, BCAST prefixes and
 * deferred messages. Every operation on it is a TrackingService method taking this object as its first argument.
 */
export class Tracking implements TrackingState {
  readonly table = new Map<string, Set<number>>();
  readonly prefixes = new Map<string, BcastPrefix>();
  bcastScheduled = false;
  readonly deferred = new Map<Client, Array<string[] | null>>();
  current: Client | null = null;

  constructor(readonly host: TrackingHost) {}
}

export default Tracking;
