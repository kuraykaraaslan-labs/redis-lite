import { CommandError } from '../errors';
import { unknownSubcommand } from '../messages';
import type { Reply } from '../resp';
import { RespMap, RespPush } from '../resp';
import { matchGlob } from '../util';
import type { CommandContext, CommandSpec } from './types';
import { NO_REPLY } from './types';

/** Channel + pattern subscriptions: what SUBSCRIBE/UNSUBSCRIBE replies report (shard channels are counted apart). */
function classicCount(ctx: CommandContext): number {
  return ctx.client.channels.size + ctx.client.patterns.size;
}

const PUBSUB_ARITY: Record<string, number> = { channels: -2, numsub: -2, numpat: 2, shardchannels: -2, shardnumsub: -2, help: 2 };

const PUBSUB_HELP = [
  'PUBSUB <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
  'CHANNELS [<pattern>]',
  "    Return the currently active channels matching a <pattern> (default: '*').",
  'NUMPAT',
  '    Return number of subscriptions to patterns.',
  'NUMSUB [<channel> ...]',
  '    Return the number of subscribers for the specified channels, excluding',
  '    pattern subscriptions(default: no channels).',
  'SHARDCHANNELS [<pattern>]',
  "    Return the currently active shard level channels matching a <pattern> (default: '*').",
  'SHARDNUMSUB [<shardchannel> ...]',
  '    Return the number of subscribers for the specified shard level channel(s)',
  'HELP',
  '    Print this help.',
];

function pubsub(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  const arity = PUBSUB_ARITY[sub];
  if (arity === undefined) throw new CommandError(unknownSubcommand(args[0], 'pubsub'));
  const argc = args.length + 1;
  if (arity > 0 ? argc !== arity : argc < -arity) throw new CommandError(`ERR wrong number of arguments for 'pubsub|${sub}' command`);
  if ((sub === 'channels' || sub === 'shardchannels') && args.length > 2) {
    throw new CommandError(`ERR unknown subcommand or wrong number of arguments for '${args[0]}'. Try PUBSUB HELP.`);
  }
  if (sub === 'help') return PUBSUB_HELP;
  if (sub === 'channels') return [...ctx.server.channels.keys()].filter((c) => matchGlob(args[1] ?? '*', c));
  if (sub === 'numsub') return new RespMap(args.slice(1).map((c) => [c, ctx.server.channels.get(c)?.size ?? 0]));
  if (sub === 'numpat') return ctx.server.patterns.size;
  if (sub === 'shardchannels') return [...ctx.server.shardChannels.keys()].filter((c) => matchGlob(args[1] ?? '*', c));
  return new RespMap(args.slice(1).map((c) => [c, ctx.server.shardChannels.get(c)?.size ?? 0]));
}

function subscribe(ctx: CommandContext, args: string[], pattern: boolean): typeof NO_REPLY {
  if (ctx.client.multi || ctx.noBlock) throw new CommandError(`ERR ${pattern ? 'PSUBSCRIBE' : 'SUBSCRIBE'} isn't allowed for a DENY BLOCKING client`);
  for (const channel of args) {
    ctx.server.subscribe(ctx.client, channel, pattern);
    ctx.client.write(new RespPush([pattern ? 'psubscribe' : 'subscribe', channel, classicCount(ctx)]));
  }
  return NO_REPLY;
}

function unsubscribe(ctx: CommandContext, args: string[], pattern: boolean): typeof NO_REPLY {
  const current = pattern ? ctx.client.patterns : ctx.client.channels;
  const targets = args.length ? args : [...current];
  const kind = pattern ? 'punsubscribe' : 'unsubscribe';
  if (!targets.length) {
    ctx.client.write(new RespPush([kind, null, classicCount(ctx)]));
    return NO_REPLY;
  }
  for (const channel of targets) {
    ctx.server.unsubscribe(ctx.client, channel, pattern);
    ctx.client.write(new RespPush([kind, channel, classicCount(ctx)]));
  }
  return NO_REPLY;
}

export const pubsubCommands: CommandSpec[] = [
  { name: 'subscribe', arity: -2, flags: { pubsub: true, noscript: true }, handler: (ctx, args) => subscribe(ctx, args, false) },
  { name: 'psubscribe', arity: -2, flags: { pubsub: true, noscript: true }, handler: (ctx, args) => subscribe(ctx, args, true) },
  { name: 'unsubscribe', arity: -1, flags: { pubsub: true, noscript: true }, handler: (ctx, args) => unsubscribe(ctx, args, false) },
  { name: 'punsubscribe', arity: -1, flags: { pubsub: true, noscript: true }, handler: (ctx, args) => unsubscribe(ctx, args, true) },
  {
    name: 'ssubscribe',
    arity: -2,
    flags: { pubsub: true, noscript: true },
    handler: (ctx, args) => {
      if (ctx.client.multi || ctx.noBlock) throw new CommandError("ERR SSUBSCRIBE isn't allowed for a DENY BLOCKING client");
      for (const channel of args) {
        ctx.server.ssubscribe(ctx.client, channel);
        ctx.client.write(new RespPush(['ssubscribe', channel, ctx.client.shardChannels.size]));
      }
      return NO_REPLY;
    },
  },
  {
    name: 'sunsubscribe',
    arity: -1,
    flags: { pubsub: true, noscript: true },
    handler: (ctx, args) => {
      const targets = args.length ? args : [...ctx.client.shardChannels];
      if (!targets.length) ctx.client.write(new RespPush(['sunsubscribe', null, 0]));
      for (const channel of targets) {
        ctx.server.sunsubscribe(ctx.client, channel);
        ctx.client.write(new RespPush(['sunsubscribe', channel, ctx.client.shardChannels.size]));
      }
      return NO_REPLY;
    },
  },
  { name: 'spublish', arity: 3, handler: (ctx, args) => ctx.server.spublish(args[0], args[1]) },
  { name: 'publish', arity: 3, handler: (ctx, args) => ctx.server.publish(args[0], args[1]) },
  { name: 'pubsub', arity: -2, handler: pubsub },
];
