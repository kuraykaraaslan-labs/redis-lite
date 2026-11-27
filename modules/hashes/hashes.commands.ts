import { keysAt, validated, withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import {
  HDelDTO,
  HExistsDTO,
  HGetAllDTO,
  HGetDTO,
  HIncrByDTO,
  HIncrByFloatDTO,
  HKeysDTO,
  HLenDTO,
  HMGetDTO,
  HMSetDTO,
  HRandFieldDTO,
  HScanCursorDTO,
  HScanDTO,
  HSetCmdDTO,
  HSetNxDTO,
  HStrLenDTO,
  HValsDTO,
} from './hashes.dto';
import HashesService from './hashes.service';

/**
 * Routing of the hash commands: name, arity, flags and keys, then DTO → service. No logic lives here.
 * HRANDFIELD parses its arguments before reading its key (a bad count beats WRONGTYPE); HSCAN checks the cursor, then
 * the key, then the options (none are parsed on a missing key), as Redis does.
 */

const WRITE = { write: true } as const;

export const hashCommands: CommandSpec[] = [
  // ============================================================================
  // Fields
  // ============================================================================
  { name: 'hset', arity: -4, flags: WRITE, keys: keysAt(0), handler: withDTO(HSetCmdDTO, HashesService.hSet) },
  { name: 'hmset', arity: -4, flags: WRITE, keys: keysAt(0), handler: withDTO(HMSetDTO, HashesService.hMSet) },
  { name: 'hsetnx', arity: 4, flags: WRITE, keys: keysAt(0), handler: withDTO(HSetNxDTO, HashesService.hSetNx) },
  { name: 'hget', arity: 3, handler: withDTO(HGetDTO, HashesService.hGet) },
  { name: 'hmget', arity: -3, handler: withDTO(HMGetDTO, HashesService.hMGet) },
  { name: 'hgetall', arity: 2, handler: withDTO(HGetAllDTO, HashesService.hGetAll) },
  { name: 'hdel', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(HDelDTO, HashesService.hDel) },
  { name: 'hexists', arity: 3, handler: withDTO(HExistsDTO, HashesService.hExists) },
  { name: 'hlen', arity: 2, handler: withDTO(HLenDTO, HashesService.hLen) },
  { name: 'hkeys', arity: 2, handler: withDTO(HKeysDTO, HashesService.hKeys) },
  { name: 'hvals', arity: 2, handler: withDTO(HValsDTO, HashesService.hVals) },
  { name: 'hstrlen', arity: 3, handler: withDTO(HStrLenDTO, HashesService.hStrLen) },
  { name: 'hincrby', arity: 4, flags: WRITE, keys: keysAt(0), handler: withDTO(HIncrByDTO, HashesService.hIncrBy) },
  {
    name: 'hincrbyfloat',
    arity: 4,
    flags: WRITE,
    keys: keysAt(0),
    handler: withDTO(HIncrByFloatDTO, HashesService.hIncrByFloat),
  },

  // ============================================================================
  // Iteration
  // ============================================================================
  {
    name: 'hscan',
    arity: -3,
    // cursor first, then the key (missing → empty scan, WRONGTYPE), then the options
    handler: (ctx, args) =>
      validated(HScanCursorDTO, args, ({ key }) =>
        HashesService.read(ctx, key) ? validated(HScanDTO, args, (input) => HashesService.hScan(ctx, input)) : ['0', []],
      ),
  },
  {
    name: 'hrandfield',
    arity: -2,
    // parse first: a bad count (or WITHVALUES range) beats WRONGTYPE, as in Redis
    handler: (ctx, args) => validated(HRandFieldDTO, args, (input) => HashesService.hRandField(HashesService.read(ctx, input.key), input)),
  },
];
