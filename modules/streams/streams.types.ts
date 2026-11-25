import type { Stream } from './streams.structure';

/** A stream ID: both parts are unsigned 64-bit integers. */
export interface StreamId {
  ms: bigint;
  seq: bigint;
}

export interface StreamEntry {
  id: StreamId;
  fields: string[];
}

export interface PendingEntry {
  id: StreamId;
  consumer: string;
  deliveryTime: number;
  deliveryCount: number;
}

export interface Consumer {
  name: string;
  seenTime: number;
  activeTime: number;
  pending: Map<string, PendingEntry>;
}

export interface ConsumerGroup {
  name: string;
  lastId: StreamId;
  entriesRead: number | null;
  pending: Map<string, PendingEntry>;
  consumers: Map<string, Consumer>;
}

/** One radix-tree node of a Redis stream: a listpack holding up to stream-node-max-entries entries. */
export interface StreamNode {
  masterId: StreamId;
  masterFields: string[];
  /** Entries ever appended to this node (valid + deleted), as Redis counts them. */
  total: number;
  /** Entries not deleted. */
  live: number;
  /** Bytes of the entries part of the listpack (the master entry is computed from the live counters). */
  entryBytes: number;
  lastId: StreamId;
}

/**
 * An id argument whose validity is reported only once the key (and group) were checked, because Redis checks them
 * first: `$` (last), `>` (new), `+` (max), a well-formed id, or a malformed one (reported as an invalid stream ID).
 */
export type StreamIdToken =
  | { kind: 'id'; id: StreamId }
  | { kind: 'last' }
  | { kind: 'new' }
  | { kind: 'max' }
  | { kind: 'invalid' };

/** XCLAIM's IDLE (relative to now) or TIME (absolute, ms) option; the last one given wins. */
export type ClaimDeliveryTime = { kind: 'idle' | 'time'; ms: number };

/** A stream and one of its consumer groups (XCLAIM looks them up before parsing its arguments). */
export type GroupTarget = { s: Stream; g: ConsumerGroup };
