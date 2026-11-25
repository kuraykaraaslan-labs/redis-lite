import { createHash, randomBytes } from 'node:crypto';

import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { firstIssue } from '@/libs/schemas';

import { AclUserNameSchema, GenPassArgDTO, GenPassBitsDTO, SelectorRulesDTO } from './acl.dto';
import { AclCategoryEnum } from './acl.enums';
import type { AclRuleErrorCode } from './acl.enums';
import AclMessages from './acl.messages';
import { AclSelector, AclUser } from './acl.structure';
import type { AclRuleContext, CommandTable } from './acl.types';

/** A refused rule (ACLSetUser's errno): reported per rule by SETUSER, per line by the file loader. */
class AclRuleError extends Error {
  constructor(readonly code: AclRuleErrorCode) {
    super(AclMessages[`RULE_${code}`]);
  }
}

/**
 * The ACL rule language (ACLSetUser / ACLSetSelector): flags, passwords, key and channel patterns, command rules and
 * '(…)' selectors, applied to a user; the users.acl file format built on it; passwords and GENPASS.
 */
export default class AclRulesService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────
  private static readonly HASH_RE = /^[0-9a-f]{64}$/;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static isSpaceChar(c: string): boolean {
    return c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
  }

  /** ACLStringHasSpaces(): whitespace or NUL. */
  private static hasSpaces(s: string): boolean {
    for (const c of s) if (AclRulesService.isSpaceChar(c) || c === '\0') return true;
    return false;
  }

  private static trimChars(s: string, chars: string): string {
    let a = 0;
    let b = s.length;
    while (a < b && chars.includes(s[a])) a++;
    while (b > a && chars.includes(s[b - 1])) b--;
    return s.slice(a, b);
  }

  /** sdssplitargs(): whitespace-separated args with "double" (escapes) and 'single' quotes; null on unbalanced quotes. */
  private static splitArgs(line: string): string[] | null {
    const isSpace = AclRulesService.isSpaceChar;
    const out: string[] = [];
    let p = 0;
    const n = line.length;
    const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c);
    for (;;) {
      while (p < n && isSpace(line[p])) p++;
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
            if (p + 1 < n && !isSpace(line[p + 1])) return null;
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
            if (p + 1 < n && !isSpace(line[p + 1])) return null;
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

  /** A '#hash' / '!hash' argument: exactly 64 lowercase hex characters. */
  private static checkHash(hash: string): string {
    if (!AclRulesService.HASH_RE.test(hash)) throw new AclRuleError('EBADMSG');
    return hash;
  }

  /** ACLUpdateCommandRules(): drop earlier rules for the same command (and its '|sub' rules), then append. */
  private static updateCommandRules(s: AclSelector, rule: string, allow: boolean): void {
    s.commandRules = s.commandRules.filter((r) => {
      const b = r.slice(1);
      return !(b === rule || (b.length > rule.length && b.startsWith(rule) && b[rule.length] === '|'));
    });
    s.commandRules.push((allow ? '+' : '-') + rule);
  }

  /** '~pattern', '%R~pattern', '%W~pattern', '%RW~pattern'. */
  private static addKeyPattern(s: AclSelector, op: string): void {
    if (s.allKeys) throw new AclRuleError('EEXIST');
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
        } else throw new AclRuleError('EINVAL');
      }
      if ((!read && !write) || offset >= op.length || op[offset - 1] !== '~') throw new AclRuleError('EINVAL');
    } else {
      read = write = true;
    }
    const pattern = op.slice(offset);
    if (pattern === '*' && read && write) {
      s.allKeys = true;
      s.keyPatterns = [];
      return;
    }
    if (AclRulesService.hasSpaces(pattern)) throw new AclRuleError('EINVAL');
    const existing = s.keyPatterns.find((k) => k.pattern === pattern);
    if (existing) {
      existing.read ||= read;
      existing.write ||= write;
    } else {
      s.keyPatterns.push({ pattern, read, write });
    }
  }

  /** '+cmd', '+cmd|sub' (or first-arg), '-cmd', '+@cat', '-@cat'. */
  private static applyCommandRule(s: AclSelector, op: string, table: CommandTable): void {
    if (op[0] === '+' && op[1] !== '@') {
      const body = op.slice(1).toLowerCase();
      const bar = body.lastIndexOf('|');
      if (bar < 0) {
        if (!table.names.has(body)) throw new AclRuleError('ENOENT');
        AclRulesService.updateCommandRules(s, body, true);
      } else {
        const cmd = body.slice(0, bar);
        const sub = body.slice(bar + 1);
        if (!table.names.has(cmd)) throw new AclRuleError('ENOENT');
        if (cmd.includes('|')) throw new AclRuleError('ECHILD');
        if (sub === '') throw new AclRuleError('EINVAL');
        if (table.containers.has(cmd) && !table.names.has(body)) throw new AclRuleError('ENOENT');
        AclRulesService.updateCommandRules(s, body, true);
      }
    } else if (op[0] === '-' && op[1] !== '@') {
      const body = op.slice(1).toLowerCase();
      if (!table.names.has(body)) throw new AclRuleError('ENOENT');
      AclRulesService.updateCommandRules(s, body, false);
    } else if ((op[0] === '+' || op[0] === '-') && op[1] === '@') {
      const cat = op.slice(2).toLowerCase();
      if (!AclCategoryEnum.safeParse(cat).success) throw new AclRuleError('ENOENT');
      AclRulesService.updateCommandRules(s, `@${cat}`, op[0] === '+');
    } else {
      throw new AclRuleError('EINVAL');
    }
  }

  /** ACLSetSelector(). */
  private static applySelectorRule(s: AclSelector, op: string, table: CommandTable): void {
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
      AclRulesService.addKeyPattern(s, op);
    } else if (op[0] === '&') {
      if (s.allChannels) throw new AclRuleError('EISDIR');
      const pat = op.slice(1);
      if (AclRulesService.hasSpaces(pat)) throw new AclRuleError('EINVAL');
      if (!s.channels.includes(pat)) s.channels.push(pat);
    } else {
      AclRulesService.applyCommandRule(s, op, table);
    }
  }

  /** ACLSetUser(): one rule. */
  private static applyUserRule(u: AclUser, op: string, ctx: AclRuleContext): void {
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
      const hash = op[0] === '>' ? AclRulesService.hashPassword(op.slice(1)) : AclRulesService.checkHash(op.slice(1));
      if (!u.passwords.includes(hash)) u.passwords.push(hash);
      u.nopass = false;
    } else if (op[0] === '<' || op[0] === '!') {
      const hash = op[0] === '<' ? AclRulesService.hashPassword(op.slice(1)) : AclRulesService.checkHash(op.slice(1));
      const idx = u.passwords.indexOf(hash);
      if (idx < 0) throw new AclRuleError('ENODEV');
      u.passwords.splice(idx, 1);
    } else if (op[0] === '(' && op[op.length - 1] === ')' && op.length >= 2) {
      const sel = new AclSelector(false, ctx.allChannels);
      for (const a of AclRulesService.splitArgs(op.slice(1, -1)) ?? []) AclRulesService.applySelectorRule(sel, a, ctx.table);
      u.selectors.push(sel);
    } else if (lower === 'clearselectors') {
      u.selectors = [u.root];
    } else if (lower === 'reset') {
      for (const r of ['resetpass', 'resetkeys', 'resetchannels']) AclRulesService.applyUserRule(u, r, ctx);
      if (ctx.allChannels) AclRulesService.applyUserRule(u, 'allchannels', ctx);
      for (const r of ['off', 'sanitize-payload', 'clearselectors', '-@all']) AclRulesService.applyUserRule(u, r, ctx);
    } else {
      AclRulesService.applySelectorRule(u.root, op, ctx.table);
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods: passwords
  // ──────────────────────────────────────────────

  /** sha256 hex of a binary (latin1) string, as stored by '>password'. */
  static hashPassword(password: string): string {
    return createHash('sha256').update(Buffer.from(password, 'latin1')).digest('hex');
  }

  /** Whether `password` logs `u` in: the user is on, and nopass or the password matches. */
  static passwordMatches(u: AclUser, password: string): boolean {
    if (!u.enabled) return false;
    if (u.nopass) return true;
    return u.passwords.includes(AclRulesService.hashPassword(password));
  }

  /** ACL GENPASS [bits]: a random hex password of `bits` bits (default 256), rounded up to a hex digit. */
  static genPass(bits?: string | number): string {
    const parsed = typeof bits === 'string' ? GenPassArgDTO.safeParse(bits) : GenPassBitsDTO.safeParse(bits ?? 256);
    if (!parsed.success) throw new AppError(firstIssue(parsed.error));
    const chars = Math.floor((parsed.data + 3) / 4);
    return randomBytes(Math.ceil(chars / 2)).toString('hex').slice(0, chars);
  }

  // ──────────────────────────────────────────────
  // Public Methods: users and rules
  // ──────────────────────────────────────────────

  /** The command names and subcommand containers, from every command fullname. */
  static commandTable(allCommands: string[]): CommandTable {
    const names = new Set<string>();
    const containers = new Set<string>();
    for (const raw of allCommands) {
      const n = raw.toLowerCase();
      names.add(n);
      const bar = n.indexOf('|');
      if (bar > 0) containers.add(n.slice(0, bar));
    }
    return { names, containers };
  }

  /** ACLCreateUser(): off, sanitize-payload, no keys, channels per acl-pubsub-default, -@all. */
  static newUser(name: string, ctx: AclRuleContext): AclUser {
    return new AclUser(name, ctx.allChannels);
  }

  /** ACLCreateDefaultUser(): +@all ~* &* on nopass. */
  static createDefaultUser(ctx: AclRuleContext): AclUser {
    const u = AclRulesService.newUser('default', ctx);
    for (const op of ['+@all', '~*', '&*', 'on', 'nopass']) AclRulesService.applyUserRule(u, op, ctx);
    return u;
  }

  /** ACL SETUSER's rules, in order; the first refused rule throws, naming it. */
  static applyRules(u: AclUser, rules: string[], ctx: AclRuleContext): void {
    for (const op of rules) {
      try {
        AclRulesService.applyUserRule(u, op, ctx);
      } catch (e) {
        if (e instanceof AclRuleError) throw new AppError(formatMessage(AclMessages.SETUSER_MODIFIER, { op, error: e.message }));
        throw e;
      }
    }
  }

  /** ACLUpdateDefaultUserPassword(): 'resetpass', then '>password' or 'nopass'. */
  static setRequirePass(def: AclUser, password: string, ctx: AclRuleContext): void {
    AclRulesService.applyUserRule(def, 'resetpass', ctx);
    AclRulesService.applyUserRule(def, password ? `>${password}` : 'nopass', ctx);
  }

  /**
   * Parses a users.acl text into new users (the default user is added when the file has none). Every line is checked;
   * the errors of all lines are reported together: AppError('ERR <file>:<line>: … ').
   */
  static parseFile(text: string, filename: string, ctx: AclRuleContext): Map<string, AclUser> {
    const users = new Map<string, AclUser>();
    let errors = '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const at = { filename, line: i + 1 };
      const line = AclRulesService.trimChars(lines[i], ' \t\r\n');
      if (line === '') continue;
      const argv = line.split(' ');
      if (argv[0] !== 'user' || argv.length < 2) {
        errors += formatMessage(AclMessages.FILE_NO_USER_KEYWORD, at);
        continue;
      }
      const name = argv[1];
      if (!AclUserNameSchema.safeParse(name).success) {
        errors += formatMessage(AclMessages.FILE_BAD_USERNAME, { ...at, name });
        continue;
      }
      if (users.has(name)) {
        errors += formatMessage(AclMessages.FILE_DUPLICATE_USER, { ...at, name });
        continue;
      }
      const u = AclRulesService.newUser(name, ctx);
      users.set(name, u);
      const { rules, unclosed } = SelectorRulesDTO.parse(argv.slice(2));
      if (unclosed) {
        errors += formatMessage(AclMessages.FILE_UNMATCHED_PAREN, at);
        continue;
      }
      let syntaxError = false;
      for (const raw of rules) {
        const op = AclRulesService.trimChars(raw, '\t\r\n');
        try {
          AclRulesService.applyUserRule(u, op, ctx);
        } catch (e) {
          if (!(e instanceof AclRuleError)) throw e;
          if (e.code === 'ENOENT') {
            errors += formatMessage(AclMessages.FILE_RULE_ERROR, { ...at, op, error: e.message });
          } else if (!syntaxError) {
            errors += formatMessage(AclMessages.FILE_SYNTAX_ERROR, { ...at, error: e.message });
            syntaxError = true;
          }
        }
      }
    }
    if (errors) throw new AppError(formatMessage(AclMessages.FILE_ERRORS, { errors }));
    if (!users.has('default')) users.set('default', AclRulesService.createDefaultUser(ctx));
    return users;
  }
}
