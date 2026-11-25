import type { Reply } from '@/libs/resp';

import type { CommandMeta } from '@/modules/command/command.types';

import type { Client } from './server.client';

/** Options of a RedisLiteServer (the RedisLite API and the CLI build them). */
export interface ServerOptions {
  port: number;
  host: string;
  password?: string;
  databases: number;
  logLevel: 'silent' | 'warn' | 'info' | 'debug';
  /** ACL file (the immutable `aclfile` config): loaded at startup, used by ACL LOAD / ACL SAVE. */
  aclfile?: string;
  /**
   * Load the RDB / AOF at startup and keep the configured save points. False (the default for embedded servers): the
   * server stays in memory (`save ""`, `appendonly no`, nothing loaded) unless `config` says otherwise.
   */
  persistence?: boolean;
  /** Initial config values (redis.conf directives / CONFIG SET names), validated like CONFIG SET. */
  config?: Record<string, string>;
  /** Absolute path of the redis.conf the server was started with (INFO config_file). */
  configFile?: string;
}

/** Hooks other modules plug into DEBUG (the persistence engine provides RELOAD / LOADAOF). */
export interface DebugHooks {
  /** DEBUG RELOAD [MERGE] [NOFLUSH] [NOSAVE]; args are the options after RELOAD. */
  reload?: (client: Client, args: string[]) => Reply;
  /** DEBUG LOADAOF. */
  loadaof?: (client: Client) => Reply;
}

/** Per-command statistics (INFO commandstats). */
export interface CommandStat {
  calls: number;
  usec: number;
  rejected: number;
  failed: number;
}

/** One SLOWLOG entry. */
export interface SlowlogEntry {
  id: number;
  time: number;
  usec: number;
  argv: string[];
  addr: string;
  name: string;
}

/** How a command is run: from a script (`redis.call`), and whether it may block. */
export interface ExecuteMode {
  inScript: boolean;
  noBlock: boolean;
}

/** Redis processCommand()'s first checks (existence, subcommand, arity): the error to answer, or null. */
export interface Precheck {
  error: string | null;
  meta?: CommandMeta;
  statName?: string;
}

/** A key's state before a command runs (keyspace events, SET … GET's no-op test). */
export interface KeyState {
  exists: boolean;
  size: number;
}

/** CONFIG SET validation outcome for one directive. */
export type ConfigCheck = { value: string } | { error: string };
