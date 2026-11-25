import { keysAt, withDTO } from '@/modules/command/command.handler';
import type { CommandSpec } from '@/modules/command/command.types';

import {
  CopyDTO,
  DelDTO,
  ExistsDTO,
  ExpireAtDTO,
  ExpireCmdDTO,
  ExpireTimeDTO,
  KeysPatternDTO,
  ObjectDTO,
  PersistDTO,
  PExpireAtDTO,
  PExpireDTO,
  PExpireTimeDTO,
  PTtlDTO,
  RandomKeyDTO,
  RenameDTO,
  ScanDTO,
  TouchDTO,
  TtlCmdDTO,
  TypeDTO,
} from './keys.dto';
import KeysService from './keys.service';

/**
 * Routing of the generic key commands: name, arity, flags and keys, then DTO → service. No logic lives here.
 * SORT, MOVE, SWAPDB, DUMP and RESTORE are routed in keys.extra.commands.ts.
 */

const WRITE = { write: true } as const;

export const keyCommands: CommandSpec[] = [
  // ============================================================================
  // Keyspace
  // ============================================================================
  { name: 'del', arity: -2, flags: WRITE, keys: keysAt(0, -1), handler: withDTO(DelDTO, KeysService.del) },
  { name: 'unlink', arity: -2, flags: WRITE, keys: keysAt(0, -1), handler: withDTO(DelDTO, KeysService.del) },
  { name: 'exists', arity: -2, handler: withDTO(ExistsDTO, KeysService.exists) },
  { name: 'touch', arity: -2, handler: withDTO(TouchDTO, KeysService.touch) },
  { name: 'type', arity: 2, handler: withDTO(TypeDTO, KeysService.type) },
  {
    name: 'rename',
    arity: 3,
    flags: WRITE,
    keys: keysAt(0, 1),
    handler: withDTO(RenameDTO, (ctx, input) => KeysService.rename(ctx, input, false)),
  },
  {
    name: 'renamenx',
    arity: 3,
    flags: WRITE,
    keys: keysAt(0, 1),
    handler: withDTO(RenameDTO, (ctx, input) => KeysService.rename(ctx, input, true)),
  },
  { name: 'copy', arity: -3, flags: WRITE, keys: keysAt(0, 1), handler: withDTO(CopyDTO, KeysService.copy) },
  { name: 'keys', arity: 2, handler: withDTO(KeysPatternDTO, KeysService.keys) },
  { name: 'scan', arity: -2, handler: withDTO(ScanDTO, KeysService.scan) },
  { name: 'randomkey', arity: 1, handler: withDTO(RandomKeyDTO, KeysService.randomKey) },

  // ============================================================================
  // Expiry
  // ============================================================================
  { name: 'expire', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(ExpireCmdDTO, KeysService.expire) },
  { name: 'pexpire', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(PExpireDTO, KeysService.expire) },
  { name: 'expireat', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(ExpireAtDTO, KeysService.expire) },
  { name: 'pexpireat', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(PExpireAtDTO, KeysService.expire) },
  { name: 'ttl', arity: 2, handler: withDTO(TtlCmdDTO, KeysService.ttl) },
  { name: 'pttl', arity: 2, handler: withDTO(PTtlDTO, KeysService.ttl) },
  { name: 'expiretime', arity: 2, handler: withDTO(ExpireTimeDTO, KeysService.ttl) },
  { name: 'pexpiretime', arity: 2, handler: withDTO(PExpireTimeDTO, KeysService.ttl) },
  { name: 'persist', arity: 2, flags: WRITE, keys: keysAt(0), handler: withDTO(PersistDTO, KeysService.persist) },

  // ============================================================================
  // OBJECT
  // ============================================================================
  { name: 'object', arity: -2, handler: withDTO(ObjectDTO, KeysService.object) },
];
