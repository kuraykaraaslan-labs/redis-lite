import { withDTO } from '@/modules/command/command.handler';
import type { CommandSpec } from '@/modules/command/command.types';

import { PubSubDTO, PublishDTO, SubscribeDTO, UnsubscribeDTO } from './pubsub.dto';
import PubSubService from './pubsub.service';

/** Routing of the pub/sub commands: name, arity and flags, then DTO → service. No logic lives here. */

const PUBSUB = { pubsub: true, noscript: true } as const;

export const pubsubCommands: CommandSpec[] = [
  { name: 'subscribe', arity: -2, flags: PUBSUB, handler: withDTO(SubscribeDTO, PubSubService.subscribe) },
  { name: 'psubscribe', arity: -2, flags: PUBSUB, handler: withDTO(SubscribeDTO, PubSubService.pSubscribe) },
  { name: 'unsubscribe', arity: -1, flags: PUBSUB, handler: withDTO(UnsubscribeDTO, PubSubService.unsubscribe) },
  { name: 'punsubscribe', arity: -1, flags: PUBSUB, handler: withDTO(UnsubscribeDTO, PubSubService.pUnsubscribe) },
  { name: 'ssubscribe', arity: -2, flags: PUBSUB, handler: withDTO(SubscribeDTO, PubSubService.sSubscribe) },
  { name: 'sunsubscribe', arity: -1, flags: PUBSUB, handler: withDTO(UnsubscribeDTO, PubSubService.sUnsubscribe) },
  { name: 'spublish', arity: 3, handler: withDTO(PublishDTO, PubSubService.sPublish) },
  { name: 'publish', arity: 3, handler: withDTO(PublishDTO, PubSubService.publish) },
  { name: 'pubsub', arity: -2, handler: withDTO(PubSubDTO, PubSubService.introspect) },
];
