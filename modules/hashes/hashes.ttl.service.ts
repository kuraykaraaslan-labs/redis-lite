import type { CommandContext } from '@/modules/command/command.types';

import type { HExpireInput, HTtlInput, KeyFieldsInput } from './hashes.dto';
import HashStore from './hashes.structure';

/** Field TTLs: HEXPIRE, HPEXPIRE, HEXPIREAT, HPEXPIREAT, HTTL, HPTTL, HEXPIRETIME, HPEXPIRETIME, HPERSIST. */
export default class HashesTtlService {
  /**
   * HEXPIRE family, one result per field: -2 no such field, 0 condition not met, 1 TTL set, 2 field deleted because
   * the time is in the past. A field without TTL counts as an infinite TTL for GT / LT.
   */
  static hExpire(ctx: CommandContext, { key, amount, unit, absolute, condition, fields }: HExpireInput): number[] {
    const h = HashStore.read(ctx, key);
    if (!h) return fields.map(() => -2);
    const at = absolute ? amount * unit : Date.now() + amount * unit;
    const out = fields.map((f) => {
      if (!h.has(f)) return -2;
      const current = HashStore.fieldTtl(h, f);
      if (condition === 'nx' && current !== undefined) return 0;
      if (condition === 'xx' && current === undefined) return 0;
      if (condition === 'gt' && (current === undefined || at <= current)) return 0;
      if (condition === 'lt' && current !== undefined && at >= current) return 0;
      if (at <= Date.now()) {
        h.delete(f);
        HashStore.clearFieldTtl(h, f);
        return 2;
      }
      HashStore.setFieldTtl(h, f, at);
      return 1;
    });
    ctx.db.removeIfEmpty(key);
    return out;
  }

  /** HTTL family: -2 no such field, -1 no TTL, else the remaining (or absolute) time in `unit` ms. */
  static hTtl(ctx: CommandContext, { key, fields, unit, absolute }: HTtlInput): number[] {
    const h = HashStore.read(ctx, key);
    return fields.map((f) => {
      if (!h?.has(f)) return -2;
      const at = HashStore.fieldTtl(h, f);
      if (at === undefined) return -1;
      return absolute ? Math.floor(at / unit) : Math.max(0, Math.round((at - Date.now()) / unit));
    });
  }

  /** HPERSIST: -2 no such field, -1 no TTL, 1 TTL removed. */
  static hPersist(ctx: CommandContext, { key, fields }: KeyFieldsInput): number[] {
    const h = HashStore.read(ctx, key);
    return fields.map((f) => {
      if (!h?.has(f)) return -2;
      return HashStore.clearFieldTtl(h, f) ? 1 : -1;
    });
  }
}
