import { AppError } from '@/libs/app-error';
import Logger from '@/libs/logger';
import { formatMessage } from '@/libs/message-format';
import { RespError } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import AclService from '@/modules/acl/acl.service';
import type { Block } from '@/modules/command/command.service';
import { COMMANDS } from '@/modules/command/command.registry';
import CommandService from '@/modules/command/command.service';
import TrackingService from '@/modules/tracking/tracking.service';

import type { Client, Waiter } from './server.client';
import type { RedisLiteServer } from './server.core';
import { specKeys } from './server.dispatcher';
import ServerMessages from './server.messages';

/** Longest delay a Node timer accepts. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Blocked clients (BLPOP, BZPOPMIN, XREAD BLOCK…): the waiters per `${db}:${key}`, their timeouts, and serving them FIFO
 * per key once a key they wait on changes (Redis handleClientsBlockedOnKeys()).
 */
export class ServerBlocking {
  /** COMMAND DOCS group of a blocking command → the value type it pops from. */
  private static readonly GROUP_TYPES: Readonly<Record<string, string>> = { list: 'list', 'sorted-set': 'zset', stream: 'stream' };

  private readonly waiters = new Map<string, Waiter[]>();
  private readonly readyKeys = new Set<string>();
  private servingReady = false;

  constructor(private readonly server: RedisLiteServer) {}

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /**
   * Redis serves a waiter only when the key that became ready holds the type its command pops from: a key that now
   * holds another type (SET over a list someone BLPOPs) leaves the client blocked. XREADGROUP is the exception: its
   * group went away with the stream, and its own retry answers that.
   */
  private holdsWaitedType(waiter: Waiter, dbKey: string): boolean {
    if (!waiter.argv || waiter.argv[0].toLowerCase() === 'xreadgroup') return true;
    const expected = ServerBlocking.GROUP_TYPES[CommandService.lookupCommand(waiter.argv).meta?.group ?? ''];
    if (!expected) return true;
    const sep = dbKey.indexOf(':');
    const value = this.server.databases[Number(dbKey.slice(0, sep))]?.raw(dbKey.slice(sep + 1));
    return value === undefined || value.type === expected;
  }

  /** An error thrown while serving a waiter becomes its reply (Redis answers the blocked client with the error). */
  private retryOrError(waiter: Waiter): Reply | undefined {
    try {
      return waiter.retry();
    } catch (error) {
      if (error instanceof AppError) return new RespError(error.message);
      Logger.error('[ServerBlocking.retryBlocked] Internal error', { err: (error as Error).stack ?? String(error) });
      return new RespError(formatMessage(ServerMessages.GENERIC_ERROR, { message: (error as Error).message }));
    }
  }

  /**
   * Tries to serve a blocked client. A served command is its own execution unit: it is propagated (as its non-blocking
   * form) and its keyspace events are published, like a command that just ran. An error is answered, never thrown.
   */
  private retryBlocked(waiter: Waiter): Reply | undefined {
    const server = this.server;
    const { client, argv } = waiter;
    const db = server.databases[client.dbIndex];
    const name = argv?.[0].toLowerCase() ?? '';
    const spec = COMMANDS.get(name);
    const keys = argv ? specKeys(spec?.keys, argv.slice(1)) : [];
    const notify = argv ? server.keyspace.notifyFlags() : null;
    const before = notify ? server.keyspace.keyStates(db, keys) : null;
    const dirtyBefore = server.persistence.dirty;
    const propagator = server.persistence.propagator;
    propagator.enter(name);
    server.tracking.current = client;
    try {
      const reply = this.retryOrError(waiter);
      if (reply !== undefined && !(reply instanceof RespError) && argv) {
        propagator.record(client.dbIndex, argv, reply, server.persistence.dirty - dirtyBefore);
        if (before) {
          const meta = CommandService.lookupCommand(argv).meta;
          server.keyspace.notifyCommand(client.dbIndex, name, argv.slice(1), reply, before, { write: true, noop: false, meta });
        }
      }
      return reply;
    } finally {
      server.tracking.current = null;
      propagator.exit();
    }
  }

  /** A blocked command is re-checked against the ACLs before it is served (Redis reprocesses it): NOPERM when revoked. */
  private rejectBlockedByAcl(waiter: Waiter): boolean {
    const { client, argv } = waiter;
    if (!argv || !client.user) return false;
    const { meta } = CommandService.lookupCommand(argv);
    const denial = meta ? this.server.aclDenial(client, argv, meta) : null;
    if (!denial || !meta) return false;
    this.unblock(waiter);
    this.server.aclLogDenial(client, denial, 'toplevel');
    this.server.observer.commandStat(meta.fullname).rejected++;
    this.server.observer.replyError(client, AclService.noPermError(denial, client.user.name));
    return true;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Parks a client on the keys of a Block; its timeout (if any) answers the timeout reply. */
  block(client: Client, block: Block, argv?: string[]): void {
    const waiter: Waiter = {
      argv,
      client,
      dbKeys: block.keys.map((k) => `${client.dbIndex}:${k}`),
      retry: block.retry,
      timeoutReply: block.timeoutReply,
      timer: null,
      done: false,
    };
    for (const k of waiter.dbKeys) {
      const list = this.waiters.get(k);
      if (list) list.push(waiter);
      else this.waiters.set(k, [waiter]);
    }
    if (block.timeoutMs > 0) {
      const fire = (): void => {
        if (waiter.done) return;
        this.unblock(waiter);
        client.write(block.timeoutReply);
        this.server.connections.drain(client);
        this.serveReadyKeys();
      };
      // a Node timer fires at once past 2^31-1 ms: longer timeouts are armed in steps
      const deadline = Date.now() + block.timeoutMs;
      const arm = (): void => {
        if (waiter.done) return;
        const left = deadline - Date.now();
        waiter.timer = left > MAX_TIMER_MS ? setTimeout(arm, MAX_TIMER_MS) : setTimeout(fire, Math.max(0, left));
      };
      arm();
    }
    client.blocked = waiter;
  }

  unblock(waiter: Waiter): void {
    waiter.done = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    for (const k of waiter.dbKeys) {
      const list = this.waiters.get(k);
      if (!list) continue;
      const i = list.indexOf(waiter);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.waiters.delete(k);
    }
    if (waiter.client.blocked === waiter) waiter.client.blocked = null;
  }

  /** CLIENT UNBLOCK: answers the blocked client with its timeout reply, or an UNBLOCKED error. */
  unblockClient(client: Client, withError: boolean): boolean {
    const waiter = client.blocked;
    if (!waiter) return false;
    this.unblock(waiter);
    client.write(withError ? new RespError(ServerMessages.UNBLOCKED) : waiter.timeoutReply);
    setImmediate(() => this.server.connections.drain(client));
    return true;
  }

  /** Answers a blocked client with `reply` (a wait that ends outside the key machinery: WAIT) and runs its next commands. */
  release(client: Client, reply: Reply): void {
    const waiter = client.blocked;
    if (!waiter) return;
    this.unblock(waiter);
    client.write(reply);
    this.server.connections.drain(client);
  }

  /** A key changed: clients waiting on it are served after the current command. */
  keyChanged(dbIndex: number, key: string): void {
    if (!this.waiters.size) return;
    const dbKey = `${dbIndex}:${key}`;
    if (this.waiters.has(dbKey)) this.readyKeys.add(dbKey);
  }

  /** SWAPDB: clients waiting on keys of `a` or `b` that now exist are served. */
  databasesSwapped(a: number, b: number): void {
    for (const k of this.waiters.keys()) {
      const sep = k.indexOf(':');
      const db = Number(k.slice(0, sep));
      if ((db === a || db === b) && this.server.databases[db].peek(k.slice(sep + 1)) !== undefined) this.readyKeys.add(k);
    }
  }

  /** Serves clients blocked on keys that changed, FIFO per key, until nothing more can be served. */
  serveReadyKeys(): void {
    if (this.servingReady) return;
    this.servingReady = true;
    const released: Client[] = [];
    try {
      while (this.readyKeys.size) {
        const keys = [...this.readyKeys];
        this.readyKeys.clear();
        for (const k of keys) {
          const list = this.waiters.get(k);
          if (!list) continue;
          for (const waiter of [...list]) {
            if (waiter.done) continue;
            if (this.rejectBlockedByAcl(waiter)) {
              released.push(waiter.client);
              continue;
            }
            if (!this.holdsWaitedType(waiter, k)) continue;
            const reply = this.retryBlocked(waiter);
            if (reply === undefined) continue;
            this.unblock(waiter);
            if (reply instanceof RespError) this.server.observer.replyError(waiter.client, reply.message);
            else waiter.client.write(reply);
            TrackingService.flushDeferred(this.server.tracking, waiter.client);
            released.push(waiter.client);
          }
        }
      }
    } finally {
      this.servingReady = false;
    }
    for (const client of released) this.server.connections.drain(client);
    if (this.readyKeys.size) this.serveReadyKeys();
  }

  /** Server close: every timeout is cleared and every waiter forgotten. */
  clear(): void {
    for (const list of this.waiters.values()) for (const w of list) if (w.timer) clearTimeout(w.timer);
    this.waiters.clear();
  }
}
