import { keysAt, validated, withDTO } from '@/modules/command/command.handler';
import type { CommandSpec } from '@/modules/command/command.types';

import { PfAddDTO, PfCountDTO, PfDebugDTO, PfMergeDTO, PfSelfTestDTO } from './hyperloglog.dto';
import HyperLogLogService from './hyperloglog.service';

/** Routing of the HyperLogLog commands: name, arity, flags and keys, then DTO → service. No logic lives here. */

const WRITE = { write: true } as const;

export const hyperloglogCommands: CommandSpec[] = [
  { name: 'pfadd', arity: -2, flags: WRITE, keys: keysAt(0), handler: withDTO(PfAddDTO, HyperLogLogService.add) },
  { name: 'pfcount', arity: -2, keys: keysAt(0, -1), handler: withDTO(PfCountDTO, HyperLogLogService.count) },
  { name: 'pfmerge', arity: -2, flags: WRITE, keys: keysAt(0), handler: withDTO(PfMergeDTO, HyperLogLogService.merge) },
  {
    name: 'pfdebug',
    arity: -3,
    flags: WRITE,
    keys: keysAt(1),
    // read first: WRONGTYPE and a missing key beat a wrong argument count
    handler: (ctx, args) => {
      const hll = HyperLogLogService.debugRead(ctx, { key: args[1] });
      return validated(PfDebugDTO, args, (input) => HyperLogLogService.debug(ctx, hll, input));
    },
  },
  { name: 'pfselftest', arity: 1, handler: withDTO(PfSelfTestDTO, HyperLogLogService.selfTest) },
];
