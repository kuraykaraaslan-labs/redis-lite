import type { CommandContext } from '@/modules/command/command.types';
import DatabaseService from '@/modules/database/database.service';

/** The set lookups shared by the set sub-services (which never import each other). */
export default class SetStore {
  /** The set at `key`; undefined when missing; WRONGTYPE otherwise. */
  static read(ctx: CommandContext, key: string): Set<string> | undefined {
    return ctx.db.get(key, 'set');
  }

  /** Members in Redis's iteration order: an intset is kept sorted by value, other encodings in insertion order. */
  static members(ctx: CommandContext, key: string, s: Set<string>): string[] {
    const value = ctx.db.peek(key);
    const all = [...s];
    if (value && DatabaseService.objectEncoding(value, ctx.server.config) === 'intset') {
      all.sort((a, b) => {
        const x = BigInt(a);
        const y = BigInt(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
    }
    return all;
  }
}
