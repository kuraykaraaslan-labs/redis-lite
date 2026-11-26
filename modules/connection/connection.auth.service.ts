import { AppError } from '@/libs/app-error';
import { OK, RespError, RespMap } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import ServerService from '@/modules/server/server.service';

import type { AuthInput, HelloInput } from './connection.dto';
import ConnectionMessages from './connection.messages';

/** Authentication and handshake: AUTH, HELLO. */
export default class ConnectionAuthService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** ACLAuthenticateUser(): OK, or WRONGPASS with an `auth` ACL LOG entry (object = the command name as sent). */
  private static authenticate(ctx: CommandContext, username: string, password: string): Reply {
    const { server, client } = ctx;
    const user = server.acl.authenticate(username, password) ? server.acl.user(username) : undefined;
    if (!user) {
      server.aclLog(client, { reason: 'auth', context: server.aclContext(client), object: ctx.name ?? 'AUTH', username });
      return new RespError(ConnectionMessages.WRONGPASS);
    }
    client.user = user;
    client.authenticated = true;
    return OK;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** AUTH [username] password. The one-argument form needs the default user to have a password. */
  static auth(ctx: CommandContext, { username, password }: AuthInput): Reply {
    if (username === null) {
      if (ctx.server.defaultUser.nopass) throw new AppError(ConnectionMessages.AUTH_NO_PASSWORD);
      return ConnectionAuthService.authenticate(ctx, 'default', password);
    }
    return ConnectionAuthService.authenticate(ctx, username, password);
  }

  /** HELLO: authenticates (AUTH option), then requires an authenticated client before switching protocol / name. */
  static hello(ctx: CommandContext, { protocol, auth, name }: HelloInput): Reply {
    if (auth) {
      const r = ConnectionAuthService.authenticate(ctx, auth.username, auth.password);
      if (r instanceof RespError) return r;
    }
    if (!ctx.client.authenticated) return new RespError(ConnectionMessages.HELLO_NOAUTH);
    if (name !== null) ctx.client.name = name;
    if (protocol !== null) ctx.client.resp = protocol;
    return RespMap.from([
      'server', 'redis', 'version', ServerService.REDIS_VERSION, 'proto', ctx.client.resp, 'id', ctx.client.id, 'mode', 'standalone', 'role', ctx.server.replication.role === 'slave' ? 'replica' : 'master',
      'modules', [],
    ]);
  }
}
