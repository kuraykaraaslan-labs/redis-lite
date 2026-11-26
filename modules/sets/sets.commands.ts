import { keysAt, validated, withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import {
  SAddDTO,
  SCardDTO,
  SDiffDTO,
  SDiffStoreDTO,
  SInterCardDTO,
  SInterDTO,
  SInterStoreDTO,
  SIsMemberDTO,
  SMembersDTO,
  SMIsMemberDTO,
  SMoveDTO,
  SPopDTO,
  SRandMemberDTO,
  SRemDTO,
  SScanCursorDTO,
  SScanDTO,
  SUnionDTO,
  SUnionStoreDTO,
} from './sets.dto';
import SetsService from './sets.service';

/**
 * Routing of the set commands: name, arity, flags and keys, then DTO → service. No logic lives here.
 * SPOP and SRANDMEMBER parse their count before reading the key, as Redis does (a bad count beats WRONGTYPE). SSCAN
 * checks the cursor, then the key, then the options (none are parsed on a missing key).
 */

const WRITE = { write: true } as const;

export const setCommands: CommandSpec[] = [
  // ============================================================================
  // Members
  // ============================================================================
  { name: 'sadd', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(SAddDTO, SetsService.sAdd) },
  { name: 'srem', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(SRemDTO, SetsService.sRem) },
  { name: 'smembers', arity: 2, handler: withDTO(SMembersDTO, SetsService.sMembers) },
  { name: 'sismember', arity: 3, handler: withDTO(SIsMemberDTO, SetsService.sIsMember) },
  { name: 'smismember', arity: -3, handler: withDTO(SMIsMemberDTO, SetsService.sMIsMember) },
  { name: 'scard', arity: 2, handler: withDTO(SCardDTO, SetsService.sCard) },

  // ============================================================================
  // Random
  // ============================================================================
  {
    name: 'spop',
    arity: -2,
    flags: WRITE,
    keys: keysAt(0),
    // parse first: a bad count beats WRONGTYPE, as in Redis
    handler: (ctx, args) => validated(SPopDTO, args, (input) => SetsService.sPop(ctx, input, SetsService.read(ctx, input.key))),
  },
  {
    name: 'srandmember',
    arity: -2,
    // parse first: a bad count beats WRONGTYPE, as in Redis
    handler: (ctx, args) => validated(SRandMemberDTO, args, (input) => SetsService.sRandMember(input, SetsService.read(ctx, input.key))),
  },
  { name: 'smove', arity: 4, flags: WRITE, keys: keysAt(0, 1), handler: withDTO(SMoveDTO, SetsService.sMove) },

  // ============================================================================
  // Algebra
  // ============================================================================
  { name: 'sunion', arity: -2, handler: withDTO(SUnionDTO, SetsService.combine) },
  { name: 'sinter', arity: -2, handler: withDTO(SInterDTO, SetsService.combine) },
  { name: 'sdiff', arity: -2, handler: withDTO(SDiffDTO, SetsService.combine) },
  { name: 'sintercard', arity: -3, handler: withDTO(SInterCardDTO, SetsService.sInterCard) },
  { name: 'sunionstore', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(SUnionStoreDTO, SetsService.combineStore) },
  { name: 'sinterstore', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(SInterStoreDTO, SetsService.combineStore) },
  { name: 'sdiffstore', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(SDiffStoreDTO, SetsService.combineStore) },

  // ============================================================================
  // Scan
  // ============================================================================
  {
    name: 'sscan',
    arity: -3,
    // cursor first, then the key (missing → empty scan, WRONGTYPE), then the options
    handler: (ctx, args) =>
      validated(SScanCursorDTO, args, ({ key }) =>
        SetsService.read(ctx, key) ? validated(SScanDTO, args, (input) => SetsService.sScan(ctx, input)) : ['0', []],
      ),
  },
];
