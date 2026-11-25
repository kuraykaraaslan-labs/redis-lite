import { AppError } from '@/libs/app-error';
import { OK, PONG, RespError, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { EchoInput, PingInput, SelectInput } from './connection.dto';
import ConnectionMessages from './connection.messages';

/** The connection's session: PING, ECHO, SELECT, RESET, QUIT and the cluster-only READONLY / READWRITE. */
export default class ConnectionSessionService {
  /** PING [message]: in RESP2 subscriber mode the reply is a `pong` array, as Redis sends it there. */
  static ping(ctx: CommandContext, { message }: PingInput): Reply {
    if (ctx.client.subscriptionCount > 0 && ctx.client.resp === 2) return ['pong', message ?? ''];
    return message !== undefined ? message : PONG;
  }

  static echo(_ctx: CommandContext, { message }: EchoInput): string {
    return message;
  }

  /** SELECT: the index must name one of the server's databases. */
  static select(ctx: CommandContext, { index }: SelectInput): Reply {
    if (index < 0 || index >= ctx.server.databases.length) throw new AppError(ConnectionMessages.DB_INDEX);
    ctx.client.dbIndex = index;
    return OK;
  }

  /** QUIT is answered by the dispatcher before it gets here (inside a script or EXEC it is a plain OK). */
  static quit(): Reply {
    return OK;
  }

  /** READONLY / READWRITE only make sense in cluster mode. */
  static clusterOnly(): Reply {
    return new RespError(ConnectionMessages.CLUSTER_DISABLED);
  }

  /** RESET: back to a fresh connection's state (transaction, subscriptions, MONITOR, db, name, protocol, tracking, auth). */
  static reset(ctx: CommandContext): Reply {
    const c = ctx.client;
    c.multi = null;
    c.multiError = false;
    c.watched.clear();
    for (const ch of [...c.channels]) ctx.server.unsubscribe(c, ch, false);
    for (const p of [...c.patterns]) ctx.server.unsubscribe(c, p, true);
    for (const ch of [...c.shardChannels]) ctx.server.sunsubscribe(c, ch);
    if (c.monitor) {
      c.monitor = false;
      ctx.server.monitors.delete(c);
    }
    c.dbIndex = 0;
    c.name = '';
    c.resp = 2;
    c.noTouch = false;
    c.noEvict = false;
    ctx.server.tracking.disable(c);
    c.replyOff = false;
    c.skipNext = false;
    c.skipCurrent = false;
    // clientSetDefaultAuth()
    c.user = ctx.server.defaultUser;
    c.authenticated = ctx.server.acl.defaultLoginAllowed();
    return new Status(ConnectionMessages.RESET_STATUS);
  }
}
