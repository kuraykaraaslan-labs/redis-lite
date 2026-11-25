import type { Client } from '@/modules/server/server.client';
import type { ServerConfig } from '@/modules/server/server.config';

/** What tracking needs from the server. */
export interface TrackingHost {
  readonly config: ServerConfig;
  clientById(id: number): Client | undefined;
  /** Every connected client. */
  readonly clients: Iterable<Client>;
}

/** BCAST state of one prefix: subscribed clients and the keys modified since the last delivery (key → ids of modifiers). */
export interface BcastPrefix {
  clients: Set<Client>;
  pending: Map<string, Set<number>>;
}

/** The per-server tracking state the services operate on. */
export interface TrackingState {
  readonly host: TrackingHost;
  /** Default mode: key → ids of the clients that read it. */
  readonly table: Map<string, Set<number>>;
  /** BCAST: prefix → subscribed clients and pending keys. */
  readonly prefixes: Map<string, BcastPrefix>;
  bcastScheduled: boolean;
  /** Invalidations for the client whose command is running, sent after its reply. */
  readonly deferred: Map<Client, Array<string[] | null>>;
  /** The client running the current top-level command (or being served after blocking). */
  current: Client | null;
}

/** CLIENT TRACKINGINFO. */
export interface TrackingInfo {
  flags: string[];
  redirect: number;
  prefixes: string[];
}

/** INFO stats tracking_total_keys / items / prefixes. */
export interface TrackingStats {
  keys: number;
  items: number;
  prefixes: number;
}
