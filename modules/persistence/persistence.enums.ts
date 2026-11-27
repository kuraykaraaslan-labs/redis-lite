import { z } from 'zod';

// ============================================================================
// Runtime state enums
// ============================================================================

/** Where a propagated op goes: both the AOF and replicas, or only one of them (PUBLISH goes to replicas only). */
export const PropagationTargetEnum = z.enum(['all', 'aof', 'repl']);

/** Outcome of the last BGSAVE / AOF write / AOF rewrite (INFO persistence `*_status`). */
export const BgStatusEnum = z.enum(['ok', 'err']);

/** AOF state: off, on, or waiting for the rewrite that turns it on (CONFIG SET appendonly yes). */
export const AofStateEnum = z.enum(['off', 'on', 'wait_rewrite']);

/** Manifest file types: base, history, incr. */
export const AofFileTypeEnum = z.enum(['b', 'h', 'i']);

/** What the startup load read. */
export const LoadSourceEnum = z.enum(['aof', 'rdb', 'none']);

// ============================================================================
// RDB format codes (binary constants of the file format, not validated input)
// ============================================================================

/**
 * RDB version written by this implementation (DUMP footer and the `REDIS00NN` file magic): Redis 7.0 writes 10 and
 * refuses anything newer (DUMP payloads and RDB files alike).
 */
export const RDB_VERSION = 10;

export const RDB_TYPE = {
  STRING: 0,
  LIST: 1,
  SET: 2,
  ZSET: 3,
  HASH: 4,
  ZSET_2: 5,
  MODULE_PRE_GA: 6,
  MODULE_2: 7,
  HASH_ZIPMAP: 9,
  LIST_ZIPLIST: 10,
  SET_INTSET: 11,
  ZSET_ZIPLIST: 12,
  HASH_ZIPLIST: 13,
  LIST_QUICKLIST: 14,
  STREAM_LISTPACKS: 15,
  HASH_LISTPACK: 16,
  ZSET_LISTPACK: 17,
  LIST_QUICKLIST_2: 18,
  STREAM_LISTPACKS_2: 19,
} as const;

export const RDB_OPCODE = {
  SLOT_INFO: 0xf4,
  FUNCTION2: 0xf5,
  FUNCTION_PRE_GA: 0xf6,
  MODULE_AUX: 0xf7,
  IDLE: 0xf8,
  FREQ: 0xf9,
  AUX: 0xfa,
  RESIZEDB: 0xfb,
  EXPIRETIME_MS: 0xfc,
  EXPIRETIME: 0xfd,
  SELECTDB: 0xfe,
  EOF: 0xff,
} as const;

/** Quicklist node containers in RDB_TYPE_LIST_QUICKLIST_2. */
export const QUICKLIST_CONTAINER = {
  PLAIN: 1,
  PACKED: 2,
} as const;

// ============================================================================
// Type Exports
// ============================================================================

export type PropagationTarget = z.infer<typeof PropagationTargetEnum>;
export type BgStatus = z.infer<typeof BgStatusEnum>;
export type AofState = z.infer<typeof AofStateEnum>;
export type AofFileType = z.infer<typeof AofFileTypeEnum>;
export type LoadSource = z.infer<typeof LoadSourceEnum>;
