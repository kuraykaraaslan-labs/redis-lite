import { AppError } from '@/libs/app-error';
import { matchGlob } from '@/libs/glob';
import { formatMessage } from '@/libs/message-format';
import { RespMap, RespPush } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import { NO_REPLY } from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';

import type { ChannelsInput, PubSubInput, PublishInput } from './pubsub.dto';
import PubSubMessages from './pubsub.messages';

/**
 * Pub/sub: channel, pattern and shard-channel subscriptions, PUBLISH / SPUBLISH and PUBSUB introspection. The
 * (UN)SUBSCRIBE family writes one push reply per channel itself and answers NO_REPLY.
 */
export default class PubSubService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Channel + pattern subscriptions: what SUBSCRIBE/UNSUBSCRIBE replies report (shard channels are counted apart). */
  private static classicCount(ctx: CommandContext): number {
    return ctx.client.channels.size + ctx.client.patterns.size;
  }

  /** Subscribing is refused inside MULTI and where the client cannot block (scripts). */
  private static checkCanSubscribe(ctx: CommandContext, command: string): void {
    if (ctx.client.multi || ctx.noBlock) throw new AppError(formatMessage(PubSubMessages.DENY_BLOCKING, { command }));
  }

  private static subscribeTo(ctx: CommandContext, { channels }: ChannelsInput, pattern: boolean): typeof NO_REPLY {
    PubSubService.checkCanSubscribe(ctx, pattern ? 'PSUBSCRIBE' : 'SUBSCRIBE');
    for (const channel of channels) {
      ctx.server.subscribe(ctx.client, channel, pattern);
      ctx.client.write(new RespPush([pattern ? 'psubscribe' : 'subscribe', channel, PubSubService.classicCount(ctx)]));
    }
    return NO_REPLY;
  }

  /** No channel given = every current subscription; with none at all, one reply with a null channel. */
  private static unsubscribeFrom(ctx: CommandContext, { channels }: ChannelsInput, pattern: boolean): typeof NO_REPLY {
    const current = pattern ? ctx.client.patterns : ctx.client.channels;
    const targets = channels.length ? channels : [...current];
    const kind = pattern ? 'punsubscribe' : 'unsubscribe';
    if (!targets.length) {
      ctx.client.write(new RespPush([kind, null, PubSubService.classicCount(ctx)]));
      return NO_REPLY;
    }
    for (const channel of targets) {
      ctx.server.unsubscribe(ctx.client, channel, pattern);
      ctx.client.write(new RespPush([kind, channel, PubSubService.classicCount(ctx)]));
    }
    return NO_REPLY;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  static subscribe(ctx: CommandContext, input: ChannelsInput): typeof NO_REPLY {
    return PubSubService.subscribeTo(ctx, input, false);
  }

  static pSubscribe(ctx: CommandContext, input: ChannelsInput): typeof NO_REPLY {
    return PubSubService.subscribeTo(ctx, input, true);
  }

  static unsubscribe(ctx: CommandContext, input: ChannelsInput): typeof NO_REPLY {
    return PubSubService.unsubscribeFrom(ctx, input, false);
  }

  static pUnsubscribe(ctx: CommandContext, input: ChannelsInput): typeof NO_REPLY {
    return PubSubService.unsubscribeFrom(ctx, input, true);
  }

  /** SSUBSCRIBE: replies count shard channels only. */
  static sSubscribe(ctx: CommandContext, { channels }: ChannelsInput): typeof NO_REPLY {
    PubSubService.checkCanSubscribe(ctx, 'SSUBSCRIBE');
    for (const channel of channels) {
      ctx.server.ssubscribe(ctx.client, channel);
      ctx.client.write(new RespPush(['ssubscribe', channel, ctx.client.shardChannels.size]));
    }
    return NO_REPLY;
  }

  /** SUNSUBSCRIBE: no channel given = every current shard subscription. */
  static sUnsubscribe(ctx: CommandContext, { channels }: ChannelsInput): typeof NO_REPLY {
    const targets = channels.length ? channels : [...ctx.client.shardChannels];
    if (!targets.length) ctx.client.write(new RespPush(['sunsubscribe', null, 0]));
    for (const channel of targets) {
      ctx.server.sunsubscribe(ctx.client, channel);
      ctx.client.write(new RespPush(['sunsubscribe', channel, ctx.client.shardChannels.size]));
    }
    return NO_REPLY;
  }

  /** PUBLISH: the number of clients that received the message. */
  static publish(ctx: CommandContext, { channel, message }: PublishInput): Reply {
    return ctx.server.publish(channel, message);
  }

  static sPublish(ctx: CommandContext, { channel, message }: PublishInput): Reply {
    return ctx.server.spublish(channel, message);
  }

  /** PUBSUB CHANNELS | NUMSUB | NUMPAT | SHARDCHANNELS | SHARDNUMSUB | HELP. */
  static introspect(ctx: CommandContext, { subcommand, pattern, channels }: PubSubInput): Reply {
    if (subcommand === 'help') return [...PubSubMessages.HELP];
    if (subcommand === 'channels') return [...ctx.server.channels.keys()].filter((c) => matchGlob(pattern, c));
    if (subcommand === 'numsub') return new RespMap(channels.map((c) => [c, ctx.server.channels.get(c)?.size ?? 0]));
    if (subcommand === 'numpat') return ctx.server.patterns.size;
    if (subcommand === 'shardchannels') return [...ctx.server.shardChannels.keys()].filter((c) => matchGlob(pattern, c));
    return new RespMap(channels.map((c) => [c, ctx.server.shardChannels.get(c)?.size ?? 0]));
  }
}
