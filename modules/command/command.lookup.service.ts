import { formatMessage } from '@/libs/message-format';

import { ACL_CATEGORIES, COMMAND_FLAG_ORDER } from './command.enums';
import CommandMessages from './command.messages';
import type { Row } from './command.meta_table';
import { COMMAND_TABLE } from './command.meta_table';
import type { ArgDoc, BeginSearch, CommandLookup, CommandMeta, CommandSpec, FindKeys, KeySpec } from './command.types';

/**
 * Command metadata: builds the COMMAND table from `command.meta_table` (argument and key-spec DSLs) once, on first use,
 * and looks commands and subcommands up in it (Redis lookupCommand(), arity checks).
 *
 * The implemented commands come from `command.registry`, which hands its map over with `useRegistry()` once it is built:
 * importing the registry from here would load every command module (and their imports of this module's facade) while
 * this class is still undefined.
 */
export default class CommandLookupService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  private static table: Map<string, CommandMeta> | null = null;

  private static commands: ReadonlyMap<string, CommandSpec> = new Map();

  // ──────────────────────────────────────────────
  // Private Helpers: argument DSL
  // ──────────────────────────────────────────────

  private static splitTop(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ' ' && depth === 0) {
        if (cur) out.push(cur);
        cur = '';
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  private static parseArg(raw: string): ArgDoc {
    let s = raw;
    let optional = false;
    if (s.startsWith('?')) {
      optional = true;
      s = s.slice(1);
    }
    let since: string | undefined;
    let multiple = false;
    let multipleToken = false;
    for (;;) {
      const m = /\{([\d.]+)\}$/.exec(s);
      if (m) {
        since = m[1];
        s = s.slice(0, -m[0].length);
        continue;
      }
      if (s.endsWith('*') && !s.endsWith('!*')) {
        multipleToken = true;
        s = s.slice(0, -1);
        continue;
      }
      if (s.endsWith('...')) {
        multiple = true;
        s = s.slice(0, -3);
        continue;
      }
      break;
    }
    const base = { optional, multiple, multipleToken, since };
    const pure = /^([a-z0-9_-]*)(?::pure-token)?!(.+)$/.exec(s);
    if (pure && !s.includes('(')) {
      return { ...base, name: pure[1] || pure[2].toLowerCase(), type: 'pure-token', token: pure[2] };
    }
    if (s === 'key') return { ...base, name: 'key', type: 'key', keySpecIndex: 0, display: 'key' };
    const m = /^(?:([A-Z0-9_-]+)=)?([a-z0-9_-]+):([a-z-]+?)(\d*)(?:\((.*)\))?$/s.exec(s);
    if (!m) throw new Error(formatMessage(CommandMessages.BAD_ARGUMENT_SPEC, { spec: raw }));
    const [, token, name, type, ksIndex, inner] = m;
    const arg: ArgDoc = { ...base, name, type, token };
    if (type === 'key') arg.keySpecIndex = Number(ksIndex || '0');
    if (type === 'oneof' || type === 'block') arg.args = CommandLookupService.parseArgs(inner ?? '');
    else arg.display = name;
    return arg;
  }

  // ──────────────────────────────────────────────
  // Private Helpers: key spec DSL
  // ──────────────────────────────────────────────

  private static parseKeySpecs(spec: string): KeySpec[] {
    if (!spec) return [];
    return spec.split(';').map((one) => {
      const [flags, begin = '1', find = '0'] = one.split('|');
      let b: BeginSearch;
      if (begin === '?') b = { type: 'unknown' };
      else if (/^-?\d+$/.test(begin)) b = { type: 'index', index: Number(begin) };
      else {
        const [kw, from] = begin.split('@');
        b = { type: 'keyword', keyword: kw, startfrom: Number(from) };
      }
      let f: FindKeys;
      if (find === '?') f = { type: 'unknown' };
      else if (find.startsWith('#')) {
        const [idx, first, step] = find.slice(1).split(',').map(Number);
        f = { type: 'keynum', keynumidx: idx, firstkey: first, keystep: step };
      } else {
        const [last, step = '1', limit = '0'] = find.split('/');
        f = { type: 'range', lastkey: Number(last), keystep: Number(step), limit: Number(limit) };
      }
      return { flags: flags.split(' ').filter(Boolean), begin: b, find: f };
    });
  }

  /** Redis populateCommandLegacyRangeSpec(): first/last/step from the contiguous index+range key specs. */
  private static legacyRange(specs: KeySpec[]): [number, number, number] {
    let first = 0;
    let last = 0;
    let step = 0;
    let prevLast = 0;
    for (const s of specs) {
      if (s.begin.type !== 'index' || s.find.type !== 'range') continue;
      if (s.flags.includes('not_key')) continue;
      const index = s.begin.index;
      const specLast = s.find.lastkey >= 0 ? index + s.find.lastkey : s.find.lastkey;
      if (!first) {
        first = index;
        last = specLast;
        step = s.find.keystep;
        prevLast = specLast;
        continue;
      }
      if (s.find.keystep !== 1 || step !== 1 || prevLast < 0 || index !== prevLast + 1) {
        // not contiguous: Redis gives up on a single range
        continue;
      }
      last = specLast;
      prevLast = specLast;
    }
    return [first, last, step];
  }

  // ──────────────────────────────────────────────
  // Private Helpers: building
  // ──────────────────────────────────────────────

  private static build(row: Row, group: string, parent?: CommandMeta): CommandMeta {
    const [name, arity, flagStr, aclStr, ksStr, since, summary, complexity, argStr, extra] = row;
    const keySpecs = CommandLookupService.parseKeySpecs(ksStr);
    const flagSet = new Set(flagStr.split(' ').filter(Boolean));
    const movable = keySpecs.some((s) => !s.flags.includes('not_key') && (s.begin.type !== 'index' || s.find.type !== 'range'));
    if (movable) flagSet.add('movablekeys');
    const acl = new Set(aclStr.split(' ').filter(Boolean));
    if (flagSet.has('write')) acl.add('write');
    if (flagSet.has('readonly') && !acl.has('scripting')) acl.add('read');
    if (flagSet.has('admin')) {
      acl.add('admin');
      acl.add('dangerous');
    }
    if (flagSet.has('pubsub')) acl.add('pubsub');
    if (flagSet.has('fast')) acl.add('fast');
    if (flagSet.has('blocking')) acl.add('blocking');
    if (!acl.has('fast')) acl.add('slow');
    const [firstKey, lastKey, step] = CommandLookupService.legacyRange(keySpecs);
    const meta: CommandMeta = {
      name,
      fullname: parent ? `${parent.name}|${name}` : name,
      arity,
      flags: COMMAND_FLAG_ORDER.filter((f) => flagSet.has(f)),
      flagSet,
      acl: ACL_CATEGORIES.filter((c) => acl.has(c)),
      firstKey,
      lastKey,
      step,
      tips: (extra?.tips ?? '').split(' ').filter(Boolean),
      keySpecs,
      subcommands: new Map(),
      group,
      since,
      summary,
      complexity,
      docFlags: (extra?.docFlags ?? '').split(' ').filter(Boolean),
      deprecatedSince: extra?.dep?.[0],
      replacedBy: extra?.dep?.[1],
      args: CommandLookupService.parseArgs(argStr),
      parent,
    };
    for (const sub of extra?.subs ?? []) {
      const m = CommandLookupService.build(sub, group, meta);
      meta.subcommands.set(m.name, m);
    }
    return meta;
  }

  /** A command implemented by redis-lite but missing from the table: metadata derived from its spec. */
  private static fallback(name: string): CommandMeta | undefined {
    const spec = CommandLookupService.commands.get(name);
    if (!spec) return undefined;
    const flags = [spec.flags?.write ? 'write' : 'readonly'];
    if (spec.flags?.noscript) flags.push('noscript');
    if (spec.flags?.pubsub) flags.push('pubsub');
    if (spec.flags?.noauth) flags.push('no_auth');
    return CommandLookupService.build([name, spec.arity, flags.join(' '), '', spec.keys ? 'RW|1' : '', '', '', ''], 'server');
  }

  private static metaTable(): Map<string, CommandMeta> {
    if (CommandLookupService.table) return CommandLookupService.table;
    const all = new Map<string, CommandMeta>();
    for (const [group, rows] of COMMAND_TABLE) for (const row of rows) all.set(row[0], CommandLookupService.build(row, group));
    // only the commands redis-lite implements are reported
    const out = new Map<string, CommandMeta>();
    for (const name of CommandLookupService.commands.keys()) {
      const m = all.get(name) ?? CommandLookupService.fallback(name);
      if (m) out.set(name, m);
    }
    CommandLookupService.table = out;
    return out;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Called by `command.registry` with every implemented command; the metadata table is rebuilt on next use. */
  static useRegistry(commands: ReadonlyMap<string, CommandSpec>): void {
    CommandLookupService.commands = commands;
    CommandLookupService.table = null;
  }

  /** The argument DSL of the metadata table → COMMAND DOCS argument tree. */
  static parseArgs(spec: string | undefined): ArgDoc[] {
    return spec ? CommandLookupService.splitTop(spec).map((raw) => CommandLookupService.parseArg(raw)) : [];
  }

  /** Every implemented top-level command. */
  static allCommandMeta(): CommandMeta[] {
    return [...CommandLookupService.metaTable().values()];
  }

  /** Top-level command by name (case-insensitive), or `container|sub`. */
  static getCommandMeta(name: string): CommandMeta | undefined {
    const lower = name.toLowerCase();
    const bar = lower.indexOf('|');
    if (bar < 0) return CommandLookupService.metaTable().get(lower);
    return CommandLookupService.metaTable().get(lower.slice(0, bar))?.subcommands.get(lower.slice(bar + 1));
  }

  /** Redis lookupCommand(): the subcommand when the command is a container and a subcommand is given. */
  static lookupCommand(argv: string[]): CommandLookup {
    const base = CommandLookupService.getCommandMeta(argv[0]);
    if (!base || argv.length === 1 || !base.subcommands.size) return { meta: base, base };
    return { meta: base.subcommands.get(argv[1].toLowerCase()), base };
  }

  static arityOk(arity: number, argc: number): boolean {
    return arity > 0 ? argc === arity : argc >= -arity;
  }

  /** Every command and subcommand, depth first (COMMAND LIST, ACL CAT). */
  static allCommandsDeep(): CommandMeta[] {
    const out: CommandMeta[] = [];
    for (const m of CommandLookupService.allCommandMeta()) {
      out.push(m);
      out.push(...m.subcommands.values());
    }
    return out;
  }
}
