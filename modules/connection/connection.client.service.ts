import { OK, RespMap, RespSet } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import { NO_REPLY } from '@/modules/command/command.handler';
import CommandService from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';
import { parseTrackingArgs } from '@/modules/tracking/tracking.core';

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

  /** CLIENT PAUSE / UNPAUSE are accepted and have no effect: one client is served at a time anyway. */
  static pause(_ctx: CommandContext, _input?: ClientPauseInput): Reply {
    return OK;
  }

  // ──────────────────────────────────────────────
  // Public Methods: client-side caching
  // ──────────────────────────────────────────────

  static getRedir(ctx: CommandContext): Reply {
    return ctx.client.tracking ? ctx.client.trackingRedirect : -1;
  }

  static trackingInfo(ctx: CommandContext): Reply {
    const info = ctx.server.tracking.info(ctx.client);
    return RespMap.from(['flags', new RespSet(info.flags), 'redirect', info.redirect, 'prefixes', info.prefixes]);
  }

  static tracking(ctx: CommandContext, { options }: ClientTrackingInput): Reply {
    ctx.server.tracking.configure(ctx.client, parseTrackingArgs(options));
    return OK;
  }

  static caching(ctx: CommandContext, { value }: ClientCachingInput): Reply {
    ctx.server.tracking.caching(ctx.client, value);
    return OK;
  }
}
