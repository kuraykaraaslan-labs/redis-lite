import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { OK, RespMap, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { XInfoInput, XInfoStreamInput, XSetIdInput } from './streams.dto';
import StreamsMessages from './streams.messages';
import { ZERO_ID, byName, compareIds, entryReply, groupLag, idToString } from './streams.structure';
import type { Stream } from './streams.structure';
import type { PendingEntry } from './streams.types';

/** Introspection and metadata: XINFO STREAM / GROUPS / CONSUMERS / HELP, XSETID. */
export default class StreamsInfoService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static byId(a: PendingEntry, b: PendingEntry): number {
    return compareIds(a.id, b.id);
  }

  /** XINFO STREAM FULL: every group with its PEL and consumers (lists capped at `count`, 0 = all). */
  private static fullGroups(s: Stream, count: number): Reply[] {
    const limit = <T>(xs: T[]): T[] => (count ? xs.slice(0, count) : xs);
    return [...s.groups.values()].sort(byName).map((g) => {
      const pel = [...g.pending.values()].sort(StreamsInfoService.byId);
      const consumers = [...g.consumers.values()].sort(byName).map((c) => {
        const cpel = [...c.pending.values()].sort(StreamsInfoService.byId);
        return RespMap.from([
          'name', c.name,
          'seen-time', c.seenTime,
          'active-time', c.activeTime,
          'pel-count', c.pending.size,
          'pending', limit(cpel).map((p) => [idToString(p.id), p.deliveryTime, p.deliveryCount]),
        ]);
      });
      return RespMap.from([
        'name', g.name,
        'last-delivered-id', idToString(g.lastId),
        'entries-read', g.entriesRead,
        'lag', groupLag(s, g),
        'pel-count', g.pending.size,
        'pending', limit(pel).map((p) => [idToString(p.id), p.consumer, p.deliveryTime, p.deliveryCount]),
        'consumers', consumers,
      ]);
    });
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  static infoHelp(): Reply {
    return StreamsMessages.XINFO_HELP.map((line) => new Status(line));
  }

  /** XINFO's read step: the stream at the key, before any subcommand option is parsed ("no such key" first). */
  static infoRead(ctx: CommandContext, { key }: XInfoInput): Stream {
    const s = ctx.db.get(key, 'stream');
    if (!s) throw new AppError(StreamsMessages.NO_SUCH_KEY);
    // a RESTOREd / reloaded stream lays out its listpack nodes lazily: the radix tree counters need them
    const cfg = ctx.server.config;
    s.ensureNodes(cfg.num('stream-node-max-entries'), cfg.num('stream-node-max-bytes'));
    return s;
  }

  /** XINFO STREAM [FULL [COUNT n]] */
  static infoStream(s: Stream, { full, count }: XInfoStreamInput): Reply {
    const first = s.entries[0];
    const last = s.entries[s.length - 1];
    const head: Reply[] = [
      'length', s.length,
      'radix-tree-keys', s.nodes.length,
      'radix-tree-nodes', s.radixTreeNodes(),
      'last-generated-id', idToString(s.lastId),
      'max-deleted-entry-id', idToString(s.maxDeletedId),
      'entries-added', s.entriesAdded,
      'recorded-first-entry-id', first ? idToString(first.id) : '0-0',
    ];
    if (!full) {
      return RespMap.from([...head, 'groups', s.groups.size, 'first-entry', first ? entryReply(first) : null, 'last-entry', last ? entryReply(last) : null]);
    }
    const entries = (count ? s.entries.slice(0, count) : s.entries).map(entryReply);
    return RespMap.from([...head, 'entries', entries, 'groups', StreamsInfoService.fullGroups(s, count)]);
  }

  /** XINFO GROUPS */
  static infoGroups(s: Stream): Reply {
    return [...s.groups.values()].sort(byName).map((g) =>
      RespMap.from([
        'name', g.name,
        'consumers', g.consumers.size,
        'pending', g.pending.size,
        'last-delivered-id', idToString(g.lastId),
        'entries-read', g.entriesRead,
        'lag', groupLag(s, g),
      ]),
    );
  }

  /** XINFO CONSUMERS */
  static infoConsumers(s: Stream, { key, group }: XInfoInput): Reply {
    const g = s.groups.get(group);
    if (!g) throw new AppError(formatMessage(StreamsMessages.NOGROUP_FOR_KEY, { key, group }));
    const now = Date.now();
    return [...g.consumers.values()].sort(byName).map((c) =>
      RespMap.from(['name', c.name, 'pending', c.pending.size, 'idle', now - c.seenTime, 'inactive', c.activeTime < 0 ? -1 : now - c.activeTime]),
    );
  }

  /** XSETID: moves the last id (and optionally entries-added / max-deleted-id) without adding entries. */
  static setId(ctx: CommandContext, { key, id, entriesAdded, maxDeleted }: XSetIdInput): Reply {
    const s = ctx.db.get(key, 'stream');
    if (!s) throw new AppError(StreamsMessages.NO_SUCH_KEY);
    if (s.length) {
      if (compareIds(id, s.entries[s.length - 1].id) < 0) throw new AppError(StreamsMessages.XSETID_BELOW_TOP_ITEM);
      if (entriesAdded !== -1 && s.length > entriesAdded) throw new AppError(StreamsMessages.XSETID_ENTRIES_ADDED_SMALL);
    }
    s.lastId = id;
    if (entriesAdded !== -1) s.entriesAdded = entriesAdded;
    if (compareIds(maxDeleted, ZERO_ID) !== 0) s.maxDeletedId = maxDeleted;
    return OK;
  }
}
