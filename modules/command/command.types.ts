import type { Reply } from '@/libs/resp';

import type { Database } from '@/modules/database/database.core';
import type { Client } from '@/modules/server/server.client';
import type { RedisLiteServer } from '@/modules/server/server.core';

import type { Block, NO_REPLY } from './command.handler';

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
  handler: (ctx: CommandContext, args: string[]) => HandlerResult;
}
