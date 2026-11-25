import type { CommandContext } from '@/modules/command/command.types';

import type { ExpireInput, KeyInput, TtlInput } from './keys.dto';

/** Key expiry: EXPIRE, PEXPIRE, EXPIREAT, PEXPIREAT, TTL, PTTL, EXPIRETIME, PEXPIRETIME, PERSIST. */
export default class KeysExpireService {
  /**
   * EXPIRE family: 1 when the timeout was set (or the key deleted because the time is in the past), 0 when the key is
   * missing or a condition is not met. A key without TTL counts as an infinite TTL for GT / LT.
   */
  static expire(ctx: CommandContext, { key, at, nx, xx, gt, lt }: ExpireInput): number {
    if (!ctx.db.has(key)) return 0;
    const current = ctx.db.getExpire(key);
    if (nx && current !== undefined) return 0;
    if (xx && current === undefined) return 0;
    if (gt && (current === undefined || at <= current)) return 0;
    if (lt && current !== undefined && at >= current) return 0;
    if (at <= Date.now()) {
      ctx.db.remove(key);
      return 1;
    }
    ctx.db.setExpire(key, at);
    return 1;
  }

  /** TTL family: -2 missing key, -1 no TTL, else the remaining (or absolute) time in `unit` ms. */
  static ttl(ctx: CommandContext, { key, unit, absolute }: TtlInput): number {
    if (!ctx.db.has(key)) return -2;
    const at = ctx.db.getExpire(key);
    if (at === undefined) return -1;
    if (absolute) return unit === 1 ? at : Math.floor((at + 500) / 1000);
    return Math.max(0, Math.round((at - Date.now()) / unit));
  }

  static persist(ctx: CommandContext, { key }: KeyInput): number {
    return ctx.db.has(key) && ctx.db.persist(key) ? 1 : 0;
  }
}
