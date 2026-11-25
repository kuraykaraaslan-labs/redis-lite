import type { AclDenyReason, AclLogContext, AclLogReason, AclPubsubDefault } from './acl.enums';

// ============================================================================
// Permission checks
// ============================================================================

/** A key a command touches, with the access its key spec declares (RW/OW/RM/… → read/write). */
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

/** Category lookup of a command or subcommand fullname: ['@read', '@fast'…]. */
export type CategoriesOf = (command: string) => string[];

// ============================================================================
// Users and selectors
// ============================================================================

/** A key pattern of a selector: `~pattern` (read and write), `%R~pattern`, `%W~pattern`. */
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

/** ACL GETUSER data. */
export interface AclGetUser extends AclSelectorInfo {
  flags: string[];
  passwords: string[];
  selectors: AclSelectorInfo[];
}

/** Every command name, and the names that have subcommands ('config' for 'config|get'). */
export interface CommandTable {
  names: Set<string>;
  containers: Set<string>;
}

/** What applying a rule needs besides the user: the command table and acl-pubsub-default. */
export interface AclRuleContext {
  table: CommandTable;
  /** acl-pubsub-default is allchannels: new users and '(…)' selectors start with every channel. */
  allChannels: boolean;
}

// ============================================================================
// ACL LOG
// ============================================================================

export interface AclLogInput {
  reason: AclLogReason;
  context: AclLogContext;
  object: string;
  username: string;
  /** CLIENT LIST line of the offending client. */
  clientInfo: string;
}

/** One ACL LOG entry, as reported. */
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

/** One ACL LOG entry, as stored. */
export interface StoredLogEntry {
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

/** The ACL LOG of one server: newest entry first. */
export interface AclLogState {
  entries: StoredLogEntry[];
  /** Id of the next new entry. */
  nextId: number;
}

// ============================================================================
// Engine options
// ============================================================================

export interface AclOptions {
  /** Every command name, lowercase, including subcommand fullnames ('config|get'). */
  allCommands: () => string[];
  categoriesOf: CategoriesOf;
  /** The default user gets this password instead of nopass ('' = nopass). */
  requirepass?: string;
  /** acl-pubsub-default (Redis 7+ default: resetchannels). */
  pubsubDefault?: AclPubsubDefault;
  /** acllog-max-len (default 128). */
  logMaxLen?: number;
  /** Clock in ms (tests). */
  now?: () => number;
}
