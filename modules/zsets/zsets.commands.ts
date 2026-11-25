import type { z } from 'zod';

import { keysAt, validated, withDTO } from '@/modules/command/command.handler';
import type { CommandContext, CommandSpec, HandlerResult } from '@/modules/command/command.types';

import {
  BZMPopDTO,
  BZPopMaxDTO,
  BZPopMinDTO,
  ZAddDTO,
  ZCardDTO,
  ZCountDTO,
  ZDiffDTO,
  ZDiffKeysDTO,
  ZDiffStoreDTO,
  ZDiffStoreKeysDTO,
  ZIncrByDTO,
  ZInterCardDTO,
  ZInterCardKeysDTO,
  ZInterDTO,
  ZInterKeysDTO,
  ZInterStoreDTO,
  ZInterStoreKeysDTO,
  ZLexCountDTO,
  ZMPopDTO,
  ZMScoreDTO,
  ZPopMaxDTO,
  ZPopMinDTO,
  ZRandMemberDTO,
  ZRangeByLexDTO,
  ZRangeByScoreDTO,
  ZRangeDTO,
  ZRangeStoreDTO,
  ZRangeStoreOptionsDTO,
  ZRankDTO,
  ZRemDTO,
  ZRemRangeByLexDTO,
  ZRemRangeByRankDTO,
  ZRemRangeByScoreDTO,
  ZRevRangeByLexDTO,
  ZRevRangeByScoreDTO,
  ZRevRangeDTO,
  ZRevRankDTO,
  ZScanCursorDTO,
  ZScanDTO,
  ZScoreDTO,
  ZUnionDTO,
  ZUnionKeysDTO,
  ZUnionStoreDTO,
  ZUnionStoreKeysDTO,
} from './zsets.dto';
import ZSetsService from './zsets.service';
import type { ScoreSource } from './zsets.types';

/**
 * Routing of the sorted-set commands: name, arity, flags and keys, then DTO → service. No logic lives here.
 *
 * Some commands read a key BEFORE (or between) parsing their arguments, because Redis does (a WRONGTYPE beats a bad
 * argument): they call the service's read step, then `validated()`, then the service with the value already read.
 */

const WRITE = { write: true } as const;

/**
 * ZUNION / ZINTER / ZDIFF (+STORE) / ZINTERCARD: `numkeys key …` is parsed, then the keys are read (WRONGTYPE beats a
 * bad option), then the options.
 */
function combineHandler<TInput>(
  keysDto: z.ZodType<string[]>,
  dto: z.ZodType<TInput>,
  action: (ctx: CommandContext, input: TInput, sources: ScoreSource[]) => HandlerResult,
): CommandSpec['handler'] {
  return (ctx, args) =>
    validated(keysDto, args, (keys) => {
      const sources = ZSetsService.sources(ctx, keys);
      return validated(dto, args, (input) => action(ctx, input, sources));
    });
}

export const zsetCommands: CommandSpec[] = [
  // ============================================================================
  // Writes
  // ============================================================================
  { name: 'zadd', arity: -4, flags: WRITE, keys: keysAt(0), handler: withDTO(ZAddDTO, ZSetsService.add) },
  { name: 'zincrby', arity: 4, flags: WRITE, keys: keysAt(0), handler: withDTO(ZIncrByDTO, ZSetsService.incrBy) },
  { name: 'zrem', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(ZRemDTO, ZSetsService.rem) },

  // ============================================================================
  // Queries
  // ============================================================================
  { name: 'zcard', arity: 2, handler: withDTO(ZCardDTO, ZSetsService.card) },
  { name: 'zscore', arity: 3, handler: withDTO(ZScoreDTO, ZSetsService.score) },
  { name: 'zmscore', arity: -3, handler: withDTO(ZMScoreDTO, ZSetsService.mScore) },
  {
    name: 'zcount',
    arity: 4,
    // read first: WRONGTYPE beats a bad bound, and a missing key never looks at its bounds
    handler: (ctx, args) => {
      const zset = ZSetsService.get(ctx, { key: args[0] });
      return zset ? validated(ZCountDTO, args, (input) => ZSetsService.count(zset, input)) : 0;
    },
  },
  {
    name: 'zlexcount',
    arity: 4,
    // read first: WRONGTYPE beats a bad bound, and a missing key never looks at its bounds
    handler: (ctx, args) => {
      const zset = ZSetsService.get(ctx, { key: args[0] });
      return zset ? validated(ZLexCountDTO, args, (input) => ZSetsService.lexCount(zset, input)) : 0;
    },
  },
  { name: 'zrank', arity: -3, handler: withDTO(ZRankDTO, ZSetsService.rank) },
  { name: 'zrevrank', arity: -3, handler: withDTO(ZRevRankDTO, ZSetsService.rank) },
  {
    name: 'zscan',
    arity: -3,
    // cursor first, then the key (missing → empty scan, WRONGTYPE), then the options
    handler: (ctx, args) =>
      validated(ZScanCursorDTO, args, ({ key }) => {
        const zset = ZSetsService.get(ctx, { key });
        return zset ? validated(ZScanDTO, args, (input) => ZSetsService.scan(ctx, zset, input)) : ['0', []];
      }),
  },
  {
    name: 'zrandmember',
    arity: -2,
    // read first: WRONGTYPE beats a bad count
    handler: (ctx, args) => {
      const zset = ZSetsService.get(ctx, { key: args[0] });
      return validated(ZRandMemberDTO, args, (input) => ZSetsService.randMember(zset, input));
    },
  },

  // ============================================================================
  // Ranges
  // ============================================================================
  { name: 'zrange', arity: -4, handler: withDTO(ZRangeDTO, ZSetsService.range) },
  { name: 'zrevrange', arity: -4, handler: withDTO(ZRevRangeDTO, ZSetsService.range) },
  { name: 'zrangebyscore', arity: -4, handler: withDTO(ZRangeByScoreDTO, ZSetsService.range) },
  { name: 'zrevrangebyscore', arity: -4, handler: withDTO(ZRevRangeByScoreDTO, ZSetsService.range) },
  { name: 'zrangebylex', arity: -4, handler: withDTO(ZRangeByLexDTO, ZSetsService.range) },
  { name: 'zrevrangebylex', arity: -4, handler: withDTO(ZRevRangeByLexDTO, ZSetsService.range) },
  {
    name: 'zrangestore',
    arity: -5,
    flags: WRITE,
    keys: keysAt(0),
    // options first, then the source key (WRONGTYPE beats a bad bound), then the bounds
    handler: (ctx, args) =>
      validated(ZRangeStoreOptionsDTO, args, () => {
        const source = ZSetsService.get(ctx, { key: args[1] });
        return validated(ZRangeStoreDTO, args, (input) => ZSetsService.rangeStore(ctx, input, source));
      }),
  },
  {
    name: 'zremrangebyscore',
    arity: 4,
    flags: WRITE,
    keys: keysAt(0),
    handler: withDTO(ZRemRangeByScoreDTO, ZSetsService.remRangeByScore),
  },
  {
    name: 'zremrangebyrank',
    arity: 4,
    flags: WRITE,
    keys: keysAt(0),
    handler: withDTO(ZRemRangeByRankDTO, ZSetsService.remRangeByRank),
  },
  {
    name: 'zremrangebylex',
    arity: 4,
    flags: WRITE,
    keys: keysAt(0),
    handler: withDTO(ZRemRangeByLexDTO, ZSetsService.remRangeByLex),
  },

  // ============================================================================
  // Pops
  // ============================================================================
  { name: 'zpopmin', arity: -2, flags: WRITE, keys: keysAt(0), handler: withDTO(ZPopMinDTO, ZSetsService.pop) },
  { name: 'zpopmax', arity: -2, flags: WRITE, keys: keysAt(0), handler: withDTO(ZPopMaxDTO, ZSetsService.pop) },
  { name: 'bzpopmin', arity: -3, flags: WRITE, keys: keysAt(0, -2), handler: withDTO(BZPopMinDTO, ZSetsService.blockingPop) },
  { name: 'bzpopmax', arity: -3, flags: WRITE, keys: keysAt(0, -2), handler: withDTO(BZPopMaxDTO, ZSetsService.blockingPop) },
  {
    name: 'zmpop',
    arity: -4,
    flags: WRITE,
    keys: (args) => args.slice(1, 1 + (Number(args[0]) || 0)),
    handler: withDTO(ZMPopDTO, ZSetsService.mPop),
  },
  {
    name: 'bzmpop',
    arity: -5,
    flags: WRITE,
    keys: (args) => args.slice(2, 2 + (Number(args[1]) || 0)),
    handler: withDTO(BZMPopDTO, ZSetsService.blockingMPop),
  },

  // ============================================================================
  // Set algebra
  // ============================================================================
  {
    name: 'zunionstore',
    arity: -4,
    flags: WRITE,
    keys: keysAt(0),
    handler: combineHandler(ZUnionStoreKeysDTO, ZUnionStoreDTO, ZSetsService.store),
  },
  {
    name: 'zinterstore',
    arity: -4,
    flags: WRITE,
    keys: keysAt(0),
    handler: combineHandler(ZInterStoreKeysDTO, ZInterStoreDTO, ZSetsService.store),
  },
  {
    name: 'zdiffstore',
    arity: -4,
    flags: WRITE,
    keys: keysAt(0),
    handler: combineHandler(ZDiffStoreKeysDTO, ZDiffStoreDTO, ZSetsService.store),
  },
  {
    name: 'zunion',
    arity: -3,
    handler: combineHandler(ZUnionKeysDTO, ZUnionDTO, (_ctx, input, sources) => ZSetsService.combined(input, sources)),
  },
  {
    name: 'zinter',
    arity: -3,
    handler: combineHandler(ZInterKeysDTO, ZInterDTO, (_ctx, input, sources) => ZSetsService.combined(input, sources)),
  },
  {
    name: 'zdiff',
    arity: -3,
    handler: combineHandler(ZDiffKeysDTO, ZDiffDTO, (_ctx, input, sources) => ZSetsService.combined(input, sources)),
  },
  {
    name: 'zintercard',
    arity: -3,
    handler: combineHandler(ZInterCardKeysDTO, ZInterCardDTO, (_ctx, input, sources) => ZSetsService.interCard(input, sources)),
  },
];
