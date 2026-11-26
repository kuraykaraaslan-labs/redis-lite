import { AppError } from '@/libs/app-error';
import { unknownSubcommand } from '@/libs/resp/messages';

import { bySubcommand, withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import {
  AuthDTO,
  ClientCachingDTO,
  ClientKillDTO,
  ClientListDTO,
  ClientOnOffDTO,
  ClientPauseDTO,
  ClientReplyDTO,
  ClientSetInfoDTO,
  ClientSetNameDTO,
  ClientTrackingDTO,
  ClientUnblockDTO,
  EchoDTO,
  HelloDTO,
  PingDTO,
  SelectDTO,
} from './connection.dto';
import ConnectionService from './connection.service';

/** Routing of the connection commands: name, arity, flags, then DTO → service. No logic lives here. */

// ============================================================================
// CLIENT Subcommands
// ============================================================================

const client = bySubcommand(
  {
    setname: withDTO(ClientSetNameDTO, ConnectionService.setName),
    getname: (ctx) => ConnectionService.getName(ctx),
    id: (ctx) => ConnectionService.id(ctx),
    info: (ctx) => ConnectionService.info(ctx),
    list: withDTO(ClientListDTO, ConnectionService.list),
    setinfo: withDTO(ClientSetInfoDTO, ConnectionService.setInfo),
    kill: withDTO(ClientKillDTO, ConnectionService.kill),
    unblock: withDTO(ClientUnblockDTO, ConnectionService.unblock),
    getredir: (ctx) => ConnectionService.getRedir(ctx),
    trackinginfo: (ctx) => ConnectionService.trackingInfo(ctx),
    tracking: withDTO(ClientTrackingDTO, ConnectionService.tracking),
    caching: withDTO(ClientCachingDTO, ConnectionService.caching),
    help: () => ConnectionService.help(),
    'no-touch': withDTO(ClientOnOffDTO, ConnectionService.noTouch),
    'no-evict': withDTO(ClientOnOffDTO, ConnectionService.noEvict),
    reply: withDTO(ClientReplyDTO, ConnectionService.reply),
    pause: withDTO(ClientPauseDTO, ConnectionService.pause),
    unpause: (ctx) => ConnectionService.unpause(ctx),
  },
  // the dispatcher answers unknown subcommands first; kept for direct calls
  (_ctx, args) => {
    throw new AppError(unknownSubcommand(args[0], 'client'));
  },
);

// ============================================================================
// Commands
// ============================================================================

export const connectionCommands: CommandSpec[] = [
  { name: 'ping', arity: -1, flags: { pubsub: true }, handler: withDTO(PingDTO, ConnectionService.ping) },
  { name: 'echo', arity: 2, handler: withDTO(EchoDTO, ConnectionService.echo) },
  { name: 'select', arity: 2, handler: withDTO(SelectDTO, ConnectionService.select) },
  { name: 'auth', arity: -2, flags: { noauth: true, noscript: true }, handler: withDTO(AuthDTO, ConnectionService.auth) },
  { name: 'hello', arity: -1, flags: { noauth: true, noscript: true }, handler: withDTO(HelloDTO, ConnectionService.hello) },
  { name: 'client', arity: -2, flags: { noscript: true }, handler: client },
  { name: 'reset', arity: 1, flags: { noauth: true, noscript: true, pubsub: true }, handler: (ctx) => ConnectionService.reset(ctx) },
  { name: 'quit', arity: -1, flags: { noauth: true, noscript: true }, handler: () => ConnectionService.quit() },
  { name: 'readonly', arity: 1, handler: () => ConnectionService.clusterOnly() },
  { name: 'readwrite', arity: 1, handler: () => ConnectionService.clusterOnly() },
  { name: 'asking', arity: 1, handler: () => ConnectionService.clusterOnly() },
  // every CLUSTER subcommand (HELP included) answers the same outside cluster mode; unknown ones are the dispatcher's
  { name: 'cluster', arity: -2, handler: () => ConnectionService.clusterOnly() },
];
