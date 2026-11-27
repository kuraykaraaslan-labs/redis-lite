import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { NULL_ARRAY } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { XAckInput, XAutoClaimInput, XClaimInput, XPendingInput } from './streams.dto';
import StreamsGroupService from './streams.group.service';
import StreamsMessages from './streams.messages';
import { ZERO_ID, byName, compareIds, dropPending, entryReply, idToString, movePending } from './streams.structure';
import type { Stream } from './streams.structure';
import type { GroupTarget, PendingEntry } from './streams.types';

/** Pending entries lists: XACK, XPENDING, XCLAIM, XAUTOCLAIM. */
export default class StreamsPendingService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** XAUTOCLAIM scans at most COUNT × this many PEL entries per call. */
  private static readonly AUTOCLAIM_ATTEMPTS_FACTOR = 10;

  /**
   * Redis 7.0 allocates room for COUNT deleted ids (16 bytes each) up front, once the group is found, and answers an
   * error when that allocation fails: on a 64-bit Linux build it fails past 2748779069440 ids (40 TiB).
   */
  private static readonly AUTOCLAIM_MAX_COUNT = 2748779069440;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static byId(a: PendingEntry, b: PendingEntry): number {
    return compareIds(a.id, b.id);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The stream at `key` and its group `group`; NOGROUP when either is missing. */
  static findGroup(ctx: CommandContext, key: string, group: string): GroupTarget {
    const s = ctx.db.get(key, 'stream');
    const g = s?.groups.get(group);
    if (!s || !g) throw new AppError(formatMessage(StreamsMessages.NOGROUP, { key, group }));
    return { s, g };
  }

  /** XACK on the stream read before the ids were parsed: the number of entries removed from the PEL. */
  static ack(s: Stream | undefined, { group, ids }: XAckInput): number {
    const g = s?.groups.get(group);
    if (!g) return 0;
    let n = 0;
    for (const id of ids) {
      const p = g.pending.get(idToString(id));
      if (!p) continue;
      dropPending(g, p);
      n++;
    }
    return n;
  }

  /** XPENDING: the summary form (count, smallest and largest id, per-consumer counts) or the extended form. */
  static pending(ctx: CommandContext, input: XPendingInput): Reply {
    const { g } = StreamsPendingService.findGroup(ctx, input.key, input.group);
    const all = [...g.pending.values()].sort(StreamsPendingService.byId);
    if (input.summary) {
      if (!all.length) return [0, null, null, NULL_ARRAY];
      const perConsumer: Reply[] = [];
      for (const c of [...g.consumers.values()].sort(byName)) {
        if (c.pending.size) perConsumer.push([c.name, String(c.pending.size)]);
      }
      return [all.length, idToString(all[0].id), idToString(all[all.length - 1].id), perConsumer];
    }
    const { consumer, start, end, count, minIdle } = input;
    if (consumer !== undefined && !g.consumers.has(consumer)) return [];
    const now = Date.now();
    const out: Reply[] = [];
    for (const p of all) {
      if (out.length >= count) break;
      if (compareIds(p.id, start) < 0) continue;
      if (compareIds(p.id, end) > 0) break;
      if (consumer !== undefined && p.consumer !== consumer) continue;
      const idle = now - p.deliveryTime;
      if (minIdle && idle < minIdle) continue;
      out.push([idToString(p.id), p.consumer, idle, p.deliveryCount]);
    }
    return out;
  }

  /** XCLAIM on the group found before the arguments were parsed: the claimed entries (or ids with JUSTID). */
  static claim(ctx: CommandContext, input: XClaimInput, { s, g }: GroupTarget): Reply {
    const { consumer: consumerName, minIdle, ids, retryCount, force, justId, lastId } = input;
    const now = Date.now();
    let deliveryTime = input.deliveryTime === null ? -1 : input.deliveryTime.kind === 'idle' ? now - input.deliveryTime.ms : input.deliveryTime.ms;
    if (deliveryTime < 0 || deliveryTime > now) deliveryTime = now;
    if (compareIds(lastId, g.lastId) > 0) g.lastId = lastId;

    const out: Reply[] = [];
    for (const id of ids) {
      const k = idToString(id);
      let p = g.pending.get(k);
      const e = s.find(id);
      if (!e) {
        if (p) dropPending(g, p);
        continue;
      }
      if (force && !p) {
        p = { id, consumer: '', deliveryTime: now, deliveryCount: 1 };
        g.pending.set(k, p);
      }
      if (!p) continue;
      if (p.consumer && minIdle && now - p.deliveryTime < minIdle) continue;
      const c = StreamsGroupService.consumer(ctx, input.key, g, consumerName);
      movePending(g, c, p);
      p.deliveryTime = deliveryTime;
      if (retryCount >= 0) p.deliveryCount = retryCount;
      else if (!justId) p.deliveryCount++;
      out.push(justId ? k : entryReply(e));
      c.seenTime = now;
      c.activeTime = now;
    }
    return out;
  }

  /** XAUTOCLAIM: claims idle PEL entries from `start`; replies [next start, claimed, deleted ids]. */
  static autoClaim(ctx: CommandContext, input: XAutoClaimInput): Reply {
    const { consumer: consumerName, minIdle, start, justId } = input;
    const { s, g } = StreamsPendingService.findGroup(ctx, input.key, input.group);
    if (input.count > StreamsPendingService.AUTOCLAIM_MAX_COUNT) throw new AppError(StreamsMessages.AUTOCLAIM_COUNT_TOO_HIGH);
    const now = Date.now();
    const candidates = [...g.pending.values()].filter((p) => compareIds(p.id, start) >= 0).sort(StreamsPendingService.byId);
    const claimed: Reply[] = [];
    const deleted: string[] = [];
    let count = input.count;
    let attempts = count * StreamsPendingService.AUTOCLAIM_ATTEMPTS_FACTOR;
    let pos = 0;
    while (attempts-- > 0 && count > 0 && pos < candidates.length) {
      const p = candidates[pos++];
      const k = idToString(p.id);
      const e = s.find(p.id);
      if (!e) {
        dropPending(g, p);
        deleted.push(k);
        count--;
        continue;
      }
      if (minIdle && now - p.deliveryTime < minIdle) continue;
      const c = StreamsGroupService.consumer(ctx, input.key, g, consumerName);
      movePending(g, c, p);
      p.deliveryTime = now;
      if (!justId) p.deliveryCount++;
      claimed.push(justId ? k : entryReply(e));
      c.seenTime = now;
      c.activeTime = now;
      count--;
    }
    const next = pos < candidates.length ? candidates[pos].id : ZERO_ID;
    return [idToString(next), claimed, deleted];
  }
}
