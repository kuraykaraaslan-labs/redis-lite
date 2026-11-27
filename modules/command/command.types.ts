import type { Reply } from '@/libs/resp';

import type { Database } from '@/modules/database/database.service';
import type { Client, RedisLiteServer } from '@/modules/server/server.service';

import type { Block, NO_REPLY } from './command.handler';

// ============================================================================
// Command Specs (the registry)
// ============================================================================

export interface CommandContext {
  server: RedisLiteServer;
  client: Client;
  db: Database;
  /** Running inside EVAL/EVALSHA. */
  inScript: boolean;
  /** Blocking commands must answer at once (inside MULTI/EXEC or a script). */
  noBlock: boolean;
  /** Set by a write handler that ended up not modifying anything (Redis then does not signal the key). */
  noop: boolean;
  /** The command name exactly as the client sent it (argv[0]), e.g. the ACL LOG object of a failed AUTH. */
  name?: string;
}

export type HandlerResult = Reply | Block | typeof NO_REPLY;

export type CommandHandler = (ctx: CommandContext, args: string[]) => HandlerResult;

export interface CommandFlags {
  /** Modifies its keys: bumps WATCH versions and wakes blocked clients. */
  write?: boolean;
  /** Refused inside scripts. */
  noscript?: boolean;
  /** Allowed before AUTH. */
  noauth?: boolean;
  /** Allowed in RESP2 subscriber mode. */
  pubsub?: boolean;
}

export interface CommandSpec {
  /** Lowercase command name. */
  name: string;
  /** Redis arity: positive = exact argc (name included), negative = at least |arity|. */
  arity: number;
  flags?: CommandFlags;
  /** The key arguments (args exclude the command name). */
  keys?: (args: string[]) => string[];
  handler: CommandHandler;
}

// ============================================================================
// Command Metadata (COMMAND INFO / DOCS, key specs)
// ============================================================================

export type BeginSearch = { type: 'index'; index: number } | { type: 'keyword'; keyword: string; startfrom: number } | { type: 'unknown' };

export type FindKeys =
  | { type: 'range'; lastkey: number; keystep: number; limit: number }
  | { type: 'keynum'; keynumidx: number; firstkey: number; keystep: number }
  | { type: 'unknown' };

export interface KeySpec {
  flags: string[];
  begin: BeginSearch;
  find: FindKeys;
  /** Why the flags are what they are (COMMAND INFO `notes`), when Redis documents it. */
  notes?: string;
}

/** One COMMAND DOCS argument, fields in reply order. */
export interface ArgDoc {
  name: string;
  type: string;
  keySpecIndex?: number;
  token?: string;
  since?: string;
  deprecatedSince?: string;
  /** optional / multiple / multiple_token, as Redis lists them. */
  flags?: string[];
  args?: ArgDoc[];
}

/** One row of the metadata table (`command.meta_table`): a command or subcommand as COMMAND INFO / DOCS report it. */
export interface MetaRow {
  /** Lowercase name (the subcommand alone for a subcommand). */
  name: string;
  arity: number;
  /** Visible flags, in COMMAND INFO order. */
  flags: string[];
  /** Flags COMMAND INFO does not show (may_replicate, protected). */
  hidden?: string[];
  /** Legacy first key, last key, step. */
  keys: [first: number, last: number, step: number];
  /** ACL categories without '@', in COMMAND INFO order. */
  acl: string[];
  tips?: string[];
  keySpecs?: KeySpec[];
  summary: string;
  since: string;
  group: string;
  complexity?: string;
  docFlags?: string[];
  deprecatedSince?: string;
  replacedBy?: string;
  history?: Array<[version: string, change: string]>;
  args?: ArgDoc[];
  subs?: MetaRow[];
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
  complexity?: string;
  docFlags: string[];
  deprecatedSince?: string;
  replacedBy?: string;
  /** COMMAND DOCS `history`: [version, change]. */
  history: ReadonlyArray<[version: string, change: string]>;
  args: ArgDoc[];
  parent?: CommandMeta;
  /** The module a module command belongs to (COMMAND DOCS `module`, COMMAND LIST FILTERBY MODULE). */
  module?: string;
}

/** A key found in a command line: its argv index and the key spec flags (RO, RW, access, update…). */
export interface KeyRef {
  index: number;
  flags: string[];
}

/** Redis lookupCommand(): the (sub)command metadata and the container it belongs to. */
export interface CommandLookup {
  meta?: CommandMeta;
  base?: CommandMeta;
}
