import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { OK, RespError, RespVerbatim } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import type { Client, RedisLiteServer } from '@/modules/server/server.service';

import type { ClientKillInput, ClientListInput, ClientUnblockInput } from './connection.dto';
import ConnectionMessages from './connection.messages';
import type { ClientKillFilters } from './connection.types';

/** Inspection and administration of connections: CLIENT INFO, LIST, KILL, UNBLOCK and the client info line. */
export default class ConnectionAdminService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** CLIENT LIST `flags=` (Redis catClientInfoString). */
  private static clientFlags(c: Client): string {
    let f = '';
    if (c.replica?.attached) f += c.monitor ? 'O' : 'S';
    else if (c.monitor) f += 'O';
    if (c.isMaster) f += 'M';
    if (c.subscriptionCount) f += 'P';
    if (c.multi) f += 'x';
    if (c.blocked) f += 'b';
    if (c.tracking) f += 't';
    if (c.trackingRedirectBroken) f += 'R';
    if (c.trackingBcast) f += 'B';
    if (c.closeAfterReply) f += 'c';
    if (c.noEvict) f += 'e';
    if (c.noTouch) f += 'T';
    return f || 'N';
  }

  /** Redis getClientType(): monitors count as normal clients. */
  private static clientType(c: Client): string {
    if (c.isMaster) return 'master';
    if (c.replica?.attached && !c.monitor) return 'replica';
    return c.subscriptionCount ? 'pubsub' : 'normal';
  }

  private static localAddress(server: RedisLiteServer, c: Client): string {
    const s = c.socket;
    return s ? `${s.localAddress ?? server.options.host}:${s.localPort ?? server.options.port}` : `${server.options.host}:${server.options.port}`;
  }

  /** Closes a connection: the caller after its reply, any other one right away. */
  private static close(ctx: CommandContext, target: Client): void {
    if (target === ctx.client) ctx.client.closeAfterReply = true;
    else ctx.server.killClient(target);
  }

  /** Whether a connection passes every CLIENT KILL filter (`user` already resolved). */
  private static matches(ctx: CommandContext, c: Client, filters: ClientKillFilters, user: Client['user'], now: number): boolean {
    if (filters.id !== null && c.id !== filters.id) return false;
    if (filters.type !== null && ConnectionAdminService.clientType(c) !== filters.type) return false;
    if (filters.addr !== null && c.address !== filters.addr) return false;
    if (filters.laddr !== null && ConnectionAdminService.localAddress(ctx.server, c) !== filters.laddr) return false;
    if (user !== null && c.user !== user) return false;
    if (filters.maxAge !== null && Math.floor((now - c.createdAt) / 1000) <= filters.maxAge) return false;
    return !(filters.skipMe && c === ctx.client);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** One CLIENT LIST / CLIENT INFO line (Redis catClientInfoString). */
  static clientInfoLine(server: RedisLiteServer, c: Client): string {
    const now = Date.now();
    const multiMem = c.multi ? c.multi.reduce((n, argv) => n + argv.reduce((m, a) => m + a.length, 0), 0) : 0;
    return (
      `id=${c.id} addr=${c.address} laddr=${ConnectionAdminService.localAddress(server, c)} fd=${c.socket ? c.id + 7 : -1} name=${c.name} ` +
      `age=${Math.floor((now - c.createdAt) / 1000)} idle=${Math.floor((now - c.lastActiveAt) / 1000)} flags=${ConnectionAdminService.clientFlags(c)} ` +
      `db=${c.dbIndex} sub=${c.channels.size} psub=${c.patterns.size} ssub=${c.shardChannels.size} multi=${c.multi ? c.multi.length : -1} ` +
      `watch=${c.watched.size} qbuf=0 qbuf-free=0 argv-mem=0 multi-mem=${multiMem} rbs=1024 rbp=0 obl=0 oll=0 omem=0 tot-mem=${1024 + multiMem} ` +
      `events=r cmd=${c.lastCommand} user=${c.user ? c.user.name : '(superuser)'} redir=${c.tracking ? c.trackingRedirect : -1} resp=${c.resp} ` +
      `lib-name=${c.libName} lib-ver=${c.libVer} io-thread=0 tot-net-in=${c.netIn} tot-net-out=${c.netOut} tot-cmds=${c.commandsProcessed}`
    );
  }

  static info(ctx: CommandContext): Reply {
    return new RespVerbatim(`${ConnectionAdminService.clientInfoLine(ctx.server, ctx.client)}\n`);
  }

  /** CLIENT LIST, optionally filtered by type or by ids (unknown ids are skipped). */
  static list(ctx: CommandContext, { type, ids }: ClientListInput): Reply {
    let clients = [...ctx.server.clients];
    if (type !== null) clients = clients.filter((c) => ConnectionAdminService.clientType(c) === type);
    else if (ids !== null) {
      const byId = new Map(clients.map((c) => [c.id, c]));
      clients = [];
      for (const id of ids) {
        const c = byId.get(id);
        if (c) clients.push(c);
      }
    }
    return new RespVerbatim(clients.map((c) => `${ConnectionAdminService.clientInfoLine(ctx.server, c)}\n`).join(''));
  }

  /**
   * CLIENT KILL: the old form kills the connection from `address` (the caller included) and answers OK; the option form
   * answers how many connections matched. USER values are checked in order, before a grammar error found after them.
   */
  static kill(ctx: CommandContext, { address, filters, error }: ClientKillInput): Reply {
    if (address !== null) {
      const target = [...ctx.server.clients].find((c) => c.address === address);
      if (!target) throw new AppError(ConnectionMessages.NO_SUCH_CLIENT);
      ConnectionAdminService.close(ctx, target);
      return OK;
    }
    let user: Client['user'] = null;
    for (const name of filters.users) {
      user = ctx.server.acl.user(name) ?? null;
      if (!user) throw new AppError(formatMessage(ConnectionMessages.NO_SUCH_USER, { user: name }));
    }
    if (error !== null) return new RespError(error);
    const now = Date.now();
    let killed = 0;
    for (const c of [...ctx.server.clients]) {
      if (!ConnectionAdminService.matches(ctx, c, filters, user, now)) continue;
      ConnectionAdminService.close(ctx, c);
      killed++;
    }
    return killed;
  }

  /** CLIENT UNBLOCK: 1 when the client was blocked and got its timeout reply (or an UNBLOCKED error), else 0. */
  static unblock(ctx: CommandContext, { id, withError }: ClientUnblockInput): Reply {
    const target = [...ctx.server.clients].find((x) => x.id === id);
    return target && ctx.server.unblockClient(target, withError) ? 1 : 0;
  }
}
