import { matchGlob } from '@/libs/glob';
import { RespPairs } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import DatabaseService from '@/modules/database/database.service';

import type { HRandFieldInput, HScanInput } from './hashes.dto';
import HashStore from './hashes.structure';
import type { HashValue } from './hashes.types';

/** Walking a hash: HSCAN, HRANDFIELD. */
export default class HashesIterationService {
  /** HSCAN: a compact (listpack) hash is returned whole in one call, whatever COUNT says, as in Redis. */
  static hScan(ctx: CommandContext, { key, cursor, match, count }: HScanInput): Reply {
    const h = HashStore.read(ctx, key);
    if (!h) return ['0', []];
    const value = ctx.db.peek(key);
    const compact = value !== undefined && DatabaseService.isCompact(value, ctx.server.config);
    const { next, page } = compact ? { next: 0, page: [...h.keys()] } : DatabaseService.scanPage(h.keys(), cursor, count);
    const out: string[] = [];
    for (const f of page) {
      if (matchGlob(match, f)) out.push(f, h.get(f) ?? '');
    }
    return [String(next), out];
  }

  /**
   * HRANDFIELD on the hash read after the arguments were parsed (a bad count beats WRONGTYPE). A positive count
   * returns distinct fields, a negative one may repeat them.
   */
  static hRandField(h: HashValue | undefined, { count, withValues }: HRandFieldInput): Reply {
    const fields = [...(h?.keys() ?? [])];
    if (count === null) return fields.length ? fields[Math.floor(Math.random() * fields.length)] : null;
    // a count covering the whole hash returns every field in stored order, as Redis does
    const picked =
      count >= fields.length
        ? fields
        : count >= 0
          ? fields.sort(() => Math.random() - 0.5).slice(0, count)
        : Array.from({ length: fields.length ? -count : 0 }, () => fields[Math.floor(Math.random() * fields.length)]);
    return withValues ? new RespPairs(picked.map((f) => [f, h?.get(f) ?? ''])) : picked;
  }
}
