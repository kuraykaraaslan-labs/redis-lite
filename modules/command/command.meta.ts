import type { Reply } from '@/libs/resp';
import { RespMap, RespSet, Status } from '@/libs/resp';

import { COMMANDS } from './command.registry';
import type { Row } from './command.meta_table';
import { COMMAND_TABLE } from './command.meta_table';

/** ACL categories, in the order Redis lists them (ACL CAT, COMMAND INFO). */
export const ACL_CATEGORIES = [
  'keyspace', 'read', 'write', 'set', 'sortedset', 'list', 'hash', 'string', 'bitmap', 'hyperloglog', 'geo', 'stream', 'pubsub', 'admin',
  'fast', 'slow', 'blocking', 'dangerous', 'connection', 'transaction', 'scripting',
] as const;

/** Command flags in the order COMMAND INFO prints them (hidden flags such as may_replicate / sentinel / protected are left out). */
const FLAG_ORDER = [
  'write', 'readonly', 'denyoom', 'module', 'admin', 'pubsub', 'noscript', 'blocking', 'loading', 'stale', 'skip_monitor', 'skip_slowlog', 'asking',
  'fast', 'no_auth', 'no_mandatory_keys', 'no_async_loading', 'no_multi', 'movablekeys', 'allow_busy',
];

export type BeginSearch = { type: 'index'; index: number } | { type: 'keyword'; keyword: string; startfrom: number } | { type: 'unknown' };
export type FindKeys =
  | { type: 'range'; lastkey: number; keystep: number; limit: number }
  | { type: 'keynum'; keynumidx: number; firstkey: number; keystep: number }
  | { type: 'unknown' };

export interface KeySpec {
  flags: string[];
  begin: BeginSearch;
  find: FindKeys;
}

export interface ArgDoc {
  name: string;
  type: string;
  keySpecIndex?: number;
  token?: string;
  since?: string;
  display?: string;
  optional: boolean;
  multiple: boolean;
  multipleToken: boolean;
  args?: ArgDoc[];
}

export interface CommandMeta {
  /** Lowercase name (the subcommand alone for a subcommand). */
  name: string;
  /** `name` or `container|name`. */
  fullname: string;
  arity: number;
  /** Visible flags, in COMMAND INFO order (movablekeys included). */
  flags: string[];
  /** Every flag, hidden ones included. */
  flagSet: Set<string>;
  /** ACL categories (without '@'), explicit + implied, in Redis order. */
  acl: string[];
  firstKey: number;
  lastKey: number;
  step: number;
  tips: string[];
  keySpecs: KeySpec[];
  subcommands: Map<string, CommandMeta>;
  group: string;
  since: string;
  summary: string;
  complexity: string;
  docFlags: string[];
  deprecatedSince?: string;
  replacedBy?: string;
  args: ArgDoc[];
  parent?: CommandMeta;
}

// ---- argument DSL ------------------------------------------------------------------------------------------------

function splitTop(s: string): string[] {
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

function parseArg(raw: string): ArgDoc {
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
  if (!m) throw new Error(`bad argument spec: ${raw}`);
  const [, token, name, type, ksIndex, inner] = m;
  const arg: ArgDoc = { ...base, name, type, token };
  if (type === 'key') arg.keySpecIndex = Number(ksIndex || '0');
  if (type === 'oneof' || type === 'block') arg.args = parseArgs(inner ?? '');
  else arg.display = name;
  return arg;
}

export function parseArgs(spec: string | undefined): ArgDoc[] {
  return spec ? splitTop(spec).map(parseArg) : [];
}

// ---- key spec DSL ------------------------------------------------------------------------------------------------

function parseKeySpecs(spec: string): KeySpec[] {
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
function legacyRange(specs: KeySpec[]): [number, number, number] {
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

// ---- building ----------------------------------------------------------------------------------------------------

function build(row: Row, group: string, parent?: CommandMeta): CommandMeta {
  const [name, arity, flagStr, aclStr, ksStr, since, summary, complexity, argStr, extra] = row;
  const keySpecs = parseKeySpecs(ksStr);
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
  const [firstKey, lastKey, step] = legacyRange(keySpecs);
  const meta: CommandMeta = {
    name,
    fullname: parent ? `${parent.name}|${name}` : name,
    arity,
    flags: FLAG_ORDER.filter((f) => flagSet.has(f)),
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
    args: parseArgs(argStr),
    parent,
  };
  for (const sub of extra?.subs ?? []) {
    const m = build(sub, group, meta);
    meta.subcommands.set(m.name, m);
  }
  return meta;
}

/** A command implemented by redis-lite but missing from the table: metadata derived from its spec. */
function fallback(name: string): CommandMeta | undefined {
  const spec = COMMANDS.get(name);
  if (!spec) return undefined;
  const flags = [spec.flags?.write ? 'write' : 'readonly'];
  if (spec.flags?.noscript) flags.push('noscript');
  if (spec.flags?.pubsub) flags.push('pubsub');
  if (spec.flags?.noauth) flags.push('no_auth');
  return build([name, spec.arity, flags.join(' '), '', spec.keys ? 'RW|1' : '', '', '', ''], 'server');
}

let table: Map<string, CommandMeta> | null = null;

function metaTable(): Map<string, CommandMeta> {
  if (table) return table;
  const all = new Map<string, CommandMeta>();
  for (const [group, rows] of COMMAND_TABLE) for (const row of rows) all.set(row[0], build(row, group));
  // only the commands redis-lite implements are reported
  const out = new Map<string, CommandMeta>();
  for (const name of COMMANDS.keys()) {
    const m = all.get(name) ?? fallback(name);
    if (m) out.set(name, m);
  }
  table = out;
  return out;
}

/** Every implemented top-level command. */
export function allCommandMeta(): CommandMeta[] {
  return [...metaTable().values()];
}

/** Top-level command by name (case-insensitive), or `container|sub`. */
export function getCommandMeta(name: string): CommandMeta | undefined {
  const lower = name.toLowerCase();
  const bar = lower.indexOf('|');
  if (bar < 0) return metaTable().get(lower);
  return metaTable().get(lower.slice(0, bar))?.subcommands.get(lower.slice(bar + 1));
}

/** Redis lookupCommand(): the subcommand when the command is a container and a subcommand is given. */
export function lookupCommand(argv: string[]): { meta?: CommandMeta; base?: CommandMeta } {
  const base = getCommandMeta(argv[0]);
  if (!base || argv.length === 1 || !base.subcommands.size) return { meta: base, base };
  return { meta: base.subcommands.get(argv[1].toLowerCase()), base };
}

export function arityOk(arity: number, argc: number): boolean {
  return arity > 0 ? argc === arity : argc >= -arity;
}

/** Every command and subcommand, depth first (COMMAND LIST, ACL CAT). */
export function allCommandsDeep(): CommandMeta[] {
  const out: CommandMeta[] = [];
  for (const m of allCommandMeta()) {
    out.push(m);
    out.push(...m.subcommands.values());
  }
  return out;
}

// ---- key extraction (COMMAND GETKEYS) ----------------------------------------------------------------------------

export interface KeyRef {
  index: number;
  flags: string[];
}

/** Redis getKeysUsingKeySpecs(); argv includes the command name. Null = the key specs could not be applied (invalid arguments). */
export function keysFromSpecs(meta: CommandMeta, argv: string[]): KeyRef[] | null {
  if (meta.name === 'sort' || meta.name === 'sort_ro') return sortKeys(meta, argv);
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

/** SORT has unknown key specs (BY/GET patterns, STORE anywhere): Redis uses sortGetKeys(). */
function sortKeys(meta: CommandMeta, argv: string[]): KeyRef[] {
  const out: KeyRef[] = [{ index: 1, flags: meta.keySpecs[0]?.flags ?? ['RO', 'access'] }];
  const skip: Record<string, number> = { limit: 2, get: 1, by: 1 };
  let store: number | null = null;
  for (let i = 2; i < argv.length; i++) {
    const opt = argv[i].toLowerCase();
    if (meta.name === 'sort' && opt === 'store' && i + 1 < argv.length) {
      store = i + 1;
      i++;
      continue;
    }
    i += skip[opt] ?? 0;
  }
  if (store !== null) out.push({ index: store, flags: ['OW', 'update'] });
  return out;
}

/** Whether COMMAND GETKEYS can report keys for this command. */
export function commandHasKeys(meta: CommandMeta): boolean {
  return meta.keySpecs.some((s) => !s.flags.includes('not_key'));
}

// ---- replies -----------------------------------------------------------------------------------------------------

const statuses = (items: string[]): RespSet => new RespSet(items.map((s) => new Status(s)));

function keySpecReply(spec: KeySpec): Reply {
  let begin: RespMap;
  if (spec.begin.type === 'index') begin = RespMap.from(['type', 'index', 'spec', RespMap.from(['index', spec.begin.index])]);
  else if (spec.begin.type === 'keyword')
    begin = RespMap.from(['type', 'keyword', 'spec', RespMap.from(['keyword', spec.begin.keyword, 'startfrom', spec.begin.startfrom])]);
  else begin = RespMap.from(['type', 'unknown', 'spec', new RespMap([])]);
  let find: RespMap;
  if (spec.find.type === 'range')
    find = RespMap.from(['type', 'range', 'spec', RespMap.from(['lastkey', spec.find.lastkey, 'keystep', spec.find.keystep, 'limit', spec.find.limit])]);
  else if (spec.find.type === 'keynum')
    find = RespMap.from([
      'type', 'keynum', 'spec', RespMap.from(['keynumidx', spec.find.keynumidx, 'firstkey', spec.find.firstkey, 'keystep', spec.find.keystep]),
    ]);
  else find = RespMap.from(['type', 'unknown', 'spec', new RespMap([])]);
  return RespMap.from(['flags', statuses(spec.flags), 'begin_search', begin, 'find_keys', find]);
}

/** One COMMAND INFO entry. */
export function commandInfoReply(m: CommandMeta): Reply {
  return [
    m.fullname,
    m.arity,
    statuses(m.flags),
    m.firstKey,
    m.lastKey,
    m.step,
    statuses(m.acl.map((c) => `@${c}`)),
    statuses(m.tips),
    m.keySpecs.map(keySpecReply),
    [...m.subcommands.values()].map(commandInfoReply),
  ];
}

function argReply(a: ArgDoc): RespMap {
  const flat: Reply[] = ['name', a.name, 'type', a.type];
  if (a.display !== undefined) flat.push('display_text', a.display);
  if (a.keySpecIndex !== undefined) flat.push('key_spec_index', a.keySpecIndex);
  if (a.token !== undefined) flat.push('token', a.token);
  if (a.since !== undefined) flat.push('since', a.since);
  const flags: string[] = [];
  if (a.optional) flags.push('optional');
  if (a.multiple) flags.push('multiple');
  if (a.multipleToken) flags.push('multiple_token');
  if (flags.length) flat.push('flags', statuses(flags));
  if (a.args) flat.push('arguments', a.args.map(argReply));
  return RespMap.from(flat);
}

/** One COMMAND DOCS entry (the value; the caller pairs it with the name). */
export function commandDocsReply(m: CommandMeta): RespMap {
  const flat: Reply[] = ['summary', m.summary, 'since', m.since, 'group', m.group];
  if (m.complexity) flat.push('complexity', m.complexity);
  if (m.docFlags.length) flat.push('doc_flags', statuses(m.docFlags));
  if (m.deprecatedSince) flat.push('deprecated_since', m.deprecatedSince);
  if (m.replacedBy) flat.push('replaced_by', m.replacedBy);
  if (m.args.length) flat.push('arguments', m.args.map(argReply));
  if (m.subcommands.size) flat.push('subcommands', new RespMap([...m.subcommands.values()].map((s) => [s.fullname, commandDocsReply(s)])));
  return RespMap.from(flat);
}
