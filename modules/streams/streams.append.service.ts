import { AppError } from '@/libs/app-error';

import type { CommandContext } from '@/modules/command/command.types';

import type { TrimOptions, XAddInput, XDelInput, XTrimInput } from './streams.dto';
import StreamsMessages from './streams.messages';
import { MAX_ID, Stream, U64_MAX, compareIds, idToString, nextId } from './streams.structure';
import type { StreamId } from './streams.types';

/** Writes to the entry log: XADD, XTRIM, XDEL. */
export default class StreamsAppendService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Bounds of the default LIMIT of an approximate trim (100 nodes' worth of entries, as Redis computes it). */
  private static readonly MAX_DEFAULT_LIMIT = 1_000_000_000;
  private static readonly FALLBACK_LIMIT = 10000;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** The effective LIMIT: the given one, else 100 × stream-node-max-entries for `~`, else none (0). */
  private static trimLimit(ctx: CommandContext, trim: TrimOptions): number {
    if (trim.limit !== null) return trim.limit;
    if (!trim.approx) return 0;
    const limit = 100 * ctx.server.config.num('stream-node-max-entries');
    return limit <= 0 || limit > StreamsAppendService.MAX_DEFAULT_LIMIT ? StreamsAppendService.FALLBACK_LIMIT : limit;
  }

  private static applyTrim(s: Stream, trim: TrimOptions, limit: number): number {
    if (!trim.strategy) return 0;
    return s.trimNodes(trim.strategy, trim.maxlen, trim.minid, trim.approx, limit);
  }

  /** The id of the new entry: `*` (time based), `<ms>-*` (next seq of that ms) or the explicit id. */
  private static newId(s: Stream, { id, seqGiven }: Pick<XAddInput, 'id' | 'seqGiven'>): StreamId {
    if (!id) {
      const now = BigInt(Date.now());
      return now > s.lastId.ms ? { ms: now, seq: 0n } : (nextId(s.lastId) as StreamId);
    }
    if (seqGiven || s.lastId.ms !== id.ms) return id;
    // Redis streamAppendItem() cannot go past the last sequence of that ms and answers with its generic EDOM error
    if (s.lastId.seq === U64_MAX) throw new AppError(StreamsMessages.ID_SEQ_OVERFLOW);
    return { ms: id.ms, seq: s.lastId.seq + 1n };
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** XADD: appends an entry (creating the stream unless NOMKSTREAM), then trims; returns the new id. */
  static add(ctx: CommandContext, input: XAddInput): string | null {
    const limit = StreamsAppendService.trimLimit(ctx, input.trim);
    const existing = ctx.db.get(input.key, 'stream');
    if (!existing && input.noMkStream) return null;
    const s = existing ?? new Stream();
    if (compareIds(s.lastId, MAX_ID) === 0) throw new AppError(StreamsMessages.ID_EXHAUSTED);
    const id = StreamsAppendService.newId(s, input);
    if (compareIds(id, s.lastId) <= 0) throw new AppError(StreamsMessages.ID_SMALL);

    if (!existing) ctx.db.set(input.key, { type: 'stream', value: s });
    const cfg = ctx.server.config;
    s.append({ id, fields: input.fields }, cfg.num('stream-node-max-entries'), cfg.num('stream-node-max-bytes'));
    s.lastId = id;
    s.entriesAdded++;
    StreamsAppendService.applyTrim(s, input.trim, limit);
    return idToString(id);
  }

  /** XTRIM: the number of entries removed (0 for a missing key). */
  static trim(ctx: CommandContext, { key, trim }: XTrimInput): number {
    const limit = StreamsAppendService.trimLimit(ctx, trim);
    const s = ctx.db.get(key, 'stream');
    return s ? StreamsAppendService.applyTrim(s, trim, limit) : 0;
  }

  /** XDEL on the stream read before the ids were parsed: the number of entries deleted. */
  static del(s: Stream, { ids }: XDelInput): number {
    return ids.reduce((n, id) => n + (s.delete(id) ? 1 : 0), 0);
  }
}
