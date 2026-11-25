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
import { AppError } from '@/libs/app-error';
import { firstIssue } from '@/libs/schemas';

import type { Client } from '@/modules/server/server.client';

import { ClientCachingDTO, ClientTrackingDTO } from './tracking.dto';
import type { ClientTrackingInput } from './tracking.dto';
import TrackingMessages from './tracking.messages';
import TrackingService from './tracking.service';
import type { BcastPrefix, TrackingHost, TrackingInfo, TrackingState, TrackingStats } from './tracking.types';

/**
 * The per-server tracking state (TrackingState) the server owns, with its operations delegated to TrackingService.
 * The delegating methods keep server.core / connection.commands compiling (step-2 compatibility): new code calls
 * `TrackingService.x(server.tracking, …)`.
 */
export class Tracking implements TrackingState {
  readonly table = new Map<string, Set<number>>();
  readonly prefixes = new Map<string, BcastPrefix>();
  bcastScheduled = false;
  readonly deferred = new Map<Client, Array<string[] | null>>();
  current: Client | null = null;

  constructor(readonly host: TrackingHost) {}

  configure(client: Client, o: ClientTrackingInput): void {
    TrackingService.configure(this, client, o);
  }

  disable(client: Client): void {
    TrackingService.disable(this, client);
  }

  /** @deprecated Parses `value` and throws on a bad one; new code validates with ClientCachingDTO (validation errors are returned, not thrown). */
  caching(client: Client, value: string): void {
    const parsed = ClientCachingDTO.safeParse([value]);
    if (!parsed.success) throw new AppError(firstIssue(parsed.error));
    TrackingService.caching(client, parsed.data);
  }

  info(client: Client): TrackingInfo {
    return TrackingService.info(client);
  }

  remember(client: Client, keys: readonly string[]): void {
    TrackingService.remember(this, client, keys);
  }

  enforceLimit(): void {
    TrackingService.enforceLimit(this);
  }

  invalidate(key: string, by: Client | null): void {
    TrackingService.invalidate(this, key, by);
  }

  flushBcast(): void {
    TrackingService.flushBcast(this);
  }

  flushed(): void {
    TrackingService.flushed(this);
  }

  flushDeferred(client: Client): void {
    TrackingService.flushDeferred(this, client);
  }

  stats(): TrackingStats {
    return TrackingService.stats(this);
  }
}

// ============================================================================
// Compatibility (step 2): old export paths still imported outside the module
// ============================================================================

/** @deprecated Use `TrackingMessages.INVALIDATE_CHANNEL`. */
export const INVALIDATE_CHANNEL = TrackingMessages.INVALIDATE_CHANNEL;

/** @deprecated Use ClientTrackingDTO; this throws the first validation issue (connection.commands still calls it). */
export function parseTrackingArgs(args: string[]): ClientTrackingInput {
  const parsed = ClientTrackingDTO.safeParse(args);
  if (!parsed.success) throw new AppError(firstIssue(parsed.error));
  return parsed.data;
}

export type { TrackingHost };
/** @deprecated Use `ClientTrackingInput` from tracking.dto. */
export type TrackingOptions = ClientTrackingInput;

export default Tracking;
