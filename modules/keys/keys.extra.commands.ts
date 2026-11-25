import { keysAt, withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import { DumpDTO, MoveDTO, RestoreDTO, SortCmdDTO, SortRoDTO, SwapDbDTO } from './keys.dto';
import KeysService from './keys.service';

/** Routing of SORT, MOVE, SWAPDB, DUMP and RESTORE: DTO → service. No logic lives here. */

const WRITE = { write: true } as const;

export const extraKeyCommands: CommandSpec[] = [
  // ============================================================================
  // SORT
  // ============================================================================
  { name: 'sort', arity: -2, flags: WRITE, keys: keysAt(0), handler: withDTO(SortCmdDTO, KeysService.sort) },
  { name: 'sort_ro', arity: -2, handler: withDTO(SortRoDTO, KeysService.sort) },

  // ============================================================================
  // Databases
  // ============================================================================
  { name: 'move', arity: 3, flags: WRITE, keys: keysAt(0), handler: withDTO(MoveDTO, KeysService.move) },
  { name: 'swapdb', arity: 3, flags: WRITE, handler: withDTO(SwapDbDTO, KeysService.swapDb) },

  // ============================================================================
  // DUMP / RESTORE
  // ============================================================================
  { name: 'dump', arity: 2, handler: withDTO(DumpDTO, KeysService.dump) },
  { name: 'restore', arity: -4, flags: WRITE, keys: keysAt(0), handler: withDTO(RestoreDTO, KeysService.restore) },
];
