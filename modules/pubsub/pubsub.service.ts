import { AppError } from '@/libs/app-error';
import { matchGlob } from '@/libs/glob';
import { formatMessage } from '@/libs/message-format';
import { RespPush, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import { NO_REPLY } from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';
import TransactionsService from '@/modules/transactions/transactions.service';

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

  /**
   * Subscribing is refused where the client cannot block (scripts). Redis 7.0 lets SUBSCRIBE / PSUBSCRIBE run inside
   * EXEC (`inExec`), but not SSUBSCRIBE.
   */
  private static checkCanSubscribe(ctx: CommandContext, command: string, allowedInExec: boolean): void {
    if (ctx.client.multi || (ctx.noBlock && !(allowedInExec && ctx.client.inExec))) {
      throw new AppError(formatMessage(PubSubMessages.DENY_BLOCKING, { command }));
    }
  }

  /** One (un)subscribe confirmation: written to the client, or added to EXEC's reply when run inside a transaction. */
  private static send(ctx: CommandContext, push: RespPush): void {
    if (!TransactionsService.inlineReply(ctx.client, push)) ctx.client.write(push);
  }

  private static subscribeTo(ctx: CommandContext, { channels }: ChannelsInput, pattern: boolean): typeof NO_REPLY {
    PubSubService.checkCanSubscribe(ctx, pattern ? 'PSUBSCRIBE' : 'SUBSCRIBE', true);
    for (const channel of channels) {
      ctx.server.subscribe(ctx.client, channel, pattern);
      PubSubService.send(ctx, new RespPush([pattern ? 'psubscribe' : 'subscribe', channel, PubSubService.classicCount(ctx)]));
    }
    return NO_REPLY;
  }

  /** No channel given = every current subscription; with none at all, one reply with a null channel. */
  private static unsubscribeFrom(ctx: CommandContext, { channels }: ChannelsInput, pattern: boolean): typeof NO_REPLY {
    const current = pattern ? ctx.client.patterns : ctx.client.channels;
    const targets = channels.length ? channels : [...current];
    const kind = pattern ? 'punsubscribe' : 'unsubscribe';
    if (!targets.length) {
      PubSubService.send(ctx, new RespPush([kind, null, PubSubService.classicCount(ctx)]));
      return NO_REPLY;
    }
    for (const channel of targets) {
      ctx.server.unsubscribe(ctx.client, channel, pattern);
      PubSubService.send(ctx, new RespPush([kind, channel, PubSubService.classicCount(ctx)]));
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
    PubSubService.checkCanSubscribe(ctx, 'SSUBSCRIBE', false);
    for (const channel of channels) {
      ctx.server.ssubscribe(ctx.client, channel);
      PubSubService.send(ctx, new RespPush(['ssubscribe', channel, ctx.client.shardChannels.size]));
    }
    return NO_REPLY;
  }

  /** SUNSUBSCRIBE: no channel given = every current shard subscription. */
  static sUnsubscribe(ctx: CommandContext, { channels }: ChannelsInput): typeof NO_REPLY {
    const targets = channels.length ? channels : [...ctx.client.shardChannels];
    if (!targets.length) PubSubService.send(ctx, new RespPush(['sunsubscribe', null, 0]));
    for (const channel of targets) {
      ctx.server.sunsubscribe(ctx.client, channel);
      PubSubService.send(ctx, new RespPush(['sunsubscribe', channel, ctx.client.shardChannels.size]));
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
    if (subcommand === 'help') return PubSubMessages.HELP.map((line) => new Status(line));
    if (subcommand === 'channels') return [...ctx.server.channels.keys()].filter((c) => matchGlob(pattern, c));
    // NUMSUB / SHARDNUMSUB are flat channel, count arrays in RESP3 too (Redis does not send them as maps)
    if (subcommand === 'numsub') return channels.flatMap((c) => [c, ctx.server.channels.get(c)?.size ?? 0]);
    if (subcommand === 'numpat') return ctx.server.patterns.size;
    if (subcommand === 'shardchannels') return [...ctx.server.shardChannels.keys()].filter((c) => matchGlob(pattern, c));
    return channels.flatMap((c) => [c, ctx.server.shardChannels.get(c)?.size ?? 0]);
  }
}
