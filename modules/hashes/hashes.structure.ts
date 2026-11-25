import type { CommandContext } from '@/modules/command/command.types';

import type { FieldExpires, HashValue } from './hashes.types';

/**
 * Per-field expiry (Redis 7.4 hash field TTL) and the hash lookups every hash command goes through. Expired fields are
 * dropped on access, and the key with them once its last field is gone. Shared by the hash sub-services (which never
 * import each other).
 */
export default class HashStore {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Hash map → field → absolute ms. A WeakMap, so a deleted hash takes its TTLs with it. */
  private static readonly fieldExpires = new WeakMap<HashValue, FieldExpires>();

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static purgeExpiredFields(ctx: CommandContext, key: string, h: HashValue): void {
    const ttl = HashStore.fieldExpires.get(h);
    if (!ttl || !ttl.size) return;
    const now = Date.now();
    let expired = 0;
    for (const [field, at] of ttl) {
      if (at <= now) {
        ttl.delete(field);
        h.delete(field);
        expired++;
      }
    }
    if (!expired) return;
    ctx.db.removeIfEmpty(key);
    ctx.server.fieldsExpired(ctx.client.dbIndex, key, h.size === 0);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The hash at `key` with its expired fields dropped; undefined when missing (or now empty); WRONGTYPE otherwise. */
  static read(ctx: CommandContext, key: string): HashValue | undefined {
    const h = ctx.db.get(key, 'hash');
    if (!h) return undefined;
    HashStore.purgeExpiredFields(ctx, key, h);
    return h.size ? h : undefined;
  }

  /** Like `read`, but creates an empty hash when the key is missing. */
  static readForWrite(ctx: CommandContext, key: string): HashValue {
    HashStore.read(ctx, key);
    return ctx.db.getOrCreate(key, 'hash', () => new Map());
  }

  /** Field TTLs of a hash (absolute ms), for DUMP and persistence; undefined when no field has one. */
  static hashFieldExpires(h: HashValue): FieldExpires | undefined {
    const ttl = HashStore.fieldExpires.get(h);
    return ttl && ttl.size ? new Map(ttl) : undefined;
  }

  /** Restores field TTLs (RESTORE, loading); fields whose time has passed are dropped on next access. */
  static setHashFieldExpires(h: HashValue, ttl: FieldExpires): void {
    if (ttl.size) HashStore.fieldExpires.set(h, new Map(ttl));
  }

  /** True when any field of this hash has a TTL (Redis then uses the listpackex / hashtable-with-metadata encodings). */
  static hashHasFieldTtl(h: HashValue): boolean {
    return (HashStore.fieldExpires.get(h)?.size ?? 0) > 0;
  }

  /** The absolute expiry (ms) of one field, or undefined. */
  static fieldTtl(h: HashValue, field: string): number | undefined {
    return HashStore.fieldExpires.get(h)?.get(field);
  }

  static setFieldTtl(h: HashValue, field: string, at: number): void {
    let ttl = HashStore.fieldExpires.get(h);
    if (!ttl) HashStore.fieldExpires.set(h, (ttl = new Map()));
    ttl.set(field, at);
  }

  /** Removes a field's TTL; true when it had one. */
  static clearFieldTtl(h: HashValue, field: string): boolean {
    return HashStore.fieldExpires.get(h)?.delete(field) ?? false;
  }
}
