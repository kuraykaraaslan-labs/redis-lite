import ConnectionAdminService from './connection.admin.service';
import ConnectionAuthService from './connection.auth.service';
import ConnectionClientService from './connection.client.service';
import ConnectionSessionService from './connection.session.service';

export { ConnectionAdminService, ConnectionAuthService, ConnectionClientService, ConnectionSessionService };

/** The connection module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class ConnectionService {
  // Session — PING, ECHO, SELECT, RESET, QUIT, READONLY / READWRITE
  static ping = ConnectionSessionService.ping.bind(ConnectionSessionService);
  static echo = ConnectionSessionService.echo.bind(ConnectionSessionService);
  static select = ConnectionSessionService.select.bind(ConnectionSessionService);
  static quit = ConnectionSessionService.quit.bind(ConnectionSessionService);
  static clusterOnly = ConnectionSessionService.clusterOnly.bind(ConnectionSessionService);
  static reset = ConnectionSessionService.reset.bind(ConnectionSessionService);

  // Auth — AUTH, HELLO
  static auth = ConnectionAuthService.auth.bind(ConnectionAuthService);
  static hello = ConnectionAuthService.hello.bind(ConnectionAuthService);

  // Client — the caller's own settings
  static setName = ConnectionClientService.setName.bind(ConnectionClientService);
  static getName = ConnectionClientService.getName.bind(ConnectionClientService);
  static id = ConnectionClientService.id.bind(ConnectionClientService);
  static help = ConnectionClientService.help.bind(ConnectionClientService);
  static noEvict = ConnectionClientService.noEvict.bind(ConnectionClientService);
  static reply = ConnectionClientService.reply.bind(ConnectionClientService);
  static pause = ConnectionClientService.pause.bind(ConnectionClientService);
  static unpause = ConnectionClientService.unpause.bind(ConnectionClientService);
  static getRedir = ConnectionClientService.getRedir.bind(ConnectionClientService);
  static trackingInfo = ConnectionClientService.trackingInfo.bind(ConnectionClientService);
  static tracking = ConnectionClientService.tracking.bind(ConnectionClientService);
  static caching = ConnectionClientService.caching.bind(ConnectionClientService);

  // Admin — CLIENT INFO, LIST, KILL, UNBLOCK
  static clientInfoLine = ConnectionAdminService.clientInfoLine.bind(ConnectionAdminService);
  static info = ConnectionAdminService.info.bind(ConnectionAdminService);
  static list = ConnectionAdminService.list.bind(ConnectionAdminService);
  static kill = ConnectionAdminService.kill.bind(ConnectionAdminService);
  static unblock = ConnectionAdminService.unblock.bind(ConnectionAdminService);
}
