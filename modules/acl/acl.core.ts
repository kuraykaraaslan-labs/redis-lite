/**
 * Redis ACL engine (clean-room model of Redis 7/8 acl.c behaviour): users, selectors, the ACL SETUSER rule language,
 * permission checks, ACL LOG, the users.acl file format, GENPASS and CAT helpers.
 *
 * Public API
 * ----------
 * new Acl(options: AclOptions)
 *   options.allCommands(): string[]              every command name, lowercase, INCLUDING subcommand fullnames ('config|get').
 *                                                A name is a container when some other name starts with '<name>|'.
 *   options.categoriesOf(fullname): string[]     ACL categories of a command / subcommand fullname, e.g. ['@read', '@fast'].
 *   options.requirepass?: string                 default user gets that password instead of nopass ('' = nopass).
 *   options.pubsubDefault?: 'resetchannels' | 'allchannels'   acl-pubsub-default (Redis 7+ default: resetchannels).
 *   options.logMaxLen?: number                   acllog-max-len (default 128).
 *   options.now?: () => number                   clock in ms (tests).
 *
 * Users
 *   acl.setUser(name, rules)            ACL SETUSER: atomic, throws CommandError with Redis's exact error text.
 *   acl.deleteUser(names): number       ACL DELUSER: throws if 'default' is among names; returns how many existed.
 *   acl.user(name): AclUser | undefined the live user object (identity is kept across SETUSER, so clients can hold it).
 *   acl.getUser(name): AclGetUser | null       ACL GETUSER data;  acl.getUserReply(name): Reply (RESP map / null).
 *   acl.describe(name): string | null    one ACL LIST line ('user alice on #… ~k:* resetchannels -@all +get').
 *   acl.list(): string[]                 ACL LIST;  acl.users(): string[]  ACL USERS (sorted).
 *   acl.authenticate(user, password)     true when the user exists, is on, and is nopass or the password matches.
 *   acl.setRequirePass(password | '')    CONFIG SET requirepass: 'resetpass' then '>pw' or 'nopass' on default.
 *   acl.defaultLoginAllowed()            new connections start authenticated as default iff default is 'on nopass'.
 *
 * Permission checks
 *   acl.check(user, command, subcommand, args, keys?, options?) → AclDenial | null
 *     command/subcommand lowercase ('config', 'get'); args = argv without the command name (subcommand is args[0]);
 *     keys = [{ key, read, write }] as resolved from the command's key specs (RW/OW/RM/… → read/write flags);
 *     options.channels overrides the built-in channel extraction (PUBLISH/SPUBLISH/SUBSCRIBE/SSUBSCRIBE/PSUBSCRIBE);
 *     options.noauth = command has the no_auth flag (AUTH, HELLO, …): the command bit is not checked.
 *   acl.channelAllowed(user, channel, isPattern)   for killing pub/sub clients after SETUSER / LOAD shrink channels.
 *   aclDenialMessage(denial, username, verbose)   'User u has no permissions to run the 'get' command' / 'No permissions to access a key' …
 *   noPermError(denial, username)                 the NOPERM error text sent to clients.
 *   acl.dryRun(user, command, subcommand, args, keys?, options?) → null (OK) | verbose message (bulk reply); throws if no user.
 *
 * ACL LOG
 *   acl.log({ reason, context, object, username, clientInfo })   grouping: same reason/context/object/username within 60 s.
 *   acl.logDenial(denial, username, context, clientInfo)        shortcut from a check() result.
 *   acl.logEntries(count = 10): AclLogEntry[]   newest first;  acl.logReply(count): Reply;  acl.resetLog();  acl.logMaxLen.
 *
 * File / misc
 *   acl.toFile(): string                        users.acl text ('user <name> <rules>\n' per user, sorted).
 *   acl.loadFile(text, filename?): string[]     validates everything, then replaces all users; returns the names whose
 *                                               definition changed or that were removed (disconnect their clients);
 *                                               throws CommandError('ERR <file>:<line>: … ') leaving the users untouched.
 *   genPass(bits?): string                      ACL GENPASS.
 *   ACL_CATEGORIES, acl.categories(), acl.commandsInCategory(cat) (throws 'ERR Unknown category …').
 *   hashPassword(pw): string                    sha256 hex of the (latin1 binary) password.
 */
import { createHash, randomBytes } from 'node:crypto';

import { CommandError } from '@/libs/app-error';
import type { Reply } from '@/libs/resp';
import { RespDouble, RespMap, RespSet } from '@/libs/resp';
import { parseInteger } from '@/libs/number';

/** ACL categories in the order Redis lists them (ACL CAT). */
export const ACL_CATEGORIES: readonly string[] = [
  'keyspace', 'read', 'write', 'set', 'sortedset', 'list', 'hash', 'string', 'bitmap', 'hyperloglog', 'geo', 'stream',
  'pubsub', 'admin', 'fast', 'slow', 'blocking', 'dangerous', 'connection', 'transaction', 'scripting',
];
const CATEGORY_SET = new Set(ACL_CATEGORIES);

export type AclDenyReason = 'command' | 'key' | 'channel';
export type AclLogReason = AclDenyReason | 'auth';
export type AclLogContext = 'toplevel' | 'multi' | 'lua' | 'module';

export interface KeyAccess {
  key: string;
  read: boolean;
  write: boolean;
}

export interface ChannelAccess {
  channel: string;
  /** PSUBSCRIBE patterns are matched literally against the allowed patterns. */
  pattern: boolean;
}

export interface AclDenial {
  reason: AclDenyReason;
  /** Command fullname ('config|get'), key name or channel name. */
  object: string;
}

export interface CheckOptions {
  /** Channels touched (publish / subscribe only); default: derived from the command name and args. */
  channels?: ChannelAccess[];
  /** The command has the no_auth flag: the command permission is not checked. */
  noauth?: boolean;
}

export interface KeyPattern {
  pattern: string;
  read: boolean;
  write: boolean;
}

export interface AclSelectorInfo {
  commands: string;
  keys: string;
  channels: string;
}

export interface AclGetUser extends AclSelectorInfo {
  flags: string[];
  passwords: string[];
  selectors: AclSelectorInfo[];
}

export interface AclLogInput {
  reason: AclLogReason;
  context: AclLogContext;
  object: string;
  username: string;
  /** CLIENT LIST line of the offending client. */
  clientInfo: string;
}

export interface AclLogEntry {
  count: number;
  reason: AclLogReason;
  context: AclLogContext;
  object: string;
  username: string;
  ageSeconds: number;
  clientInfo: string;
  entryId: number;
  timestampCreated: number;
  timestampLastUpdated: number;
}

export interface AclOptions {
  allCommands: () => string[];
  categoriesOf: (command: string) => string[];
  requirepass?: string;
  pubsubDefault?: 'resetchannels' | 'allchannels';
  logMaxLen?: number;
  now?: () => number;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Error texts                                                                                                         */

type RuleErrorCode = 'ENOENT' | 'EINVAL' | 'EEXIST' | 'EISDIR' | 'ENODEV' | 'EBADMSG' | 'ECHILD';

/** ACLSetUserStringError() texts. */
export const ACL_RULE_ERRORS: Readonly<Record<RuleErrorCode, string>> = {
  ENOENT: 'Unknown command or category name in ACL',
  EINVAL: 'Syntax error',
  EEXIST:
    "Adding a pattern after the * pattern (or the 'allkeys' flag) is not valid and does not have any effect. " +
    "Try 'resetkeys' to start with an empty list of patterns",
  EISDIR:
    "Adding a pattern after the * pattern (or the 'allchannels' flag) is not valid and does not have any effect. " +
    "Try 'resetchannels' to start with an empty list of channels",
  ENODEV: 'The password you are trying to remove from the user does not exist',
  EBADMSG: 'The password hash must be exactly 64 characters and contain only lowercase hexadecimal characters',
  ECHILD: 'Allowing first-arg of a subcommand is not supported',
};

class RuleError extends Error {
  constructor(readonly code: RuleErrorCode) {
    super(ACL_RULE_ERRORS[code]);
  }
}

export const ACL_MESSAGES = {
  USERNAME_SPACES: "ERR Usernames can't contain spaces or null characters",
  DEFAULT_UNDELETABLE: "ERR The 'default' user cannot be removed",
  GENPASS_RANGE:
    'ERR ACL GENPASS argument must be the number of bits for the output password, a positive number up to 4096',
  userNotFound: (name: string): string => `ERR User '${name}' not found`,
  commandNotFound: (name: string): string => `ERR Command '${name}' not found`,
  unknownCategory: (name: string): string => `ERR Unknown category '${name.slice(0, 128)}'`,
  unmatchedParen: (arg: string): string => `ERR Unmatched parenthesis in acl selector starting at '${arg}'.`,
} as const;

/** Text of an ACL denial (getAclErrorMessage); verbose = ACL DRYRUN wording that names the key / channel. */
export function aclDenialMessage(denial: AclDenial, username: string, verbose = false): string {
  switch (denial.reason) {
    case 'command':
      return `User ${username} has no permissions to run the '${denial.object}' command`;
    case 'key':
      return verbose ? `No permissions to access the '${denial.object}' key` : 'No permissions to access a key';
    case 'channel':
      return verbose ? `No permissions to access the '${denial.object}' channel` : 'No permissions to access a channel';
  }
}

/** The error a client receives when a command is denied. */
export function noPermError(denial: AclDenial, username: string): string {
  return `NOPERM ${aclDenialMessage(denial, username)}`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Helpers                                                                                                             */

/** sha256 hex of a binary (latin1) string, as stored by '>password'. */
export function hashPassword(password: string): string {
  return createHash('sha256').update(Buffer.from(password, 'latin1')).digest('hex');
}

/** ACL GENPASS [bits]. */
export function genPass(bits?: string | number): string {
  const n = typeof bits === 'string' ? parseInteger(bits) : (bits ?? 256);
  if (n <= 0 || n > 4096) throw new CommandError(ACL_MESSAGES.GENPASS_RANGE);
  const chars = Math.floor((n + 3) / 4);
  return randomBytes(Math.ceil(chars / 2)).toString('hex').slice(0, chars);
}

const isSpaceChar = (c: string): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';

/** ACLStringHasSpaces(): whitespace or NUL. */
function hasSpaces(s: string): boolean {
  for (const c of s) if (isSpaceChar(c) || c === '\0') return true;
  return false;
}

function isValidHash(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/** Port of Redis stringmatchlen() (case-sensitive glob: * ? [abc] [^a-z] \x). */
export function aclGlobMatch(pattern: string, str: string): boolean {
  const skip = { longer: false };
  return globImpl(pattern, 0, str, 0, skip, 0);
}

function globImpl(pat: string, p: number, str: string, s: number, skip: { longer: boolean }, nesting: number): boolean {
  if (nesting > 1000) return false;
  const pEnd = pat.length;
  const sEnd = str.length;
  while (p < pEnd && s < sEnd) {
    const c = pat[p];
    if (c === '*') {
      while (p + 1 < pEnd && pat[p + 1] === '*') p++;
      if (p + 1 === pEnd) return true;
      while (s < sEnd) {
        if (globImpl(pat, p + 1, str, s, skip, nesting + 1)) return true;
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

/** sdssplitargs(): whitespace-separated args with "double" (escapes) and 'single' quotes; null on unbalanced quotes. */
function splitArgs(line: string): string[] | null {
  const out: string[] = [];
  let p = 0;
  const n = line.length;
  const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c);
  for (;;) {
    while (p < n && isSpaceChar(line[p])) p++;
    if (p >= n) return out;
    let inq = false;
    let insq = false;
    let cur = '';
    for (;;) {
      if (inq) {
        if (p >= n) return null;
        if (line[p] === '\\' && line[p + 1] === 'x' && isHex(line[p + 2]) && isHex(line[p + 3])) {
          cur += String.fromCharCode(parseInt(line.slice(p + 2, p + 4), 16));
          p += 4;
        } else if (line[p] === '\\' && p + 1 < n) {
          const e = line[p + 1];
          cur += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e === 'b' ? '\b' : e === 'a' ? '\x07' : e;
          p += 2;
        } else if (line[p] === '"') {
          if (p + 1 < n && !isSpaceChar(line[p + 1])) return null;
          p++;
          break;
        } else {
          cur += line[p++];
        }
      } else if (insq) {
        if (p >= n) return null;
        if (line[p] === '\\' && line[p + 1] === "'") {
          cur += "'";
          p += 2;
        } else if (line[p] === "'") {
          if (p + 1 < n && !isSpaceChar(line[p + 1])) return null;
          p++;
          break;
        } else {
          cur += line[p++];
        }
      } else {
        if (p >= n) break;
        const c = line[p];
        if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\0') {
          p++;
          break;
        }
        if (c === '"') inq = true;
        else if (c === "'") insq = true;
        else cur += c;
        p++;
      }
    }
    out.push(cur);
  }
}

/** ACLMergeSelectorArguments(): joins '(a' 'b' 'c)' into '(a b c)'. Returns the index of an unclosed '(' as a number. */
function mergeSelectorArgs(args: string[]): string[] | number {
  const out: string[] = [];
  let openAt = -1;
  let selector = '';
  for (let j = 0; j < args.length; j++) {
    const op = args[j];
    if (openAt === -1 && op.startsWith('(') && !op.endsWith(')')) {
      selector = op;
      openAt = j;
      continue;
    }
    if (openAt !== -1) {
      selector += ` ${op}`;
      if (op.endsWith(')')) {
        openAt = -1;
        out.push(selector);
      }
      continue;
    }
    out.push(op);
  }
  return openAt !== -1 ? openAt : out;
}

/** Built-in channel extraction (getChannelsFromCommand): only publish/subscribe channels are ACL-checked. */
function channelsOf(command: string, args: string[]): ChannelAccess[] {
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

/* ------------------------------------------------------------------------------------------------------------------ */
/* Selector / user                                                                                                     */

/** One permission set: the root selector of a user, or a '(…)' selector. */
export class AclSelector {
  /** The reserved "+@all" bit: commands added in the future are allowed; describes as '+@all …' instead of '-@all …'. */
  allCommands = false;
  /** Normalised command rules applied on top of the +@all / -@all base, in order ('+get', '-@read', '+config|get'). */
  commandRules: string[] = [];
  allKeys = false;
  keyPatterns: KeyPattern[] = [];
  allChannels = false;
  channels: string[] = [];

  constructor(
    readonly root: boolean,
    allChannels = false,
  ) {
    this.allChannels = allChannels;
  }

  clone(): AclSelector {
    const s = new AclSelector(this.root, this.allChannels);
    s.allCommands = this.allCommands;
    s.commandRules = [...this.commandRules];
    s.allKeys = this.allKeys;
    s.keyPatterns = this.keyPatterns.map((k) => ({ ...k }));
    s.channels = [...this.channels];
    return s;
  }

  /** ACLDescribeSelectorCommandRules(). */
  describeCommands(): string {
    return [this.allCommands ? '+@all' : '-@all', ...this.commandRules].join(' ');
  }

  /** GETUSER 'keys'. */
  describeKeys(): string {
    return this.allKeys ? '~*' : this.keyPatterns.map(patternString).join(' ');
  }

  /** GETUSER 'channels'. */
  describeChannels(): string {
    return this.allChannels ? '&*' : this.channels.map((c) => `&${c}`).join(' ');
  }

  /** ACLDescribeSelector(): keys, channels, commands. */
  describe(): string {
    let res = '';
    if (this.allKeys) res += '~* ';
    else for (const k of this.keyPatterns) res += `${patternString(k)} `;
    if (this.allChannels) res += '&* ';
    else {
      res += 'resetchannels ';
      for (const c of this.channels) res += `&${c} `;
    }
    return res + this.describeCommands();
  }

  info(): AclSelectorInfo {
    return { commands: this.describeCommands(), keys: this.describeKeys(), channels: this.describeChannels() };
  }
}

function patternString(k: KeyPattern): string {
  const prefix = k.read && k.write ? '~' : k.read ? '%R~' : '%W~';
  return prefix + k.pattern;
}

export class AclUser {
  enabled = false;
  nopass = false;
  skipSanitizePayload = false;
  /** sha256 hex hashes, in insertion order. */
  passwords: string[] = [];
  /** selectors[0] is the root selector. */
  selectors: AclSelector[];

  constructor(
    readonly name: string,
    allChannels = false,
  ) {
    this.selectors = [new AclSelector(true, allChannels)];
  }

  get root(): AclSelector {
    return this.selectors[0];
  }

  clone(): AclUser {
    const u = new AclUser(this.name);
    u.assign(this);
    return u;
  }

  /** Copies every setting of `other` into this object (ACLCopyUser), keeping identity. */
  assign(other: AclUser): void {
    this.enabled = other.enabled;
    this.nopass = other.nopass;
    this.skipSanitizePayload = other.skipSanitizePayload;
    this.passwords = [...other.passwords];
    this.selectors = other.selectors.map((s) => s.clone());
  }

  /** Flags in ACLUserFlags order. */
  flags(): string[] {
    const f = [this.enabled ? 'on' : 'off'];
    if (this.nopass) f.push('nopass');
    f.push(this.skipSanitizePayload ? 'skip-sanitize-payload' : 'sanitize-payload');
    return f;
  }

  /** ACLDescribeUser() (the rules part of an ACL LIST line). */
  describe(): string {
    let res = '';
    for (const f of this.flags()) res += `${f} `;
    for (const p of this.passwords) res += `#${p} `;
    for (const s of this.selectors) res += s.root ? s.describe() : ` (${s.describe()})`;
    return res;
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Acl                                                                                                                 */

interface CommandTable {
  names: Set<string>;
  containers: Set<string>;
}

interface StoredLogEntry {
  count: number;
  reason: AclLogReason;
  context: AclLogContext;
  object: string;
  username: string;
  clientInfo: string;
  entryId: number;
  timestampCreated: number;
  /** Last update (ctime in Redis). */
  ctime: number;
}

const LOG_GROUPING_MS = 60_000;

export class Acl {
  private readonly usersMap = new Map<string, AclUser>();
  private readonly allCommandsProvider: () => string[];
  private readonly categoriesProvider: (command: string) => string[];
  private readonly now: () => number;
  pubsubDefault: 'resetchannels' | 'allchannels';
  logMaxLen: number;
  private logList: StoredLogEntry[] = [];
  private logEntryCount = 0;

  constructor(options: AclOptions) {
    this.allCommandsProvider = options.allCommands;
    this.categoriesProvider = options.categoriesOf;
    this.now = options.now ?? Date.now;
    this.pubsubDefault = options.pubsubDefault ?? 'resetchannels';
    this.logMaxLen = options.logMaxLen ?? 128;
    const def = this.createDefaultUser();
    this.usersMap.set('default', def);
    if (options.requirepass) this.setRequirePass(options.requirepass);
  }

  /* ---- users ---- */

  user(name: string): AclUser | undefined {
    return this.usersMap.get(name);
  }

  users(): string[] {
    return [...this.usersMap.keys()].sort();
  }

  setUser(name: string, rules: string[]): void {
    if (hasSpaces(name)) throw new CommandError(ACL_MESSAGES.USERNAME_SPACES);
    const merged = mergeSelectorArgs(rules);
    if (typeof merged === 'number') throw new CommandError(ACL_MESSAGES.unmatchedParen(rules[merged]));
    const existing = this.usersMap.get(name);
    const temp = existing ? existing.clone() : this.newUser(name);
    const table = this.commandTable();
    for (const op of merged) {
      try {
        this.applyUserRule(temp, op, table);
      } catch (e) {
        if (e instanceof RuleError) throw new CommandError(`ERR Error in ACL SETUSER modifier '${op}': ${e.message}`);
        throw e;
      }
    }
    if (existing) existing.assign(temp);
    else this.usersMap.set(name, temp);
  }

  deleteUser(names: string[]): number {
    if (names.includes('default')) throw new CommandError(ACL_MESSAGES.DEFAULT_UNDELETABLE);
    let deleted = 0;
    for (const n of names) if (this.usersMap.delete(n)) deleted++;
    return deleted;
  }

  getUser(name: string): AclGetUser | null {
    const u = this.usersMap.get(name);
    if (!u) return null;
    return {
      flags: u.flags(),
      passwords: [...u.passwords],
      ...u.root.info(),
      selectors: u.selectors.slice(1).map((s) => s.info()),
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

  describe(name: string): string | null {
    const u = this.usersMap.get(name);
    return u ? `user ${u.name} ${u.describe()}` : null;
  }

  list(): string[] {
    return this.users().map((n) => `user ${n} ${this.usersMap.get(n)?.describe() ?? ''}`);
  }

  authenticate(username: string, password: string): boolean {
    const u = this.usersMap.get(username);
    if (!u || !u.enabled) return false;
    if (u.nopass) return true;
    const h = hashPassword(password);
    return u.passwords.includes(h);
  }

  /** ACLUpdateDefaultUserPassword(). */
  setRequirePass(password: string): void {
    const def = this.defaultUser();
    const table = this.commandTable();
    this.applyUserRule(def, 'resetpass', table);
    this.applyUserRule(def, password ? `>${password}` : 'nopass', table);
  }

  defaultLoginAllowed(): boolean {
    const def = this.defaultUser();
    return def.enabled && def.nopass;
  }

  /* ---- permission checks ---- */

  check(
    user: string | AclUser,
    command: string,
    subcommand: string | null,
    args: string[],
    keys: KeyAccess[] = [],
    options: CheckOptions = {},
  ): AclDenial | null {
    const u = typeof user === 'string' ? this.usersMap.get(user) : user;
    const cmd = command.toLowerCase();
    const fullname = subcommand ? `${cmd}|${subcommand.toLowerCase()}` : cmd;
    if (!u) return { reason: 'command', object: fullname };
    const channels = options.channels ?? channelsOf(cmd, args);
    const rank: Record<AclDenyReason, number> = { command: 1, key: 2, channel: 4 };
    let relevant: AclDenial = { reason: 'command', object: fullname };
    let lastIdx = 0;
    for (const s of u.selectors) {
      const res = this.checkSelector(s, cmd, subcommand ? fullname : null, args, keys, channels, options.noauth === true);
      if (!res) return null;
      const [denial, idx] = res;
      if (rank[denial.reason] > rank[relevant.reason] || (denial.reason === relevant.reason && idx > lastIdx)) {
        relevant = denial;
        lastIdx = idx;
      }
    }
    return relevant;
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
    if (!u) throw new CommandError(ACL_MESSAGES.userNotFound(username));
    const d = this.check(u, command, subcommand, args, keys, options);
    return d ? aclDenialMessage(d, u.name, true) : null;
  }

  /** Whether any selector of the user allows the channel (patterns compared literally when isPattern). */
  channelAllowed(user: string | AclUser, channel: string, isPattern: boolean): boolean {
    const u = typeof user === 'string' ? this.usersMap.get(user) : user;
    if (!u) return false;
    return u.selectors.some((s) => s.allChannels || channelInList(s.channels, channel, isPattern));
  }

  private checkSelector(
    s: AclSelector,
    command: string,
    subFullname: string | null,
    args: string[],
    keys: KeyAccess[],
    channels: ChannelAccess[],
    noauth: boolean,
  ): [AclDenial, number] | null {
    const fullname = subFullname ?? command;
    if (!noauth && !this.commandAllowed(s, fullname, subFullname ? command : null, args)) {
      return [{ reason: 'command', object: fullname }, 0];
    }
    if (!s.allKeys) {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const ok = s.keyPatterns.some(
          (p) => (!k.read || p.read) && (!k.write || p.write) && aclGlobMatch(p.pattern, k.key),
        );
        if (!ok) return [{ reason: 'key', object: k.key }, i + 1];
      }
    }
    if (!s.allChannels) {
      for (let i = 0; i < channels.length; i++) {
        const c = channels[i];
        if (!channelInList(s.channels, c.channel, c.pattern)) return [{ reason: 'channel', object: c.channel }, i + 1];
      }
    }
    return null;
  }

  /** Replays the selector's command rules for one command (equivalent to Redis's command bitmap + first-args). */
  private commandAllowed(s: AclSelector, fullname: string, parent: string | null, args: string[]): boolean {
    let allowed = s.allCommands;
    let firstArgs: string[] = [];
    let cats: string[] | null = null;
    let parentCats: string[] | null = null;
    for (const rule of s.commandRules) {
      const val = rule[0] === '+';
      const body = rule.slice(1);
      if (body[0] === '@') {
        const cat = body.slice(1);
        cats ??= this.categoriesNormalised(fullname);
        if (parent) parentCats ??= this.categoriesNormalised(parent);
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
    if (allowed) return true;
    if (parent || firstArgs.length === 0 || args.length < 1) return false;
    const first = args[0].toLowerCase();
    return firstArgs.includes(first);
  }

  private categoriesNormalised(command: string): string[] {
    return this.categoriesProvider(command).map((c) => (c.startsWith('@') ? c.slice(1) : c).toLowerCase());
  }

  /* ---- categories ---- */

  categories(): string[] {
    return [...ACL_CATEGORIES];
  }

  /** ACL CAT <category>: fullnames of commands and subcommands in the category. */
  commandsInCategory(category: string): string[] {
    const cat = category.toLowerCase();
    if (!CATEGORY_SET.has(cat)) throw new CommandError(ACL_MESSAGES.unknownCategory(category));
    return this.allCommandsProvider().filter((c) => this.categoriesNormalised(c).includes(cat));
  }

  /* ---- ACL LOG ---- */

  log(input: AclLogInput): void {
    const now = this.now();
    for (let i = 0; i < Math.min(10, this.logList.length); i++) {
      const e = this.logList[i];
      if (
        e.reason === input.reason &&
        e.context === input.context &&
        Math.abs(e.ctime - now) <= LOG_GROUPING_MS &&
        e.object === input.object &&
        e.username === input.username
      ) {
        this.logList.splice(i, 1);
        this.logList.unshift(e);
        e.clientInfo = input.clientInfo;
        e.ctime = now;
        e.count++;
        return;
      }
    }
    this.logList.unshift({
      count: 1,
      reason: input.reason,
      context: input.context,
      object: input.object,
      username: input.username,
      clientInfo: input.clientInfo,
      entryId: this.logEntryCount++,
      timestampCreated: now,
      ctime: now,
    });
    while (this.logList.length > this.logMaxLen) this.logList.pop();
  }

  logDenial(denial: AclDenial, username: string, context: AclLogContext, clientInfo: string): void {
    this.log({ reason: denial.reason, context, object: denial.object, username, clientInfo });
  }

  logEntries(count = 10): AclLogEntry[] {
    const now = this.now();
    return this.logList.slice(0, Math.max(0, count)).map((e) => ({
      count: e.count,
      reason: e.reason,
      context: e.context,
      object: e.object,
      username: e.username,
      ageSeconds: (now - e.ctime) / 1000,
      clientInfo: e.clientInfo,
      entryId: e.entryId,
      timestampCreated: e.timestampCreated,
      timestampLastUpdated: e.ctime,
    }));
  }

  /** ACL LOG [count] reply: array of 10-field maps. */
  logReply(count = 10): Reply {
    return this.logEntries(count).map(
      (e) =>
        new RespMap([
          ['count', e.count],
          ['reason', e.reason],
          ['context', e.context],
          ['object', e.object],
          ['username', e.username],
          ['age-seconds', new RespDouble(e.ageSeconds)],
          ['client-info', e.clientInfo],
          ['entry-id', e.entryId],
          ['timestamp-created', e.timestampCreated],
          ['timestamp-last-updated', e.timestampLastUpdated],
        ]),
    );
  }

  resetLog(): void {
    this.logList = [];
  }

  /* ---- ACL file ---- */

  toFile(): string {
    return this.list().map((l) => `${l}\n`).join('');
  }

  loadFile(text: string, filename = 'users.acl'): string[] {
    const table = this.commandTable();
    const fresh = new Map<string, AclUser>();
    let errors = '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const linenum = i + 1;
      const line = trimChars(lines[i], ' \t\r\n');
      if (line === '') continue;
      const argv = line.split(' ');
      if (argv[0] !== 'user' || argv.length < 2) {
        errors += `${filename}:${linenum} should start with user keyword. `;
        continue;
      }
      const name = argv[1];
      if (hasSpaces(name)) {
        errors += `'${filename}:${linenum}: username '${name}' contains invalid characters. `;
        continue;
      }
      if (fresh.has(name)) {
        errors += `WARNING: Duplicate user '${name}' found on line ${linenum}. `;
        continue;
      }
      const u = this.newUser(name);
      fresh.set(name, u);
      const merged = mergeSelectorArgs(argv.slice(2));
      if (typeof merged === 'number') {
        errors += `${filename}:${linenum}: Unmatched parenthesis in selector definition.`;
        continue;
      }
      let syntaxError = false;
      for (const raw of merged) {
        const op = trimChars(raw, '\t\r\n');
        try {
          this.applyUserRule(u, op, table);
        } catch (e) {
          if (!(e instanceof RuleError)) throw e;
          if (e.code === 'ENOENT') {
            errors += `${filename}:${linenum}: Error in applying operation '${op}': ${e.message}. `;
          } else if (!syntaxError) {
            errors += `${filename}:${linenum}: ${e.message}. `;
            syntaxError = true;
          }
        }
      }
    }
    if (errors) throw new CommandError(`ERR ${errors}`);
    if (!fresh.has('default')) fresh.set('default', this.createDefaultUser());

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

  /* ---- rule language ---- */

  private defaultUser(): AclUser {
    const d = this.usersMap.get('default');
    if (!d) throw new Error('ACL: default user missing');
    return d;
  }

  /** ACLCreateUser(): off, sanitize-payload, no keys, channels per acl-pubsub-default, -@all. */
  private newUser(name: string): AclUser {
    return new AclUser(name, this.pubsubDefault === 'allchannels');
  }

  /** ACLCreateDefaultUser(): +@all ~* &* on nopass. */
  private createDefaultUser(): AclUser {
    const u = this.newUser('default');
    const table = this.commandTable();
    for (const op of ['+@all', '~*', '&*', 'on', 'nopass']) this.applyUserRule(u, op, table);
    return u;
  }

  private commandTable(): CommandTable {
    const names = new Set<string>();
    const containers = new Set<string>();
    for (const raw of this.allCommandsProvider()) {
      const n = raw.toLowerCase();
      names.add(n);
      const bar = n.indexOf('|');
      if (bar > 0) containers.add(n.slice(0, bar));
    }
    return { names, containers };
  }

  /** ACLSetUser(). */
  private applyUserRule(u: AclUser, op: string, table: CommandTable): void {
    if (op === '') return;
    const lower = op.toLowerCase();
    if (lower === 'on') {
      u.enabled = true;
    } else if (lower === 'off') {
      u.enabled = false;
    } else if (lower === 'skip-sanitize-payload') {
      u.skipSanitizePayload = true;
    } else if (lower === 'sanitize-payload') {
      u.skipSanitizePayload = false;
    } else if (lower === 'nopass') {
      u.nopass = true;
      u.passwords = [];
    } else if (lower === 'resetpass') {
      u.nopass = false;
      u.passwords = [];
    } else if (op[0] === '>' || op[0] === '#') {
      let hash: string;
      if (op[0] === '>') {
        hash = hashPassword(op.slice(1));
      } else {
        hash = op.slice(1);
        if (!isValidHash(hash)) throw new RuleError('EBADMSG');
      }
      if (!u.passwords.includes(hash)) u.passwords.push(hash);
      u.nopass = false;
    } else if (op[0] === '<' || op[0] === '!') {
      let hash: string;
      if (op[0] === '<') {
        hash = hashPassword(op.slice(1));
      } else {
        hash = op.slice(1);
        if (!isValidHash(hash)) throw new RuleError('EBADMSG');
      }
      const idx = u.passwords.indexOf(hash);
      if (idx < 0) throw new RuleError('ENODEV');
      u.passwords.splice(idx, 1);
    } else if (op[0] === '(' && op[op.length - 1] === ')' && op.length >= 2) {
      const sel = new AclSelector(false, this.pubsubDefault === 'allchannels');
      for (const a of splitArgs(op.slice(1, -1)) ?? []) this.applySelectorRule(sel, a, table);
      u.selectors.push(sel);
    } else if (lower === 'clearselectors') {
      u.selectors = [u.root];
    } else if (lower === 'reset') {
      for (const r of ['resetpass', 'resetkeys', 'resetchannels']) this.applyUserRule(u, r, table);
      if (this.pubsubDefault === 'allchannels') this.applyUserRule(u, 'allchannels', table);
      for (const r of ['off', 'sanitize-payload', 'clearselectors', '-@all']) this.applyUserRule(u, r, table);
    } else {
      this.applySelectorRule(u.root, op, table);
    }
  }

  /** ACLSetSelector(). */
  private applySelectorRule(s: AclSelector, op: string, table: CommandTable): void {
    const lower = op.toLowerCase();
    if (lower === 'allkeys' || op === '~*') {
      s.allKeys = true;
      s.keyPatterns = [];
    } else if (lower === 'resetkeys') {
      s.allKeys = false;
      s.keyPatterns = [];
    } else if (lower === 'allchannels' || op === '&*') {
      s.allChannels = true;
      s.channels = [];
    } else if (lower === 'resetchannels') {
      s.allChannels = false;
      s.channels = [];
    } else if (lower === 'allcommands' || lower === '+@all') {
      s.allCommands = true;
      s.commandRules = [];
    } else if (lower === 'nocommands' || lower === '-@all') {
      s.allCommands = false;
      s.commandRules = [];
    } else if (op[0] === '~' || op[0] === '%') {
      this.addKeyPattern(s, op);
    } else if (op[0] === '&') {
      if (s.allChannels) throw new RuleError('EISDIR');
      const pat = op.slice(1);
      if (hasSpaces(pat)) throw new RuleError('EINVAL');
      if (!s.channels.includes(pat)) s.channels.push(pat);
    } else if (op[0] === '+' && op[1] !== '@') {
      const body = op.slice(1).toLowerCase();
      const bar = body.lastIndexOf('|');
      if (bar < 0) {
        if (!table.names.has(body)) throw new RuleError('ENOENT');
        updateCommandRules(s, body, true);
      } else {
        const cmd = body.slice(0, bar);
        const sub = body.slice(bar + 1);
        if (!table.names.has(cmd)) throw new RuleError('ENOENT');
        if (cmd.includes('|')) throw new RuleError('ECHILD');
        if (sub === '') throw new RuleError('EINVAL');
        if (table.containers.has(cmd) && !table.names.has(body)) throw new RuleError('ENOENT');
        updateCommandRules(s, body, true);
      }
    } else if (op[0] === '-' && op[1] !== '@') {
      const body = op.slice(1).toLowerCase();
      if (!table.names.has(body)) throw new RuleError('ENOENT');
      updateCommandRules(s, body, false);
    } else if ((op[0] === '+' || op[0] === '-') && op[1] === '@') {
      const cat = op.slice(2).toLowerCase();
      if (!CATEGORY_SET.has(cat)) throw new RuleError('ENOENT');
      updateCommandRules(s, `@${cat}`, op[0] === '+');
    } else {
      throw new RuleError('EINVAL');
    }
  }

  private addKeyPattern(s: AclSelector, op: string): void {
    if (s.allKeys) throw new RuleError('EEXIST');
    let read = false;
    let write = false;
    let offset = 1;
    if (op[0] === '%') {
      for (; offset < op.length; offset++) {
        const c = op[offset];
        if (c.toUpperCase() === 'R' && !read) read = true;
        else if (c.toUpperCase() === 'W' && !write) write = true;
        else if (c === '~') {
          offset++;
          break;
        } else throw new RuleError('EINVAL');
      }
      if ((!read && !write) || offset >= op.length || op[offset - 1] !== '~') throw new RuleError('EINVAL');
    } else {
      read = write = true;
    }
    const pattern = op.slice(offset);
    if (pattern === '*' && read && write) {
      s.allKeys = true;
      s.keyPatterns = [];
      return;
    }
    if (hasSpaces(pattern)) throw new RuleError('EINVAL');
    const existing = s.keyPatterns.find((k) => k.pattern === pattern);
    if (existing) {
      existing.read ||= read;
      existing.write ||= write;
    } else {
      s.keyPatterns.push({ pattern, read, write });
    }
  }
}

/** ACLUpdateCommandRules(): drop earlier rules for the same command (and its '|sub' rules), then append. */
function updateCommandRules(s: AclSelector, rule: string, allow: boolean): void {
  s.commandRules = s.commandRules.filter((r) => {
    const b = r.slice(1);
    return !(b === rule || (b.length > rule.length && b.startsWith(rule) && b[rule.length] === '|'));
  });
  s.commandRules.push((allow ? '+' : '-') + rule);
}

function channelInList(list: string[], channel: string, isPattern: boolean): boolean {
  return list.some((p) => (isPattern ? p === channel : aclGlobMatch(p, channel)));
}

function trimChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
