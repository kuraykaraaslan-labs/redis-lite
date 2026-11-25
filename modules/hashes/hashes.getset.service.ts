import type { CommandContext } from '@/modules/command/command.types';

import type { HGetExInput, HSetExInput, KeyFieldsInput } from './hashes.dto';
import HashStore from './hashes.structure';

/** Reads and writes that also change field lifetimes: HGETDEL, HGETEX, HSETEX. */
export default class HashesGetSetService {
  /** HGETDEL: the values (nil for missing fields), then deletes the fields; the key goes with its last field. */
  static hGetDel(ctx: CommandContext, { key, fields }: KeyFieldsInput): Array<string | null> {
    const h = HashStore.read(ctx, key);
    const out = fields.map((f) => {
      const v = h?.get(f);
      if (v === undefined || !h) return null;
      h.delete(f);
      HashStore.clearFieldTtl(h, f);
      return v;
    });
    ctx.db.removeIfEmpty(key);
    return out;
  }

  /** HGETEX: the values, setting (EX/PX/EXAT/PXAT) or clearing (PERSIST) the TTL of the existing fields. */
  static hGetEx(ctx: CommandContext, { key, at, persist, fields }: HGetExInput): Array<string | null> {
    const h = HashStore.read(ctx, key);
    return fields.map((f) => {
      const v = h?.get(f);
      if (v === undefined || !h) return null;
      if (persist) HashStore.clearFieldTtl(h, f);
      else if (at !== null) HashStore.setFieldTtl(h, f, at);
      return v;
    });
  }

  /** HSETEX: 1 when the fields were set, 0 when FNX / FXX refused them. Without KEEPTTL or a time, TTLs are cleared. */
  static hSetEx(ctx: CommandContext, { key, fnx, fxx, keepTtl, at, pairs }: HSetExInput): number {
    const existing = HashStore.read(ctx, key);
    const fieldNames = pairs.filter((_, j) => j % 2 === 0);
    if (fnx && fieldNames.some((f) => existing?.has(f))) return 0;
    if (fxx && !fieldNames.every((f) => existing?.has(f))) return 0;
    const h = HashStore.readForWrite(ctx, key);
    for (let j = 0; j < pairs.length; j += 2) {
      h.set(pairs[j], pairs[j + 1]);
      if (at !== null) HashStore.setFieldTtl(h, pairs[j], at);
      else if (!keepTtl) HashStore.clearFieldTtl(h, pairs[j]);
    }
    return 1;
  }
}
