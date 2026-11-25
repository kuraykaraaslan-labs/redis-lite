import { matchGlob } from '@/libs/glob';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import DatabaseService from '@/modules/database/database.service';

import type { SScanInput } from './sets.dto';
import SetStore from './sets.structure';

/** SSCAN: a compact (intset / listpack) set is returned whole in one call, whatever COUNT says, as in Redis. */
export default class SetsScanService {
  static sScan(ctx: CommandContext, { key, cursor, match, count }: SScanInput): Reply {
    const s = SetStore.read(ctx, key);
    if (!s) return ['0', []];
    const value = ctx.db.peek(key);
    const compact = value !== undefined && DatabaseService.isCompact(value, ctx.server.config);
    const { next, page } = compact ? { next: 0, page: SetStore.members(ctx, key, s) } : DatabaseService.scanPage(s, cursor, count);
    return [String(next), page.filter((m) => matchGlob(match, m))];
  }
}
