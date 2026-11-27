import type { CommandContext } from '@/modules/command/command.types';

import type { HashValue } from './hashes.types';

/** The hash lookups every hash command goes through. Shared by the hash sub-services (which never import each other). */
export default class HashStore {
  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The hash at `key`; undefined when missing; WRONGTYPE otherwise. */
  static read(ctx: CommandContext, key: string): HashValue | undefined {
    return ctx.db.get(key, 'hash');
  }

  /** Like `read`, but creates an empty hash when the key is missing. */
  static readForWrite(ctx: CommandContext, key: string): HashValue {
    return ctx.db.getOrCreate(key, 'hash', () => new Map());
  }
}
