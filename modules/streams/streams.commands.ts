import { keysAt, validated, withDTO } from '@/modules/command/command.handler';
import type { CommandSpec } from '@/modules/command/command.types';

import {
  XAckDTO,
  XAddDTO,
  XAutoClaimDTO,
  XClaimDTO,
  XDelDTO,
  XGroupDTO,
  XInfoDTO,
  XInfoStreamDTO,
  XLenDTO,
  XPendingDTO,
  XRangeDTO,
  XReadDTO,
  XReadGroupDTO,
  XRevRangeDTO,
  XSetIdDTO,
  XTrimDTO,
} from './streams.dto';
import StreamsService from './streams.service';

/**
 * Routing of the stream commands: name, arity, flags and keys, then DTO → service. No logic lives here.
 *
 * Several commands look at their key BEFORE parsing (some of) their arguments, because Redis does: they call the
 * service's read step, then `validated()`, then the service with what was read. XREAD, XREADGROUP and XGROUP check
 * their id arguments only after the key (and group): the DTO tokenizes those ids and the service reports them.
 */

const WRITE = { write: true } as const;

/** XGROUP's key is its second argument (none for HELP). */
const xgroupKeys = (args: string[]): string[] => (args[1] !== undefined && args[0].toLowerCase() !== 'help' ? [args[1]] : []);

export const streamCommands: CommandSpec[] = [
  // ============================================================================
  // Entries: XADD, XLEN, XRANGE, XREVRANGE, XDEL, XTRIM
  // ============================================================================
  { name: 'xadd', arity: -5, flags: WRITE, keys: keysAt(0), handler: withDTO(XAddDTO, StreamsService.add) },
  { name: 'xlen', arity: 2, handler: withDTO(XLenDTO, StreamsService.len) },
  { name: 'xrange', arity: -4, handler: withDTO(XRangeDTO, StreamsService.range) },
  { name: 'xrevrange', arity: -4, handler: withDTO(XRevRangeDTO, StreamsService.range) },
  {
    name: 'xdel',
    arity: -3,
    flags: WRITE,
    keys: keysAt(0),
    // read first: WRONGTYPE beats an invalid id, and a missing key never looks at its ids
    handler: (ctx, args) => {
      const s = StreamsService.read(ctx, { key: args[0] });
      return s ? validated(XDelDTO, args, (input) => StreamsService.del(s, input)) : 0;
    },
  },
  { name: 'xtrim', arity: -4, flags: WRITE, keys: keysAt(0), handler: withDTO(XTrimDTO, StreamsService.trim) },

  // ============================================================================
  // Read: XREAD, XREADGROUP
  // ============================================================================
  { name: 'xread', arity: -4, handler: withDTO(XReadDTO, StreamsService.xread) },
  { name: 'xreadgroup', arity: -7, flags: WRITE, handler: withDTO(XReadGroupDTO, StreamsService.xreadGroup) },

  // ============================================================================
  // Pending: XACK, XPENDING, XCLAIM, XAUTOCLAIM
  // ============================================================================
  {
    name: 'xack',
    arity: -4,
    flags: WRITE,
    keys: keysAt(0),
    // read first: WRONGTYPE beats an invalid id
    handler: (ctx, args) => {
      const s = StreamsService.read(ctx, { key: args[0] });
      return validated(XAckDTO, args, (input) => StreamsService.ack(s, input));
    },
  },
  { name: 'xpending', arity: -3, handler: withDTO(XPendingDTO, StreamsService.pending) },
  {
    name: 'xclaim',
    arity: -6,
    flags: WRITE,
    keys: keysAt(0),
    // read first: WRONGTYPE and NOGROUP beat invalid arguments
    handler: (ctx, args) => {
      const target = StreamsService.findGroup(ctx, args[0], args[1]);
      return validated(XClaimDTO, args, (input) => StreamsService.claim(input, target));
    },
  },
  { name: 'xautoclaim', arity: -6, flags: WRITE, keys: keysAt(0), handler: withDTO(XAutoClaimDTO, StreamsService.autoClaim) },

  // ============================================================================
  // Groups and info: XGROUP, XINFO, XSETID
  // ============================================================================
  { name: 'xgroup', arity: -2, flags: WRITE, keys: xgroupKeys, handler: withDTO(XGroupDTO, StreamsService.group) },
  {
    name: 'xinfo',
    arity: -2,
    handler: (ctx, args) =>
      validated(XInfoDTO, args, (input) => {
        if (input.sub === 'help') return StreamsService.infoHelp();
        // read first: a missing key beats invalid XINFO STREAM options
        const s = StreamsService.infoRead(ctx, input);
        if (input.sub === 'stream') return validated(XInfoStreamDTO, args, (options) => StreamsService.infoStream(s, options));
        return input.sub === 'groups' ? StreamsService.infoGroups(s) : StreamsService.infoConsumers(s, input);
      }),
  },
  { name: 'xsetid', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(XSetIdDTO, StreamsService.setId) },
];
