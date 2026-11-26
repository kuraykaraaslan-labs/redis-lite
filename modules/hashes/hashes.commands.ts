import { keysAt, validated, withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import {
  HDelDTO,
  HExistsDTO,
  HExpireAtDTO,
  HExpireCmdDTO,
  HExpireTimeDTO,
  HGetAllDTO,
  HGetDelDTO,
  HGetDTO,
  HGetExDTO,
  HIncrByDTO,
  HIncrByFloatDTO,
  HKeysDTO,
  HLenDTO,
  HMGetDTO,
  HMSetDTO,
  HPersistDTO,
  HPExpireAtDTO,
  HPExpireDTO,
  HPExpireTimeDTO,
  HPTtlDTO,
  HRandFieldDTO,
  HScanCursorDTO,
  HScanDTO,
  HSetCmdDTO,
  HSetExDTO,
  HSetNxDTO,
  HStrLenDTO,
  HTtlCmdDTO,
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
  // Field TTLs
  // ============================================================================
  { name: 'hexpire', arity: -6, flags: WRITE, keys: keysAt(0), handler: withDTO(HExpireCmdDTO, HashesService.hExpire) },
  { name: 'hpexpire', arity: -6, flags: WRITE, keys: keysAt(0), handler: withDTO(HPExpireDTO, HashesService.hExpire) },
  { name: 'hexpireat', arity: -6, flags: WRITE, keys: keysAt(0), handler: withDTO(HExpireAtDTO, HashesService.hExpire) },
  { name: 'hpexpireat', arity: -6, flags: WRITE, keys: keysAt(0), handler: withDTO(HPExpireAtDTO, HashesService.hExpire) },
  { name: 'httl', arity: -5, handler: withDTO(HTtlCmdDTO, HashesService.hTtl) },
  { name: 'hpttl', arity: -5, handler: withDTO(HPTtlDTO, HashesService.hTtl) },
  { name: 'hexpiretime', arity: -5, handler: withDTO(HExpireTimeDTO, HashesService.hTtl) },
  { name: 'hpexpiretime', arity: -5, handler: withDTO(HPExpireTimeDTO, HashesService.hTtl) },
  { name: 'hpersist', arity: -5, flags: WRITE, keys: keysAt(0), handler: withDTO(HPersistDTO, HashesService.hPersist) },

  // ============================================================================
  // Get-and-set
  // ============================================================================
  { name: 'hgetdel', arity: -5, flags: WRITE, keys: keysAt(0), handler: withDTO(HGetDelDTO, HashesService.hGetDel) },
  { name: 'hgetex', arity: -5, flags: WRITE, keys: keysAt(0), handler: withDTO(HGetExDTO, HashesService.hGetEx) },
  { name: 'hsetex', arity: -6, flags: WRITE, keys: keysAt(0), handler: withDTO(HSetExDTO, HashesService.hSetEx) },

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
