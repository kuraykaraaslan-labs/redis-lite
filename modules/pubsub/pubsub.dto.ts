import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { RespMessages } from '@/libs/resp/messages';
import { ValueSchema, reject } from '@/libs/schemas';

import PubSubMessages from './pubsub.messages';

/**
 * Argument grammar of the pub/sub commands. Each DTO parses the arguments after the command name (`args`). Checks that
 * need the client's state (MULTI, DENY BLOCKING) stay in the service.
 */

// ============================================================================
// Subscription DTOs: (P|S)SUBSCRIBE, (P|S)UNSUBSCRIBE
// ============================================================================

/** A channel (or pattern) list; the UNSUBSCRIBE forms accept an empty one (= every current subscription). */
const ChannelsDTO = z.array(ValueSchema).transform((channels) => ({ channels }));

export const SubscribeDTO = ChannelsDTO;
export const UnsubscribeDTO = ChannelsDTO;

// ============================================================================
// Publish DTOs: PUBLISH, SPUBLISH
// ============================================================================

export const PublishDTO = z.tuple([ValueSchema, ValueSchema]).transform(([channel, message]) => ({ channel, message }));

// ============================================================================
// Introspection DTO: PUBSUB
// ============================================================================

/** Arity of each PUBSUB subcommand, counted like Redis (`PUBSUB` + subcommand + arguments); negative = at least. */
const PUBSUB_ARITY: Record<string, number> = { channels: -2, numsub: -2, numpat: 2, shardchannels: -2, shardnumsub: -2, help: 2 };

/**
 * PUBSUB subcommand [arguments]: an unknown subcommand, then the subcommand's arity, then CHANNELS / SHARDCHANNELS's
 * single optional pattern.
 */
export const PubSubDTO = z.tuple([z.string()], ValueSchema).transform(([name, ...rest], ctx) => {
  const subcommand = name.toLowerCase();
  const arity = PUBSUB_ARITY[subcommand];
  if (arity === undefined) return reject(ctx, formatMessage(RespMessages.UNKNOWN_SUBCOMMAND, { subcommand: name, command: 'PUBSUB' }));
  const argc = rest.length + 2;
  if (arity > 0 ? argc !== arity : argc < -arity) return reject(ctx, formatMessage(PubSubMessages.SUBCOMMAND_ARITY, { subcommand }));
  if ((subcommand === 'channels' || subcommand === 'shardchannels') && rest.length > 1) {
    return reject(ctx, formatMessage(PubSubMessages.UNKNOWN_OR_ARITY, { subcommand: name }));
  }
  return { subcommand, pattern: rest[0] ?? '*', channels: rest };
});

// ============================================================================
// Type Exports
// ============================================================================

export type ChannelsInput = z.infer<typeof ChannelsDTO>;
export type PublishInput = z.infer<typeof PublishDTO>;
export type PubSubInput = z.infer<typeof PubSubDTO>;
