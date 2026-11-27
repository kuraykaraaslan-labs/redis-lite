import type { AclSelectorInfo, KeyPattern } from './acl.types';

/**
 * The ACL data model: a user and its selectors, with Redis's describe() forms (ACL LIST, ACL GETUSER, users.acl).
 * The rule language that changes them lives in AclRulesService, the permission checks in AclCheckService.
 */

/** `~pattern`, `%R~pattern` or `%W~pattern`. */
function patternString(k: KeyPattern): string {
  const prefix = k.read && k.write ? '~' : k.read ? '%R~' : '%W~';
  return prefix + k.pattern;
}

// ============================================================================
// Selector
// ============================================================================

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

  /** The command rules as stored (base and rules in order); ACL LIST shows AclDescribeService's rebuilt form instead. */
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

  /** ACLDescribeSelector(): keys, channels, commands (`commands` = the description of the command part). */
  describe(commands = this.describeCommands()): string {
    let res = '';
    if (this.allKeys) res += '~* ';
    else for (const k of this.keyPatterns) res += `${patternString(k)} `;
    if (this.allChannels) res += '&* ';
    else {
      res += 'resetchannels ';
      for (const c of this.channels) res += `&${c} `;
    }
    return res + commands;
  }

  info(commands = this.describeCommands()): AclSelectorInfo {
    return { commands, keys: this.describeKeys(), channels: this.describeChannels() };
  }
}

// ============================================================================
// User
// ============================================================================

export class AclUser {
  enabled = false;
  nopass = false;
  skipSanitizePayload = false;
  /** The explicit sanitize-payload flag (set by `sanitize-payload` and `reset`; a new user has neither flag). */
  sanitizePayload = false;
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
    this.sanitizePayload = other.sanitizePayload;
    this.passwords = [...other.passwords];
    this.selectors = other.selectors.map((s) => s.clone());
  }

  /** Flags in ACLUserFlags order. */
  flags(): string[] {
    const f = [this.enabled ? 'on' : 'off'];
    if (this.nopass) f.push('nopass');
    if (this.skipSanitizePayload) f.push('skip-sanitize-payload');
    if (this.sanitizePayload) f.push('sanitize-payload');
    return f;
  }

  /** ACLDescribeUser() (the rules part of an ACL LIST line); `commands` describes each selector's command part. */
  describe(commands: (s: AclSelector) => string = (s) => s.describeCommands()): string {
    let res = '';
    for (const f of this.flags()) res += `${f} `;
    for (const p of this.passwords) res += `#${p} `;
    for (const s of this.selectors) res += s.root ? s.describe(commands(s)) : ` (${s.describe(commands(s))})`;
    return res;
  }
}
