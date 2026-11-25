import type { Reply } from '../resp';
import { NULL_ARRAY } from '../resp';
import type { Client } from '../server/client';
import type { RedisLiteServer } from '../server/server';
import type { Database } from '../store/database';

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

/** Returned by a blocking command that found nothing: the server parks the client until `retry` yields a reply or the timeout fires. */
export class Block {
  constructor(
    readonly keys: string[],
    /** 0 = wait forever. */
    readonly timeoutMs: number,
    /** Tries again; undefined = still nothing to serve. */
    readonly retry: () => Reply | undefined,
    readonly timeoutReply: Reply = NULL_ARRAY,
  ) {}
}

/** The handler already wrote its replies (SUBSCRIBE family). */
export const NO_REPLY = Symbol('NO_REPLY');

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

/** Key extractor for keys at fixed positions: first..last (inclusive, -1 = last arg) every `step`. */
export function keysAt(first: number, last = first, step = 1): (args: string[]) => string[] {
  return (args) => {
    const end = last < 0 ? args.length + last : last;
    const out: string[] = [];
    for (let i = first; i <= end && i < args.length; i += step) out.push(args[i]);
    return out;
  };
}
