import { keysAt, validated, withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import {
  AppendDTO,
  DecrByDTO,
  DecrDTO,
  GetDelDTO,
  GetDTO,
  GetExDTO,
  GetRangeDTO,
  GetSetDTO,
  IncrByDTO,
  IncrByFloatDTO,
  IncrDTO,
  LcsDTO,
  MGetDTO,
  MSetDTO,
  MSetNxDTO,
  PSetExDTO,
  SetDTO,
  SetExDTO,
  SetNxDTO,
  SetRangeDTO,
  StrLenDTO,
  SubstrDTO,
} from './strings.dto';
import StringsService from './strings.service';

/**
 * Routing of the string commands: name, arity, flags and keys, then DTO → service. No logic lives here.
 *
 * A few commands read their key BEFORE parsing their arguments, because Redis does (a WRONGTYPE beats a bad argument):
 * they call the service's read step, then `validated()`, then the service with the value already read.
 */

const WRITE = { write: true } as const;

export const stringCommands: CommandSpec[] = [
  // ============================================================================
  // Values
  // ============================================================================
  { name: 'get', arity: 2, handler: withDTO(GetDTO, StringsService.get) },
  { name: 'set', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(SetDTO, StringsService.set) },
  { name: 'setex', arity: 4, flags: WRITE, keys: keysAt(0), handler: withDTO(SetExDTO, StringsService.setEx) },
  { name: 'psetex', arity: 4, flags: WRITE, keys: keysAt(0), handler: withDTO(PSetExDTO, StringsService.setEx) },
  { name: 'setnx', arity: 3, flags: WRITE, keys: keysAt(0), handler: withDTO(SetNxDTO, StringsService.setNx) },
  { name: 'getset', arity: 3, flags: WRITE, keys: keysAt(0), handler: withDTO(GetSetDTO, StringsService.getSet) },
  { name: 'getdel', arity: 2, flags: WRITE, keys: keysAt(0), handler: withDTO(GetDelDTO, StringsService.getDel) },
  {
    name: 'getex',
    arity: -2,
    flags: WRITE,
    keys: keysAt(0),
    // read first: WRONGTYPE beats a bad option, and a missing key never looks at its options
    handler: (ctx, args) => {
      const value = StringsService.get(ctx, { key: args[0] });
      return value === null ? null : validated(GetExDTO, args, (input) => StringsService.getEx(ctx, input, value));
    },
  },
  { name: 'mget', arity: -2, handler: withDTO(MGetDTO, StringsService.mGet) },
  { name: 'mset', arity: -3, flags: WRITE, keys: keysAt(0, -1, 2), handler: withDTO(MSetDTO, StringsService.mSet) },
  { name: 'msetnx', arity: -3, flags: WRITE, keys: keysAt(0, -1, 2), handler: withDTO(MSetNxDTO, StringsService.mSetNx) },

  // ============================================================================
  // Counters
  // ============================================================================
  { name: 'incr', arity: 2, flags: WRITE, keys: keysAt(0), handler: withDTO(IncrDTO, StringsService.incrBy) },
  { name: 'decr', arity: 2, flags: WRITE, keys: keysAt(0), handler: withDTO(DecrDTO, StringsService.incrBy) },
  { name: 'incrby', arity: 3, flags: WRITE, keys: keysAt(0), handler: withDTO(IncrByDTO, StringsService.incrBy) },
  { name: 'decrby', arity: 3, flags: WRITE, keys: keysAt(0), handler: withDTO(DecrByDTO, StringsService.incrBy) },
  {
    name: 'incrbyfloat',
    arity: 3,
    flags: WRITE,
    keys: keysAt(0),
    // read first: WRONGTYPE beats an invalid increment
    handler: (ctx, args) => {
      const current = StringsService.get(ctx, { key: args[0] });
      return validated(IncrByFloatDTO, args, (input) => StringsService.incrByFloat(ctx, input, current));
    },
  },

  // ============================================================================
  // Ranges
  // ============================================================================
  { name: 'append', arity: 3, flags: WRITE, keys: keysAt(0), handler: withDTO(AppendDTO, StringsService.append) },
  { name: 'strlen', arity: 2, handler: withDTO(StrLenDTO, StringsService.strLen) },
  {
    name: 'getrange',
    arity: 4,
    // read first: WRONGTYPE beats a non-integer index
    handler: (ctx, args) => {
      const value = StringsService.get(ctx, { key: args[0] });
      return validated(GetRangeDTO, args, (input) => StringsService.getRange(value, input));
    },
  },
  {
    name: 'substr',
    arity: 4,
    // read first: WRONGTYPE beats a non-integer index
    handler: (ctx, args) => {
      const value = StringsService.get(ctx, { key: args[0] });
      return validated(SubstrDTO, args, (input) => StringsService.substr(value, input));
    },
  },
  { name: 'setrange', arity: 4, flags: WRITE, keys: keysAt(0), handler: withDTO(SetRangeDTO, StringsService.setRange) },

  // ============================================================================
  // LCS
  // ============================================================================
  {
    name: 'lcs',
    arity: -3,
    // read first: a non-string key beats a bad option
    handler: (ctx, args) => {
      const values = StringsService.lcsValues(ctx, args[0], args[1]);
      return validated(LcsDTO, args, (input) => StringsService.lcs(values, input));
    },
  },
];
