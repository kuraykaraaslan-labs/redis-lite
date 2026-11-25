import { keysAt, validated, withDTO } from '@/modules/command/command.handler';
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
  SScanDTO,
  SUnionDTO,
  SUnionStoreDTO,
} from './sets.dto';
import SetsService from './sets.service';

/**
 * Routing of the set commands: name, arity, flags and keys, then DTO → service. No logic lives here.
 * SPOP and SRANDMEMBER read their key BEFORE parsing their arguments, because Redis does (a WRONGTYPE beats a bad
 * count).
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
    // read first: WRONGTYPE beats a bad count
    handler: (ctx, args) => {
      const s = SetsService.read(ctx, args[0]);
      return validated(SPopDTO, args, (input) => SetsService.sPop(ctx, input, s));
    },
  },
  {
    name: 'srandmember',
    arity: -2,
    // read first: WRONGTYPE beats a bad count
    handler: (ctx, args) => {
      const s = SetsService.read(ctx, args[0]);
      return validated(SRandMemberDTO, args, (input) => SetsService.sRandMember(input, s));
    },
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
  { name: 'sscan', arity: -3, handler: withDTO(SScanDTO, SetsService.sScan) },
];
