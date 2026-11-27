// Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
import AclCheckService from './acl.check.service';
import { AclCategoryEnum } from './acl.enums';
import type { AclSelector } from './acl.structure';
import type { CategoriesOf } from './acl.types';

/**
 * How Redis 7.0 describes a selector's command permissions (ACL LIST, ACL GETUSER, users.acl): not the rules as typed
 * but a description rebuilt from the command bitmap.
 *
 * - The base is `+@all` when the selector allows commands added in the future (the last of +@all / -@all wins), else
 *   `-@all`.
 * - Categories are then added (`+@cat` on a -@all base, `-@cat` on a +@all base) one at a time. A category qualifies
 *   when it fixes more commands than it does not (the commands it would wrongly flip, plus those already right); the
 *   next one is the qualifying category with the fewest such commands, then the one fixing the most, then ACL CAT order.
 * - The remaining differences are single commands: a command whose own bit differs (applied to its subcommands too),
 *   then each subcommand that still differs; first arguments allowed while a command's bit is off come last.
 */
export default class AclDescribeService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static parentOf(fullname: string): string | null {
    const bar = fullname.indexOf('|');
    return bar > 0 ? fullname.slice(0, bar) : null;
  }

  /** The categories a description may use, each with its member commands. */
  private static members(all: string[], categoriesOf: CategoriesOf): Array<[string, string[]]> {
    const byCategory = new Map<string, string[]>(AclCategoryEnum.options.map((c) => [c, []]));
    for (const name of all) {
      for (const cat of new Set(AclCheckService.categoriesOfCommand(categoriesOf, name))) byCategory.get(cat)?.push(name);
    }
    return [...byCategory.entries()];
  }

  /** The next category to apply to `fake` so it gets closer to `real`, or null. */
  private static nextCategory(
    categories: Array<[string, string[]]>,
    real: Set<string>,
    fake: Set<string>,
    additive: boolean,
  ): [string, string[]] | null {
    let best: { bad: number; good: number; entry: [string, string[]] } | null = null;
    for (const entry of categories) {
      const list = entry[1];
      let good = 0;
      for (const name of list) {
        if (additive ? real.has(name) && !fake.has(name) : !real.has(name) && fake.has(name)) good++;
      }
      const bad = list.length - good;
      if (good <= bad) continue;
      if (!best || bad < best.bad || (bad === best.bad && good > best.good)) best = { bad, good, entry };
    }
    return best ? best.entry : null;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The command part of a selector description ('-@all +@read -keys', '+@all -@admin +config|get'). */
  static commands(s: AclSelector, all: string[], categoriesOf: CategoriesOf): string {
    const names = all.map((n) => n.toLowerCase());
    const subcommands = new Map<string, string[]>();
    for (const name of names) {
      const parent = AclDescribeService.parentOf(name);
      if (parent) subcommands.set(parent, [...(subcommands.get(parent) ?? []), name]);
    }
    const real = new Set<string>();
    const firstArgs = new Map<string, string[]>();
    for (const name of names) {
      const bit = AclCheckService.commandBit(s, name, AclDescribeService.parentOf(name), categoriesOf);
      if (bit.allowed) real.add(name);
      else if (bit.firstArgs.length && !name.includes('|') && !subcommands.has(name)) firstArgs.set(name, bit.firstArgs);
    }
    const additive = !s.allCommands;
    const fake = new Set<string>(additive ? [] : names);
    const out = [additive ? '-@all' : '+@all'];
    const categories = AclDescribeService.members(names, categoriesOf);
    for (;;) {
      const next = AclDescribeService.nextCategory(categories, real, fake, additive);
      if (!next) break;
      for (const name of next[1]) {
        if (additive) fake.add(name);
        else fake.delete(name);
      }
      out.push(`${additive ? '+' : '-'}@${next[0]}`);
    }
    const fix = (name: string, family: string[]): void => {
      const allow = real.has(name);
      if (fake.has(name) === allow) return;
      out.push(`${allow ? '+' : '-'}${name}`);
      for (const n of family) {
        if (allow) fake.add(n);
        else fake.delete(n);
      }
    };
    for (const name of names) {
      if (name.includes('|')) continue;
      const subs = subcommands.get(name) ?? [];
      fix(name, [name, ...subs]);
      for (const sub of subs) fix(sub, [sub]);
    }
    for (const [name, args] of firstArgs) for (const arg of args) out.push(`+${name}|${arg}`);
    return out.join(' ');
  }
}
