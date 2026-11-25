import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { KeyInput, XRangeInput } from './streams.dto';
import { compareIds, entryReply } from './streams.structure';
import type { Stream } from './streams.structure';

/** Reads by key and by id range: the stream lookup, XLEN, XRANGE, XREVRANGE. */
export default class StreamsRangeService {
  /** The stream at `key` (undefined when missing; WRONGTYPE for other types). */
  static read(ctx: CommandContext, { key }: KeyInput): Stream | undefined {
    return ctx.db.get(key, 'stream');
  }

  static len(ctx: CommandContext, { key }: KeyInput): number {
    return ctx.db.get(key, 'stream')?.length ?? 0;
  }

  /** XRANGE / XREVRANGE: entries between start and end (inclusive), newest first for XREVRANGE. */
  static range(ctx: CommandContext, { key, start, end, count, rev }: XRangeInput): Reply {
    if (count === 0) return [];
    const s = ctx.db.get(key, 'stream');
    if (!s || compareIds(start, end) > 0) return [];
    const limit = count < 0 ? undefined : count;
    if (!rev) return s.range(start, end, limit).map(entryReply);
    const all = s.range(start, end).reverse();
    return (limit !== undefined ? all.slice(0, limit) : all).map(entryReply);
  }
}
