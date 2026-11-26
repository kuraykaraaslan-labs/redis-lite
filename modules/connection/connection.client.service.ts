import { OK, RespMap, RespSet } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService, { NO_REPLY } from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';
import TrackingService from '@/modules/tracking/tracking.service';

import type {
  ClientCachingInput,
  ClientOnOffInput,
  ClientPauseInput,
  ClientReplyInput,
  ClientSetInfoInput,
  ClientSetNameInput,
  ClientTrackingInput,
} from './connection.dto';

/** The calling connection's own settings: CLIENT SETNAME, GETNAME, ID, SETINFO, REPLY, NO-TOUCH, NO-EVICT, tracking… */
export default class ConnectionClientService {
  // ──────────────────────────────────────────────
  // Public Methods: identity
  // ──────────────────────────────────────────────

  static setName(ctx: CommandContext, { name }: ClientSetNameInput): Reply {
    ctx.client.name = name;
    return OK;
  }

  static getName(ctx: CommandContext): Reply {
    return ctx.client.name || null;
  }

  static id(ctx: CommandContext): Reply {
    return ctx.client.id;
  }

  static setInfo(ctx: CommandContext, { attr, value }: ClientSetInfoInput): Reply {
    if (attr === 'lib-name') ctx.client.libName = value;
    else ctx.client.libVer = value;
    return OK;
  }

  static help(): Reply {
    return CommandService.helpReply('client');
  }

  // ──────────────────────────────────────────────
  // Public Methods: behaviour
  // ──────────────────────────────────────────────

  static noTouch(ctx: CommandContext, { on }: ClientOnOffInput): Reply {
    ctx.client.noTouch = on;
    return OK;
  }

  static noEvict(ctx: CommandContext, { on }: ClientOnOffInput): Reply {
    ctx.client.noEvict = on;
    return OK;
  }

  /** CLIENT REPLY ON | OFF | SKIP: OFF and SKIP are not answered themselves. */
  static reply(ctx: CommandContext, { mode }: ClientReplyInput): Reply | typeof NO_REPLY {
    const c = ctx.client;
    if (mode === 'on') {
      c.replyOff = false;
      c.skipNext = false;
      c.skipCurrent = false;
      return OK;
    }
    if (mode === 'off') c.replyOff = true;
    else if (!c.replyOff) c.skipNext = true;
    return NO_REPLY;
  }

  /** CLIENT PAUSE timeout [WRITE|ALL]: normal clients' writes (or all their commands) wait for UNPAUSE or the timeout. */
  static pause(ctx: CommandContext, { timeout, mode }: ClientPauseInput): Reply {
    ctx.server.pauseClients(mode, timeout);
    return OK;
  }

  /** CLIENT UNPAUSE: paused clients run their held commands. */
  static unpause(ctx: CommandContext): Reply {
    ctx.server.unpauseClients();
    return OK;
  }

  // ──────────────────────────────────────────────
  // Public Methods: client-side caching
  // ──────────────────────────────────────────────

  static getRedir(ctx: CommandContext): Reply {
    return ctx.client.tracking ? ctx.client.trackingRedirect : -1;
  }

  static trackingInfo(ctx: CommandContext): Reply {
    const info = TrackingService.info(ctx.client);
    return RespMap.from(['flags', new RespSet(info.flags), 'redirect', info.redirect, 'prefixes', info.prefixes]);
  }

  static tracking(ctx: CommandContext, input: ClientTrackingInput): Reply {
    TrackingService.configure(ctx.server.tracking, ctx.client, input);
    return OK;
  }

  static caching(ctx: CommandContext, input: ClientCachingInput): Reply {
    TrackingService.caching(ctx.client, input);
    return OK;
  }
}
