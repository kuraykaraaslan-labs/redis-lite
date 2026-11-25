import type { Stream } from '@/modules/streams/streams.structure';
import type { TimeSeries } from '@/modules/timeseries/timeseries.structure';
import type { ZSet } from '@/modules/zsets/zsets.structure';

// ============================================================================
// Values
// ============================================================================

export type RedisValue =
  /** `raw`: the value went through APPEND/SETRANGE/SETBIT/…, which Redis always leaves raw-encoded. */
  | { type: 'string'; value: string; raw?: boolean }
  | { type: 'hash'; value: Map<string, string> }
  | { type: 'list'; value: string[] }
  | { type: 'set'; value: Set<string> }
  | { type: 'zset'; value: ZSet }
  | { type: 'stream'; value: Stream }
  /** The time series module type (TYPE reports its module type name, `TSDB-TYPE`). */
  | { type: 'timeseries'; value: TimeSeries };

/** The in-memory value of each Redis type. */
export interface ValueMap {
  string: string;
  hash: Map<string, string>;
  list: string[];
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
