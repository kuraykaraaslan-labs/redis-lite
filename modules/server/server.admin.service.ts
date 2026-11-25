import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import { Block, NO_REPLY } from '@/modules/command/command.service';
import type { CommandContext, HandlerResult } from '@/modules/command/command.types';

import type { BgsaveInput, ShutdownInput, WaitAofInput, WaitInput } from './server.dto';
import ServerMessages from './server.messages';

/** Server administration: TIME, DBSIZE, ROLE, FLUSHDB / FLUSHALL, MONITOR, persistence commands, SHUTDOWN, WAIT. */
export default class ServerAdminService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** No replicas ever acknowledge: answers at once when nothing is required, otherwise after the timeout (0 = forever), like Redis. */
  private static waitFor(ctx: CommandContext, required: boolean, timeoutMs: number, reply: Reply): HandlerResult {
    if (!required || ctx.noBlock) return reply;
    return new Block([], timeoutMs, () => undefined, reply);
  }

  // ──────────────────────────────────────────────
  // Public Methods: information
  // ──────────────────────────────────────────────

  /** TIME: unix seconds and microseconds. */
  static time(): Reply {
    const us = BigInt(Date.now()) * 1000n + BigInt(Math.floor((performance.now() % 1) * 1000));
    return [String(us / 1000000n), String(us % 1000000n)];
  }

  static dbSize(ctx: CommandContext): Reply {
    return ctx.db.size;
  }

  /** ROLE: always a master without replicas. */
  static role(): Reply {
    return ['master', 0, []];
  }

  // ──────────────────────────────────────────────
  // Public Methods: keyspace and connections
  // ──────────────────────────────────────────────

  /** FLUSHDB (the caller's database) / FLUSHALL (every database); ASYNC and SYNC both flush at once. */
  static flush(ctx: CommandContext, all: boolean): Reply {
    const s = ctx.server;
    s.flushDatabases(all ? s.databases.map((_, i) => i) : [ctx.client.dbIndex], all);
    return OK;
  }

  /** MONITOR: the connection receives every command the server runs from now on. */
  static monitor(ctx: CommandContext): Reply {
    if (ctx.client.multi || ctx.noBlock) throw new AppError(ServerMessages.MONITOR_CONTEXT);
    ctx.client.monitor = true;
    ctx.server.monitors.add(ctx.client);
    return OK;
  }

  // ──────────────────────────────────────────────
  // Public Methods: persistence and shutdown
  // ──────────────────────────────────────────────

  static save(ctx: CommandContext): Reply {
    return ctx.server.persistence.saveCommand();
  }

  static bgsave(ctx: CommandContext, { schedule }: BgsaveInput): Reply {
    return ctx.server.persistence.bgsaveCommand({ schedule, inExec: ctx.client.inExec });
  }

  static bgrewriteaof(ctx: CommandContext): Reply {
    return ctx.server.persistence.bgrewriteaofCommand(ctx.client.inExec);
  }

  static lastsave(ctx: CommandContext): Reply {
    return ctx.server.persistence.lastsaveCommand();
  }

  /** SHUTDOWN: no reply when it goes ahead (the connection closes); ABORT has nothing to abort. */
  static shutdown(ctx: CommandContext, opts: ShutdownInput): typeof NO_REPLY {
    if (opts.abort) throw new AppError(ServerMessages.NO_SHUTDOWN_IN_PROGRESS);
    if (!ctx.server.shutdown(opts)) throw new AppError(ServerMessages.SHUTDOWN_FAILED);
    return NO_REPLY;
  }

  // ──────────────────────────────────────────────
  // Public Methods: replication
  // ──────────────────────────────────────────────

  /** WAIT numreplicas timeout: no replica ever acknowledges. */
  static wait(ctx: CommandContext, { numreplicas, timeout }: WaitInput): HandlerResult {
    return ServerAdminService.waitFor(ctx, numreplicas > 0, timeout, 0);
  }

  /** WAITAOF numlocal numreplicas timeout: the local fsync is acknowledged when the AOF is on. */
  static waitAof(ctx: CommandContext, { numlocal, numreplicas, timeout }: WaitAofInput): HandlerResult {
    if (numlocal && ctx.server.config.get('appendonly') !== 'yes') throw new AppError(ServerMessages.WAITAOF_APPENDONLY);
    return ServerAdminService.waitFor(ctx, numreplicas > 0, timeout, [numlocal ? 1 : 0, 0]);
  }
}
