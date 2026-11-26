import type { ListDeque } from '@/modules/lists/lists.deque.structure';
import type { Stream } from '@/modules/streams/streams.structure';
import type { TimeSeries } from '@/modules/timeseries/timeseries.structure';
import type { ZSet } from '@/modules/zsets/zsets.structure';

// ============================================================================
// Values
// ============================================================================

export type RedisValue =
  /**
   * `raw`: the value went through APPEND/SETRANGE/SETBIT/…, which Redis always leaves raw-encoded. `noInt`: written by
   * INCRBYFLOAT, which never integer-encodes its result (embstr or raw by length, even for integer text).
   */
  | { type: 'string'; value: string; raw?: boolean; noInt?: boolean }
  | { type: 'hash'; value: Map<string, string> }
  | { type: 'list'; value: ListDeque }
  | { type: 'set'; value: Set<string> }
  | { type: 'zset'; value: ZSet }
  | { type: 'stream'; value: Stream }
  /** The time series module type (TYPE reports its module type name, `TSDB-TYPE`). */
  | { type: 'timeseries'; value: TimeSeries };

/** The in-memory value of each Redis type. */
export interface ValueMap {
  string: string;
  hash: Map<string, string>;
  list: ListDeque;
  set: Set<string>;
  zset: ZSet;
  stream: Stream;
  timeseries: TimeSeries;
}

export type ValueType = keyof ValueMap;
export type ValueOf<T extends ValueType> = ValueMap[T];

// ============================================================================
// Keyspace
// ============================================================================

/** Per-key access metadata, like the `lru` field of a Redis object (LRU clock or LFU counter + decay time). */
export interface Access {
  /** Last access, ms (LRU). */
  at: number;
  /** LFU logarithmic counter (0..255). */
  counter: number;
  /** LFU last decrement time, minutes. */
  decrementedAt: number;
}

/** Receives every structural change of a database: a key name, or null for "everything" (FLUSHDB, SWAPDB). */
export type KeyChangeListener = (key: string | null) => void;

/**
 * How the databases of a server treat keys whose TTL elapsed (shared by them, switched by the replication runtime):
 * - `active`: a master; such a key is deleted on access and by the active expire cycle;
 * - `replica`: a replica never expires keys itself; clients see such a key as missing, but it stays stored until the
 *   master's DEL arrives, and the active expire cycle does not run;
 * - `stream`: a replica applying its master's stream; the key is still there for the master's commands.
 */
export type ExpiryMode = 'active' | 'replica' | 'stream';

export interface ExpiryControl {
  mode: ExpiryMode;
}

/** One page of a SCAN-family iteration: the next cursor (0 = done) and the items of this page. */
export interface ScanPage {
  next: number;
  page: string[];
}

/** List size limit of list-max-listpack-size: positive = entries, negative = bytes. */
export interface ListLimit {
  entries: number;
  bytes: number;
}
