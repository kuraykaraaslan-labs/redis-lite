import { formatMessage } from '@/libs/message-format';

import { AclCategoryEnum } from './acl.enums';
import type { AclDenyReason } from './acl.enums';
import AclMessages from './acl.messages';
import type { AclSelector, AclUser } from './acl.structure';
import type { AclDenial, CategoriesOf, ChannelAccess, CheckOptions, KeyAccess } from './acl.types';

/**
 * Permission checks: may a user run a command on these keys and channels (ACLCheckAllUserCommandPerm), the denial
 * texts, the glob matching of key and channel patterns, and ACL categories.
 */
export default class AclCheckService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** When every selector denies, the reported denial is the most specific one: channel > key > command. */
  private static readonly REASON_RANK: Record<AclDenyReason, number> = { command: 1, key: 2, channel: 4 };

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static globImpl(pat: string, p: number, str: string, s: number, skip: { longer: boolean }, nesting: number): boolean {
    if (nesting > 1000) return false;
    const pEnd = pat.length;
    const sEnd = str.length;
    while (p < pEnd && s < sEnd) {
      const c = pat[p];
      if (c === '*') {
        while (p + 1 < pEnd && pat[p + 1] === '*') p++;
        if (p + 1 === pEnd) return true;
        while (s < sEnd) {
          if (AclCheckService.globImpl(pat, p + 1, str, s, skip, nesting + 1)) return true;
          if (skip.longer) return false;
          s++;
        }
        skip.longer = true;
        return false;
      } else if (c === '?') {
        s++;
      } else if (c === '[') {
        p++;
        const not = pat[p] === '^';
        if (not) p++;
        let match = false;
        for (;;) {
          if (p < pEnd && pat[p] === '\\' && pEnd - p >= 2) {
            p++;
            if (pat[p] === str[s]) match = true;
          } else if (p < pEnd && pat[p] === ']') {
            break;
          } else if (p >= pEnd) {
            p--;
            break;
          } else if (pEnd - p >= 3 && pat[p + 1] === '-') {
            let start = pat.charCodeAt(p);
            let end = pat.charCodeAt(p + 2);
            const ch = str.charCodeAt(s);
            if (start > end) [start, end] = [end, start];
            p += 2;
            if (ch >= start && ch <= end) match = true;
          } else if (pat[p] === str[s]) {
            match = true;
          }
          p++;
        }
        if (not) match = !match;
        if (!match) return false;
        s++;
      } else {
        if (c === '\\' && pEnd - p >= 2) p++;
        if (pat[p] !== str[s]) return false;
        s++;
      }
      p++;
      if (s === sEnd) {
        while (p < pEnd && pat[p] === '*') p++;
        break;
      }
    }
    return p >= pEnd && s === sEnd;
  }

  /** Built-in channel extraction (getChannelsFromCommand): only publish/subscribe channels are ACL-checked. */
  private static channelsOf(command: string, args: string[]): ChannelAccess[] {
    switch (command) {
      case 'publish':
      case 'spublish':
        return args.length ? [{ channel: args[0], pattern: false }] : [];
      case 'subscribe':
      case 'ssubscribe':
        return args.map((channel) => ({ channel, pattern: false }));
      case 'psubscribe':
        return args.map((channel) => ({ channel, pattern: true }));
      default:
        return [];
    }
  }

  private static channelInList(list: string[], channel: string, isPattern: boolean): boolean {
    return list.some((p) => (isPattern ? p === channel : AclCheckService.globMatch(p, channel)));
  }

  private static categoriesNormalised(categoriesOf: CategoriesOf, command: string): string[] {
    return categoriesOf(command).map((c) => (c.startsWith('@') ? c.slice(1) : c).toLowerCase());
  }

  /** Replays the selector's command rules for one command (equivalent to Redis's command bitmap + first-args). */
  private static commandAllowed(
    s: AclSelector,
    fullname: string,
    parent: string | null,
    args: string[],
    categoriesOf: CategoriesOf,
  ): boolean {
    const { allowed, firstArgs } = AclCheckService.commandBit(s, fullname, parent, categoriesOf);
    if (allowed) return true;
    if (parent || firstArgs.length === 0 || args.length < 1) return false;
    const first = args[0].toLowerCase();
    return firstArgs.includes(first);
  }

  /** One selector's verdict: null = allowed, else the denial and the position of the denied key / channel. */
  private static checkSelector(
    s: AclSelector,
    command: string,
    subFullname: string | null,
    args: string[],
    keys: KeyAccess[],
    channels: ChannelAccess[],
    noauth: boolean,
    categoriesOf: CategoriesOf,
  ): [AclDenial, number] | null {
    const fullname = subFullname ?? command;
    if (!noauth && !AclCheckService.commandAllowed(s, fullname, subFullname ? command : null, args, categoriesOf)) {
      return [{ reason: 'command', object: fullname }, 0];
    }
    if (!s.allKeys) {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const ok = s.keyPatterns.some(
          (p) => (!k.read || p.read) && (!k.write || p.write) && AclCheckService.globMatch(p.pattern, k.key),
        );
        if (!ok) return [{ reason: 'key', object: k.key }, i + 1];
      }
    }
    if (!s.allChannels) {
      for (let i = 0; i < channels.length; i++) {
        const c = channels[i];
        if (!AclCheckService.channelInList(s.channels, c.channel, c.pattern)) return [{ reason: 'channel', object: c.channel }, i + 1];
      }
    }
    return null;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** A command's bit in the selector's command bitmap, and the first arguments allowed while the bit is off. */
  static commandBit(
    s: AclSelector,
    fullname: string,
    parent: string | null,
    categoriesOf: CategoriesOf,
  ): { allowed: boolean; firstArgs: string[] } {
    let allowed = s.allCommands;
    let firstArgs: string[] = [];
    let cats: string[] | null = null;
    let parentCats: string[] | null = null;
    for (const rule of s.commandRules) {
      const val = rule[0] === '+';
      const body = rule.slice(1);
      if (body[0] === '@') {
        const cat = body.slice(1);
        cats ??= AclCheckService.categoriesNormalised(categoriesOf, fullname);
        if (parent) parentCats ??= AclCheckService.categoriesNormalised(categoriesOf, parent);
        if (cats.includes(cat) || (parentCats !== null && parentCats.includes(cat))) {
          allowed = val;
          firstArgs = [];
        }
      } else if (body === fullname || body === parent) {
        allowed = val;
        firstArgs = [];
      } else if (!parent && val) {
        const bar = body.lastIndexOf('|');
        if (bar > 0 && body.slice(0, bar) === fullname) firstArgs.push(body.slice(bar + 1));
      }
    }
    return { allowed, firstArgs };
  }

  /** The categories of a command or subcommand, lowercase without '@' (a subcommand also has its parent's). */
  static categoriesOfCommand(categoriesOf: CategoriesOf, fullname: string): string[] {
    const bar = fullname.indexOf('|');
    const own = AclCheckService.categoriesNormalised(categoriesOf, fullname);
    return bar > 0 ? [...own, ...AclCheckService.categoriesNormalised(categoriesOf, fullname.slice(0, bar))] : own;
  }

  /** Port of Redis stringmatchlen() (case-sensitive glob: * ? [abc] [^a-z] \x). */
  static globMatch(pattern: string, str: string): boolean {
    const skip = { longer: false };
    return AclCheckService.globImpl(pattern, 0, str, 0, skip, 0);
  }

  /**
   * Whether `u` may run the command: null when some selector allows it, else the denial to report. A missing user is
   * denied the command.
   */
  static check(
    u: AclUser | undefined,
    command: string,
    subcommand: string | null,
    args: string[],
    keys: KeyAccess[],
    options: CheckOptions,
    categoriesOf: CategoriesOf,
  ): AclDenial | null {
    const cmd = command.toLowerCase();
    const fullname = subcommand ? `${cmd}|${subcommand.toLowerCase()}` : cmd;
    if (!u) return { reason: 'command', object: fullname };
    const channels = options.channels ?? AclCheckService.channelsOf(cmd, args);
    const rank = AclCheckService.REASON_RANK;
    let relevant: AclDenial = { reason: 'command', object: fullname };
    let lastIdx = 0;
    for (const s of u.selectors) {
      const res = AclCheckService.checkSelector(
        s,
        cmd,
        subcommand ? fullname : null,
        args,
        keys,
        channels,
        options.noauth === true,
        categoriesOf,
      );
      if (!res) return null;
      const [denial, idx] = res;
      if (rank[denial.reason] > rank[relevant.reason] || (denial.reason === relevant.reason && idx > lastIdx)) {
        relevant = denial;
        lastIdx = idx;
      }
    }
    return relevant;
  }

  /** Whether any selector of the user allows the channel (patterns compared literally when isPattern). */
  static channelAllowed(u: AclUser | undefined, channel: string, isPattern: boolean): boolean {
    if (!u) return false;
    return u.selectors.some((s) => s.allChannels || AclCheckService.channelInList(s.channels, channel, isPattern));
  }

  /** Text of an ACL denial (getAclErrorMessage); verbose = ACL DRYRUN wording that names the key / channel. */
  static denialMessage(denial: AclDenial, form: 'noperm' | 'verbose' | 'script' = 'noperm'): string {
    const texts = {
      command: [AclMessages.DENIED_COMMAND, AclMessages.DENIED_COMMAND_VERBOSE, AclMessages.DENIED_COMMAND_SCRIPT],
      key: [AclMessages.DENIED_KEY, AclMessages.DENIED_KEY_VERBOSE, AclMessages.DENIED_KEY_SCRIPT],
      channel: [AclMessages.DENIED_CHANNEL, AclMessages.DENIED_CHANNEL_VERBOSE, AclMessages.DENIED_CHANNEL_SCRIPT],
    }[denial.reason];
    return formatMessage(texts[form === 'noperm' ? 0 : form === 'verbose' ? 1 : 2], { object: denial.object });
  }

  /** The error a client receives when a command is denied. */
  static noPermError(denial: AclDenial): string {
    return formatMessage(AclMessages.NOPERM, { message: AclCheckService.denialMessage(denial) });
  }

  /** ACL CAT: every category, in Redis's order. */
  static categories(): string[] {
    return [...AclCategoryEnum.options];
  }

  /** ACL CAT <category>: fullnames of commands and subcommands in the category; null for an unknown category. */
  static commandsInCategory(allCommands: string[], categoriesOf: CategoriesOf, category: string): string[] | null {
    const cat = category.toLowerCase();
    if (!AclCategoryEnum.safeParse(cat).success) return null;
    return allCommands.filter((c) => AclCheckService.categoriesNormalised(categoriesOf, c).includes(cat));
  }
}
