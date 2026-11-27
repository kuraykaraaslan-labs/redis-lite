import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { RespMap, RespSet } from '@/libs/resp';
import type { Reply } from '@/libs/resp';
import { firstIssue } from '@/libs/schemas';

import AclCheckService from './acl.check.service';
import AclDescribeService from './acl.describe.service';
import { SetUserDTO } from './acl.dto';
import type { AclLogContext, AclPubsubDefault } from './acl.enums';
import AclLogService from './acl.log.service';
import AclMessages from './acl.messages';
import AclRulesService from './acl.rules.service';
import type { AclSelector, AclUser } from './acl.structure';
import type {
  AclDenial,
  AclGetUser,
  AclLogEntry,
  AclLogInput,
  AclLogState,
  AclOptions,
  AclRuleContext,
  AclSelectorInfo,
  CategoriesOf,
  CheckOptions,
  KeyAccess,
} from './acl.types';

/**
 * The ACL state of one server (clean-room model of Redis 7/8 acl.c behaviour): its users and its ACL LOG. The rule
 * language, the permission checks and the log grouping are stateless services; this class owns the state and passes
 * it to them.
 *
 * Users keep their identity across ACL SETUSER and ACL LOAD (`assign`), so clients can hold the AclUser object.
 * Errors are AppErrors carrying Redis's exact texts.
 */
export class Acl {
  private readonly usersMap = new Map<string, AclUser>();
  private readonly allCommandsProvider: () => string[];
  private readonly categoriesProvider: CategoriesOf;
  private readonly now: () => number;
  private readonly logState: AclLogState = { entries: [] };
  /** acl-pubsub-default (CONFIG SET). */
  pubsubDefault: AclPubsubDefault;
  /** acllog-max-len (CONFIG SET). */
  logMaxLen: number;

  constructor(options: AclOptions) {
    this.allCommandsProvider = options.allCommands;
    this.categoriesProvider = options.categoriesOf;
    this.now = options.now ?? Date.now;
    this.pubsubDefault = options.pubsubDefault ?? 'resetchannels';
    this.logMaxLen = options.logMaxLen ?? 128;
    this.usersMap.set('default', AclRulesService.createDefaultUser(this.ruleContext()));
    if (options.requirepass) this.setRequirePass(options.requirepass);
  }

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** The command table and acl-pubsub-default as they are now. */
  private ruleContext(): AclRuleContext {
    return {
      table: AclRulesService.commandTable(this.allCommandsProvider()),
      allChannels: this.pubsubDefault === 'allchannels',
    };
  }

  /** A selector's command permissions as Redis 7.0 describes them. */
  private readonly describeCommands = (s: AclSelector): string =>
    AclDescribeService.commands(s, this.allCommandsProvider(), this.categoriesProvider);

  private defaultUser(): AclUser {
    const d = this.usersMap.get('default');
    if (!d) throw new Error(AclMessages.DEFAULT_USER_MISSING);
    return d;
  }

  private resolve(user: string | AclUser): AclUser | undefined {
    return typeof user === 'string' ? this.usersMap.get(user) : user;
  }

  // ──────────────────────────────────────────────
  // Users
  // ──────────────────────────────────────────────

  /** The live user object. */
  user(name: string): AclUser | undefined {
    return this.usersMap.get(name);
  }

  /** ACL USERS (sorted). */
  users(): string[] {
    return [...this.usersMap.keys()].sort();
  }

  /** ACL SETUSER: atomic (a refused rule changes nothing). */
  setUser(name: string, rules: string[]): void {
    const parsed = SetUserDTO.safeParse([name, ...rules]);
    if (!parsed.success) throw new AppError(firstIssue(parsed.error));
    const existing = this.usersMap.get(name);
    const ctx = this.ruleContext();
    const temp = existing ? existing.clone() : AclRulesService.newUser(name, ctx);
    AclRulesService.applyRules(temp, parsed.data.rules, ctx);
    if (existing) existing.assign(temp);
    else this.usersMap.set(name, temp);
  }

  /** ACL DELUSER: throws if 'default' is among the names; returns how many existed. */
  deleteUser(names: string[]): number {
    if (names.includes('default')) throw new AppError(AclMessages.DEFAULT_UNDELETABLE);
    let deleted = 0;
    for (const n of names) if (this.usersMap.delete(n)) deleted++;
    return deleted;
  }

  /** ACL GETUSER data, or null. */
  getUser(name: string): AclGetUser | null {
    const u = this.usersMap.get(name);
    if (!u) return null;
    return {
      flags: u.flags(),
      passwords: [...u.passwords],
      ...u.root.info(this.describeCommands(u.root)),
      selectors: u.selectors.slice(1).map((s) => s.info(this.describeCommands(s))),
    };
  }

  /** ACL GETUSER reply: map flags (set), passwords, commands, keys, channels, selectors (array of maps); null when missing. */
  getUserReply(name: string): Reply {
    const g = this.getUser(name);
    if (!g) return null;
    const sel = (s: AclSelectorInfo): RespMap =>
      new RespMap([
        ['commands', s.commands],
        ['keys', s.keys],
        ['channels', s.channels],
      ]);
    return new RespMap([
      ['flags', new RespSet(g.flags)],
      ['passwords', g.passwords],
      ['commands', g.commands],
      ['keys', g.keys],
      ['channels', g.channels],
      ['selectors', g.selectors.map(sel)],
    ]);
  }

  /** One ACL LIST line ('user alice on #… ~k:* resetchannels -@all +get'), or null. */
  describe(name: string): string | null {
    const u = this.usersMap.get(name);
    return u ? `user ${u.name} ${u.describe(this.describeCommands)}` : null;
  }

  /** ACL LIST. */
  list(): string[] {
    return this.users().map((n) => `user ${n} ${this.usersMap.get(n)?.describe(this.describeCommands) ?? ''}`);
  }

  /** True when the user exists, is on, and is nopass or the password matches. */
  authenticate(username: string, password: string): boolean {
    const u = this.usersMap.get(username);
    return u !== undefined && AclRulesService.passwordMatches(u, password);
  }

  /** CONFIG SET requirepass: 'resetpass' then '>pw' or 'nopass' on default. */
  setRequirePass(password: string): void {
    AclRulesService.setRequirePass(this.defaultUser(), password, this.ruleContext());
  }

  /** New connections start authenticated as default iff default is 'on nopass'. */
  defaultLoginAllowed(): boolean {
    const def = this.defaultUser();
    return def.enabled && def.nopass;
  }

  // ──────────────────────────────────────────────
  // Permission checks
  // ──────────────────────────────────────────────

  /**
   * command/subcommand lowercase ('config', 'get'); args = argv without the command name (subcommand is args[0]);
   * keys as resolved from the command's key specs; options.channels overrides the built-in channel extraction;
   * options.noauth = the command has the no_auth flag (its command bit is not checked).
   */
  check(
    user: string | AclUser,
    command: string,
    subcommand: string | null,
    args: string[],
    keys: KeyAccess[] = [],
    options: CheckOptions = {},
  ): AclDenial | null {
    return AclCheckService.check(this.resolve(user), command, subcommand, args, keys, options, this.categoriesProvider);
  }

  /** ACL DRYRUN: null = OK, else the verbose denial text (sent as a bulk string). */
  dryRun(
    username: string,
    command: string,
    subcommand: string | null,
    args: string[],
    keys: KeyAccess[] = [],
    options: CheckOptions = {},
  ): string | null {
    const u = this.usersMap.get(username);
    if (!u) throw new AppError(formatMessage(AclMessages.USER_NOT_FOUND, { name: username }));
    const d = this.check(u, command, subcommand, args, keys, options);
    return d ? AclCheckService.denialMessage(d, 'verbose') : null;
  }

  /** For killing pub/sub clients after SETUSER / LOAD shrink channels. */
  channelAllowed(user: string | AclUser, channel: string, isPattern: boolean): boolean {
    return AclCheckService.channelAllowed(this.resolve(user), channel, isPattern);
  }

  /** ACL CAT. */
  categories(): string[] {
    return AclCheckService.categories();
  }

  /** ACL CAT <category>: fullnames of commands and subcommands in the category. */
  commandsInCategory(category: string): string[] {
    const commands = AclCheckService.commandsInCategory(this.allCommandsProvider(), this.categoriesProvider, category);
    if (commands === null) throw new AppError(formatMessage(AclMessages.UNKNOWN_CATEGORY, { name: category.slice(0, 128) }));
    return commands;
  }

  // ──────────────────────────────────────────────
  // ACL LOG
  // ──────────────────────────────────────────────

  /** Grouping: same reason/context/object/username within 60 s. */
  log(input: AclLogInput): void {
    AclLogService.record(this.logState, input, this.now(), this.logMaxLen);
  }

  /** Shortcut from a check() result. */
  logDenial(denial: AclDenial, username: string, context: AclLogContext, clientInfo: string): void {
    this.log({ reason: denial.reason, context, object: denial.object, username, clientInfo });
  }

  /** Newest first. */
  logEntries(count = 10): AclLogEntry[] {
    return AclLogService.entries(this.logState, count, this.now());
  }

  /** ACL LOG [count] reply. */
  logReply(count = 10): Reply {
    return AclLogService.reply(this.logEntries(count));
  }

  resetLog(): void {
    AclLogService.reset(this.logState);
  }

  // ──────────────────────────────────────────────
  // ACL file
  // ──────────────────────────────────────────────

  /** users.acl text ('user <name> <rules>\n' per user, sorted). */
  toFile(): string {
    return this.list().map((l) => `${l}\n`).join('');
  }

  /**
   * Validates everything, then replaces all users; returns the names whose definition changed or that were removed
   * (disconnect their clients). Throws AppError('ERR <file>:<line>: … ') leaving the users untouched.
   */
  loadFile(text: string, filename = 'users.acl'): string[] {
    const fresh = AclRulesService.parseFile(text, filename, this.ruleContext());
    const changed: string[] = [];
    for (const [name, old] of this.usersMap) {
      const next = fresh.get(name);
      if (!next) {
        changed.push(name);
        this.usersMap.delete(name);
      } else if (old.describe() !== next.describe()) {
        changed.push(name);
      }
    }
    for (const [name, next] of fresh) {
      const old = this.usersMap.get(name);
      if (old) old.assign(next);
      else this.usersMap.set(name, next);
    }
    return changed.sort();
  }
}
