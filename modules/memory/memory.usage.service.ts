import PersistenceService from '@/modules/persistence/persistence.service';
import type { RdbOptions } from '@/modules/persistence/persistence.types';
import type { RedisValue } from '@/modules/database/database.types';
import type { ListDeque } from '@/modules/lists/lists.deque.structure';

import MemoryAllocModel from './memory.alloc.model';
import MemoryObjectModel from './memory.object.model';
import type { MemoryUsageOptions, QuicklistDebugInfo } from './memory.types';

/** Per-key figures: MEMORY USAGE and the DEBUG OBJECT fields (serializedlength, ql_*). */
export default class MemoryUsageService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** MEMORY USAGE's default SAMPLES. */
  static readonly DEFAULT_SAMPLES = 5;

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** What one key owns: its key sds and objectComputeSize of its value. */
  static objectSize(key: string, value: RedisValue, encoding: string, opts: MemoryUsageOptions): number {
    return MemoryObjectModel.objectSize(key, value, encoding, opts);
  }

  /** MEMORY USAGE key [SAMPLES n]: objectComputeSize + the key sds + the keyspace dict entry (sizeof, 24 bytes). */
  static memoryUsage(key: string, value: RedisValue, encoding: string, opts: MemoryUsageOptions): number {
    return MemoryObjectModel.objectSize(key, value, encoding, opts) + MemoryAllocModel.SIZES.dictEntry;
  }

  /** DEBUG OBJECT serializedlength: rdbSavedObjectLen, i.e. the RDB object body (no type byte, no DUMP footer). */
  static serializedLength(value: RedisValue, opts?: Partial<RdbOptions>): number {
    return PersistenceService.encodeObject(value, opts).body.length;
  }

  /** The ql_* fields DEBUG OBJECT prints for a list (every list is a quicklist in Redis 7.0). */
  static debugQuicklistInfo(list: ListDeque): QuicklistDebugInfo {
    const { nodes, fill, compress } = list.layout;
    return {
      nodes: nodes.length,
      avgNode: nodes.length ? list.length / nodes.length : 0,
      listpackMax: fill,
      compressed: compress !== 0 ? 1 : 0,
      uncompressedSize: nodes.reduce((n, q) => n + q.bytes, 0),
    };
  }
}
