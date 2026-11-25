import { OK } from '@/libs/resp';

import { keysAt, validated, withDTO } from '@/modules/command/command.handler';
import type { CommandSpec } from '@/modules/command/command.types';

import {
  BLMoveDTO,
  BLMPopDTO,
  BLPopDTO,
  BRPopDTO,
  BRPopLPushDTO,
  LIndexDTO,
  LInsertDTO,
  LLenDTO,
  LMoveDTO,
  LMPopDTO,
  LPopDTO,
  LPosDTO,
  LPushDTO,
  LPushXDTO,
  LRangeDTO,
  LRemDTO,
  LSetDTO,
  LTrimDTO,
  RPopDTO,
  RPopLPushDTO,
  RPushDTO,
  RPushXDTO,
} from './lists.dto';
import ListsService from './lists.service';

/**
 * Routing of the list commands: name, arity, flags and keys, then DTO → service. No logic lives here.
 *
 * Several commands read their key BEFORE parsing their arguments, because Redis does (a WRONGTYPE, or LSET's missing
 * key, beats a non-integer index): they call the service's read step, then `validated()`, then the service with the
 * list already read. LREM and LTRIM on a missing key answer without looking at their arguments.
 */

const WRITE = { write: true } as const;

export const listCommands: CommandSpec[] = [
  // ============================================================================
  // Push / pop
  // ============================================================================
  {
    name: 'lmpop',
    arity: -4,
    flags: WRITE,
    keys: (args) => args.slice(1, 1 + (Number(args[0]) || 0)),
    handler: withDTO(LMPopDTO, ListsService.mPop),
  },
  // blocking, kept next to LMPOP (command table order)
  {
    name: 'blmpop',
    arity: -5,
    flags: WRITE,
    keys: (args) => args.slice(2, 2 + (Number(args[1]) || 0)),
    handler: withDTO(BLMPopDTO, ListsService.bLMPop),
  },
  { name: 'lpush', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(LPushDTO, ListsService.push) },
  { name: 'rpush', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(RPushDTO, ListsService.push) },
  { name: 'lpushx', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(LPushXDTO, ListsService.push) },
  { name: 'rpushx', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(RPushXDTO, ListsService.push) },
  { name: 'lpop', arity: -2, flags: WRITE, keys: keysAt(0), handler: withDTO(LPopDTO, ListsService.pop) },
  { name: 'rpop', arity: -2, flags: WRITE, keys: keysAt(0), handler: withDTO(RPopDTO, ListsService.pop) },

  // ============================================================================
  // Index
  // ============================================================================
  { name: 'llen', arity: 2, handler: withDTO(LLenDTO, ListsService.lLen) },
  {
    name: 'lrange',
    arity: 4,
    // read first: WRONGTYPE beats a non-integer index
    handler: (ctx, args) => {
      const l = ListsService.read(ctx, args[0]);
      return validated(LRangeDTO, args, (input) => ListsService.lRange(l, input));
    },
  },
  {
    name: 'lindex',
    arity: 3,
    // read first: WRONGTYPE beats a non-integer index
    handler: (ctx, args) => {
      const l = ListsService.read(ctx, args[0]);
      return validated(LIndexDTO, args, (input) => ListsService.lIndex(l, input));
    },
  },
  {
    name: 'lset',
    arity: 4,
    flags: WRITE,
    keys: keysAt(0),
    // read first: a missing key (or WRONGTYPE) beats a non-integer index
    handler: (ctx, args) => {
      const l = ListsService.readExisting(ctx, args[0]);
      return validated(LSetDTO, args, (input) => ListsService.lSet(l, input));
    },
  },
  {
    name: 'lrem',
    arity: 4,
    flags: WRITE,
    keys: keysAt(0),
    // read first: WRONGTYPE beats a non-integer count, and a missing key never looks at it
    handler: (ctx, args) => {
      const l = ListsService.read(ctx, args[0]);
      return l ? validated(LRemDTO, args, (input) => ListsService.lRem(ctx, l, input)) : 0;
    },
  },
  {
    name: 'ltrim',
    arity: 4,
    flags: WRITE,
    keys: keysAt(0),
    // read first: WRONGTYPE beats a non-integer index, and a missing key never looks at them
    handler: (ctx, args) => {
      const l = ListsService.read(ctx, args[0]);
      return l ? validated(LTrimDTO, args, (input) => ListsService.lTrim(ctx, l, input)) : OK;
    },
  },
  { name: 'linsert', arity: 5, flags: WRITE, keys: keysAt(0), handler: withDTO(LInsertDTO, ListsService.lInsert) },
  {
    name: 'lpos',
    arity: -3,
    // read first: WRONGTYPE beats a bad option
    handler: (ctx, args) => {
      const l = ListsService.read(ctx, args[0]);
      return validated(LPosDTO, args, (input) => ListsService.lPos(l, input));
    },
  },

  // ============================================================================
  // Moves
  // ============================================================================
  { name: 'lmove', arity: 5, flags: WRITE, keys: keysAt(0, 1), handler: withDTO(LMoveDTO, ListsService.lMove) },
  { name: 'rpoplpush', arity: 3, flags: WRITE, keys: keysAt(0, 1), handler: withDTO(RPopLPushDTO, ListsService.lMove) },

  // ============================================================================
  // Blocking
  // ============================================================================
  { name: 'blpop', arity: -3, flags: WRITE, keys: keysAt(0, -2), handler: withDTO(BLPopDTO, ListsService.bPop) },
  { name: 'brpop', arity: -3, flags: WRITE, keys: keysAt(0, -2), handler: withDTO(BRPopDTO, ListsService.bPop) },
  { name: 'blmove', arity: 6, flags: WRITE, keys: keysAt(0, 1), handler: withDTO(BLMoveDTO, ListsService.bLMove) },
  { name: 'brpoplpush', arity: 4, flags: WRITE, keys: keysAt(0, 1), handler: withDTO(BRPopLPushDTO, ListsService.bLMove) },
];
