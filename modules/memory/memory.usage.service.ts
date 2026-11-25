import PersistenceService from '@/modules/persistence/persistence.service';
import type { FieldExpires, RdbOptions } from '@/modules/persistence/persistence.types';
import type { RedisValue } from '@/modules/database/database.types';

import MemoryAllocModel from './memory.alloc.model';
import MemoryObjectModel from './memory.object.model';
import MemoryQuicklistModel from './memory.quicklist.model';
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

  /** objectComputeSize of one key (its kvobj and everything it owns). */
  static objectSize(key: string, value: RedisValue, encoding: string, opts: MemoryUsageOptions): number {
    return MemoryObjectModel.objectSize(key, value, encoding, opts);
  }

  /** MEMORY USAGE key [SAMPLES n]: objectComputeSize + the keyspace dict entry (no-value dict, 16 bytes). */
  static memoryUsage(key: string, value: RedisValue, encoding: string, opts: MemoryUsageOptions): number {
    return MemoryObjectModel.objectSize(key, value, encoding, opts) + MemoryAllocModel.SIZES.dictEntryNoValue;
  }

  /** DEBUG OBJECT serializedlength: rdbSavedObjectLen, i.e. the RDB object body (no type byte, no DUMP footer). */
  static serializedLength(value: RedisValue, opts?: Partial<RdbOptions>, fieldExpires?: FieldExpires): number {
    return PersistenceService.encodeObject(value, opts, fieldExpires).body.length;
  }

  /** The ql_* fields DEBUG OBJECT prints for a quicklist-encoded list (compression not modelled: ql_compressed = depth != 0). */
  static debugQuicklistInfo(list: readonly string[], fill: number, compressDepth = 0): QuicklistDebugInfo {
    const nodes = MemoryQuicklistModel.quicklistNodes(list, fill);
    return {
      nodes: nodes.length,
      avgNode: nodes.length ? list.length / nodes.length : 0,
      listpackMax: fill,
      compressed: compressDepth !== 0 ? 1 : 0,
      uncompressedSize: nodes.reduce((n, q) => n + q.bytes, 0),
    };
  }
}
