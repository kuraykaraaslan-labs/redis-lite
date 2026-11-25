/**
 * Routing of the time series commands (TS.*): name, arity, flags and keys, then DTO → service. No logic lives here.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { keysAt, withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import {
  AddDTO,
  AlterDTO,
  CreateDTO,
  CreateRuleDTO,
  DecrByDTO,
  DeleteRuleDTO,
  DelDTO,
  GetDTO,
  IncrByDTO,
  InfoDTO,
  MAddDTO,
  MGetDTO,
  MRangeDTO,
  QueryIndexDTO,
  RangeDTO,
} from './timeseries.dto';
import TimeseriesService from './timeseries.service';

const WRITE = { write: true } as const;

export const timeseriesCommands: CommandSpec[] = [
  // ============================================================================
  // Ingest
  // ============================================================================
  { name: 'ts.create', arity: -2, flags: WRITE, keys: keysAt(0), handler: withDTO(CreateDTO, TimeseriesService.create) },
  { name: 'ts.add', arity: -4, flags: WRITE, keys: keysAt(0), handler: withDTO(AddDTO, TimeseriesService.add) },
  { name: 'ts.madd', arity: -4, flags: WRITE, keys: keysAt(0, -1, 3), handler: withDTO(MAddDTO, TimeseriesService.mAdd) },
  { name: 'ts.incrby', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(IncrByDTO, TimeseriesService.incrBy) },
  { name: 'ts.decrby', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(DecrByDTO, TimeseriesService.incrBy) },
  { name: 'ts.del', arity: 4, flags: WRITE, keys: keysAt(0), handler: withDTO(DelDTO, TimeseriesService.del) },

  // ============================================================================
  // Range
  // ============================================================================
  { name: 'ts.get', arity: -2, handler: withDTO(GetDTO, TimeseriesService.get) },
  { name: 'ts.range', arity: -4, handler: withDTO(RangeDTO, (ctx, input) => TimeseriesService.range(ctx, input, false)) },
  { name: 'ts.revrange', arity: -4, handler: withDTO(RangeDTO, (ctx, input) => TimeseriesService.range(ctx, input, true)) },

  // ============================================================================
  // Query
  // ============================================================================
  { name: 'ts.queryindex', arity: -2, handler: withDTO(QueryIndexDTO, TimeseriesService.queryIndex) },
  { name: 'ts.mget', arity: -3, handler: withDTO(MGetDTO, TimeseriesService.mGet) },
  { name: 'ts.mrange', arity: -5, handler: withDTO(MRangeDTO, (ctx, input) => TimeseriesService.mRange(ctx, input, false)) },
  { name: 'ts.mrevrange', arity: -5, handler: withDTO(MRangeDTO, (ctx, input) => TimeseriesService.mRange(ctx, input, true)) },

  // ============================================================================
  // Rules
  // ============================================================================
  { name: 'ts.createrule', arity: -6, flags: WRITE, keys: keysAt(0, 1), handler: withDTO(CreateRuleDTO, TimeseriesService.createRule) },
  { name: 'ts.deleterule', arity: 3, flags: WRITE, keys: keysAt(0, 1), handler: withDTO(DeleteRuleDTO, TimeseriesService.deleteRule) },

  // ============================================================================
  // Info
  // ============================================================================
  { name: 'ts.info', arity: -2, handler: withDTO(InfoDTO, TimeseriesService.info) },
  { name: 'ts.alter', arity: -2, flags: WRITE, keys: keysAt(0), handler: withDTO(AlterDTO, TimeseriesService.alter) },
];
