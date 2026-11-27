import { keysAt, withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import { DumpDTO, MigrateDTO, MoveDTO, RestoreDTO, SortCmdDTO, SortRoDTO, SwapDbDTO } from './keys.dto';
import KeysService from './keys.service';

/** Routing of SORT, MOVE, SWAPDB, DUMP, RESTORE and MIGRATE: DTO → service. No logic lives here. */

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
  // DUMP / RESTORE / MIGRATE
  // ============================================================================
  { name: 'dump', arity: 2, handler: withDTO(DumpDTO, KeysService.dump) },
  { name: 'restore', arity: -4, flags: WRITE, keys: keysAt(0), handler: withDTO(RestoreDTO, KeysService.restore) },
  // the cluster flavour MIGRATE uses towards a node that is importing the slot; outside a cluster, RESTORE itself
  { name: 'restore-asking', arity: -4, flags: WRITE, keys: keysAt(0), handler: withDTO(RestoreDTO, KeysService.restore) },
  // keys are touched by the service (only the ones the target accepted, and only without COPY)
  { name: 'migrate', arity: -6, flags: WRITE, handler: withDTO(MigrateDTO, KeysService.migrate) },
];
