import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { NULL_ARRAY, RespError, RespMap } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
import type { CommandContext, HandlerResult } from '@/modules/command/command.types';

import type { XReadInput } from './streams.dto';
import StreamsGroupService from './streams.group.service';
import StreamsMessages from './streams.messages';
import { ZERO_ID, advanceGroup, compareIds, deliverNew, entryReply, idToString } from './streams.structure';
import type { Stream } from './streams.structure';
import type { StreamId, StreamIdToken } from './streams.types';

/** Reading new entries, optionally blocking: XREAD and XREADGROUP. */
export default class StreamsReadService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** The id of a token that must be an id (reported only now: Redis checks the key first). */
  private static requireId(token: StreamIdToken): StreamId {
    if (token.kind !== 'id') throw new AppError(StreamsMessages.ID_INVALID);
    return token.id;
  }

  /** The stream at `key`, or undefined when it is missing or no longer a stream (a blocked retry must not throw). */
  private static streamOrNothing(ctx: CommandContext, key: string): Stream | undefined {
    try {
      return ctx.db.get(key, 'stream');
    } catch {
      return undefined;
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** XREAD: entries after the given ids, per stream; blocks with BLOCK until one stream has some. */
  static read(ctx: CommandContext, { keys, ids, count, block }: XReadInput): HandlerResult {
    // `$` resolves once, at call time: only entries added after the call count. Per stream: type, then the id.
    const after = keys.map((key, j): StreamId => {
      const s = ctx.db.get(key, 'stream');
      const token = ids[j];
      if (token.kind === 'last') return s?.lastId ?? ZERO_ID;
      if (token.kind === 'new') throw new AppError(StreamsMessages.XREAD_NEW_ID);
      return StreamsReadService.requireId(token);
    });
    const attempt = (): Reply | undefined => {
      const out: Array<[Reply, Reply]> = [];
      keys.forEach((key, j) => {
        const s = StreamsReadService.streamOrNothing(ctx, key);
        if (!s) return;
        const entries = s.after(after[j], count);
        if (entries.length) out.push([key, entries.map(entryReply)]);
      });
      return out.length ? new RespMap(out, true) : undefined;
    };
    if (block === null) return attempt() ?? NULL_ARRAY;
    return CommandService.blockingCommand(ctx, keys, block, attempt);
  }

  /**
   * XREADGROUP: `>` delivers new entries to the consumer (adding them to the PEL unless NOACK) and may block; an id
   * re-reads the consumer's own pending entries after it (deleted ones come back as [id, nil]) and never blocks.
   */
  static readGroup(ctx: CommandContext, { keys, ids, count, block, noAck, group: groupName, consumer: consumerName }: XReadInput): HandlerResult {
    // Per stream, in order: type, group, then the id.
    const from = keys.map((key, j): StreamId | null => {
      const s = ctx.db.get(key, 'stream');
      if (!s || !s.groups.has(groupName)) throw new AppError(formatMessage(StreamsMessages.NOGROUP_XREADGROUP, { key, group: groupName }));
      const token = ids[j];
      if (token.kind === 'last') throw new AppError(StreamsMessages.XREADGROUP_DOLLAR);
      if (token.kind === 'new') return null;
      return StreamsReadService.requireId(token);
    });

    /** `blocked`: re-run after the client was parked (the key or group may be gone by now). */
    const attempt = (blocking: boolean, blocked: boolean): Reply | undefined => {
      const out: Array<[Reply, Reply]> = [];
      const now = Date.now();
      let served = false;
      for (const [j, key] of keys.entries()) {
        const s = StreamsReadService.streamOrNothing(ctx, key);
        if (!s) {
          if (blocked) return new RespError(StreamsMessages.UNBLOCKED_KEY_DELETED);
          continue;
        }
        const g = s.groups.get(groupName);
        if (!g) {
          if (blocked) return new RespError(StreamsMessages.UNBLOCKED_GROUP_DELETED);
          continue;
        }
        const c = StreamsGroupService.consumer(ctx, key, g, consumerName);
        c.seenTime = now;
        const start = from[j];
        if (start === null) {
          const entries = s.after(g.lastId, count);
          if (!entries.length) continue;
          for (const e of entries) {
            advanceGroup(s, g, e.id);
            if (!noAck) deliverNew(g, c, e, now);
            c.activeTime = now;
          }
          served = true;
          ctx.server.touch(ctx.client.dbIndex, key);
          out.push([key, entries.map(entryReply)]);
        } else {
          // History: this consumer's pending entries after the given id.
          const pending = [...c.pending.values()].filter((p) => compareIds(p.id, start) > 0).sort((a, b) => compareIds(a.id, b.id));
          const picked = count ? pending.slice(0, count) : pending;
          served = true;
          out.push([
            key,
            picked.map((p): Reply => {
              const e = s.find(p.id);
              if (!e) return [idToString(p.id), NULL_ARRAY];
              p.deliveryTime = now;
              p.deliveryCount++;
              return entryReply(e);
            }),
          ]);
        }
      }
      if (!served && blocking) return undefined;
      return served ? new RespMap(out, true) : NULL_ARRAY;
    };

    if (block === null || from.some((id) => id !== null)) return attempt(false, false) ?? NULL_ARRAY;
    let calls = 0;
    return CommandService.blockingCommand(ctx, keys, block, () => attempt(true, calls++ > 0));
  }
}
