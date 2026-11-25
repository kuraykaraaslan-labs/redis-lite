import type { CommandMeta, KeyRef } from './command.types';

/** Key extraction from a command line through the key specs (COMMAND GETKEYS, ACL key checks, notifications). */
export default class CommandKeysService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** SORT options followed by values that are not keys (LIMIT offset count, GET pattern, BY pattern). */
  private static readonly SORT_SKIP: Record<string, number> = { limit: 2, get: 1, by: 1 };

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** SORT has unknown key specs (BY/GET patterns, STORE anywhere): Redis uses sortGetKeys(). */
  private static sortKeys(meta: CommandMeta, argv: string[]): KeyRef[] {
    const out: KeyRef[] = [{ index: 1, flags: meta.keySpecs[0]?.flags ?? ['RO', 'access'] }];
    let store: number | null = null;
    for (let i = 2; i < argv.length; i++) {
      const opt = argv[i].toLowerCase();
      if (meta.name === 'sort' && opt === 'store' && i + 1 < argv.length) {
        store = i + 1;
        i++;
        continue;
      }
      i += CommandKeysService.SORT_SKIP[opt] ?? 0;
    }
    if (store !== null) out.push({ index: store, flags: ['OW', 'update'] });
    return out;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Redis getKeysUsingKeySpecs(); argv includes the command name. Null = the key specs could not be applied (invalid arguments). */
  static keysFromSpecs(meta: CommandMeta, argv: string[]): KeyRef[] | null {
    if (meta.name === 'sort' || meta.name === 'sort_ro') return CommandKeysService.sortKeys(meta, argv);
    const argc = argv.length;
    const out: KeyRef[] = [];
    for (const spec of meta.keySpecs) {
      if (spec.flags.includes('not_key')) continue;
      let first = 0;
      if (spec.begin.type === 'index') first = spec.begin.index;
      else if (spec.begin.type === 'keyword') {
        const { keyword, startfrom } = spec.begin;
        const start = startfrom > 0 ? startfrom : argc + startfrom;
        const end = startfrom > 0 ? argc - 1 : 1;
        for (let i = start; i !== end; i = start <= end ? i + 1 : i - 1) {
          if (i >= argc || i < 1) break;
          if (argv[i].toLowerCase() === keyword.toLowerCase()) {
            first = i + 1;
            break;
          }
        }
        if (!first) continue;
      } else continue;

      let last: number;
      let step: number;
      if (spec.find.type === 'range') {
        step = spec.find.keystep;
        if (spec.find.lastkey >= 0) last = first + spec.find.lastkey;
        else if (!spec.find.limit) last = argc + spec.find.lastkey;
        else last = first + (Math.floor((argc - first) / spec.find.limit) + spec.find.lastkey);
      } else if (spec.find.type === 'keynum') {
        if (first + spec.find.keynumidx >= argc) return null;
        const raw = argv[first + spec.find.keynumidx];
        if (!/^-?\d+$/.test(raw)) return null;
        const numkeys = Number(raw);
        if (numkeys < 0) return null;
        first += spec.find.firstkey;
        last = first + numkeys - 1;
        step = spec.find.keystep;
      } else continue;

      for (let i = first; i <= last; i += step) {
        if (i >= argc || i < first) {
          if (meta.arity < 0) continue;
          return null;
        }
        out.push({ index: i, flags: spec.flags });
      }
    }
    return out;
  }

  /** The key names of a command line (argv includes the command name); none when the key specs do not apply. */
  static keyNames(meta: CommandMeta, argv: string[]): string[] {
    return (CommandKeysService.keysFromSpecs(meta, argv) ?? []).map((r) => argv[r.index]);
  }

  /** Whether COMMAND GETKEYS can report keys for this command. */
  static commandHasKeys(meta: CommandMeta): boolean {
    return meta.keySpecs.some((s) => !s.flags.includes('not_key'));
  }
}
