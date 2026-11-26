import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService, { NO_REPLY } from '@/modules/command/command.service';
import type { CommandContext, HandlerResult } from '@/modules/command/command.types';

import type { BgsaveInput, ShutdownInput, WaitAofInput, WaitInput } from './server.dto';
import ServerMessages from './server.messages';

/** Server administration: TIME, DBSIZE, ROLE, FLUSHDB / FLUSHALL, MONITOR, persistence commands, SHUTDOWN, WAIT. */
export default class ServerAdminService {
  // ──────────────────────────────────────────────
  // Public Methods: information
  // ──────────────────────────────────────────────

  /** TIME: unix seconds and microseconds. */
  static time(): Reply {
    const us = BigInt(Date.now()) * 1000n + BigInt(Math.floor((performance.now() % 1) * 1000));
    return [String(us / 1000000n), String(us % 1000000n)];
  }

  /** DBSIZE: the stored keys, expired ones that were not reclaimed yet included (as Redis counts them). */
  static dbSize(ctx: CommandContext): Reply {
    return ctx.db.storedKeys;
  }

  /** MODULE LIST: redis-lite loads no module (its time series commands are built in). */
  static moduleList(): Reply {
    return [];
  }

  /** MODULE LOAD / LOADEX / UNLOAD: refused, as with `enable-module-command no`. */
  static moduleNotAllowed(): Reply {
    throw new AppError(ServerMessages.MODULE_NOT_ALLOWED);
  }

  static moduleHelp(): Reply {
    return CommandService.helpReply('module');
  }

  /** ROLE: the replication role (the replication runtime answers). */
  static role(ctx: CommandContext): Reply {
    return ctx.server.replication.roleReply();
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

  /** WAIT numreplicas timeout: blocks until that many replicas acknowledged the client's last write (or the timeout). */
  static wait(ctx: CommandContext, { numreplicas, timeout }: WaitInput): HandlerResult {
    return ctx.server.replication.wait(ctx.client, numreplicas, timeout, ctx.noBlock);
  }

  /** WAITAOF numlocal numreplicas timeout: the local AOF counts as fsynced while it is on; replicas answer with FACK. */
  static waitAof(ctx: CommandContext, { numlocal, numreplicas, timeout }: WaitAofInput): HandlerResult {
    return ctx.server.replication.waitAof(ctx.client, numlocal, numreplicas, timeout, ctx.noBlock);
  }
}
