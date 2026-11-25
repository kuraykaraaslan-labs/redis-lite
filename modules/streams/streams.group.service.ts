import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { OK } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { XGroupInput } from './streams.dto';
import StreamsMessages from './streams.messages';
import { Stream, ZERO_ID, getOrCreateConsumer } from './streams.structure';
import type { ConsumerGroup, StreamId, StreamIdToken } from './streams.types';

/** Consumer group management: XGROUP CREATE, SETID, DESTROY, CREATECONSUMER, DELCONSUMER, HELP. */
export default class StreamsGroupService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** The id of a token that must be an id (reported only now: Redis checks the key and the group first). */
  private static requireId(token: StreamIdToken): StreamId {
    if (token.kind !== 'id') throw new AppError(StreamsMessages.ID_INVALID);
    return token.id;
  }

  /** CREATE: `$` is the stream's last id; with MKSTREAM a missing stream is created first. */
  private static create(ctx: CommandContext, input: XGroupInput, existing: Stream | undefined, group: ConsumerGroup | undefined): Reply {
    const { key, group: groupName, id, entriesRead } = input;
    const lastId = id.kind === 'last' ? (existing?.lastId ?? ZERO_ID) : StreamsGroupService.requireId(id);
    let s = existing;
    if (!s) {
      s = new Stream();
      ctx.db.set(key, { type: 'stream', value: s });
    }
    if (group) throw new AppError(StreamsMessages.BUSYGROUP);
    const read = entriesRead !== undefined ? entriesRead : id.kind === 'last' ? s.entriesAdded : null;
    s.groups.set(groupName, { name: groupName, lastId, entriesRead: read, pending: new Map(), consumers: new Map() });
    return OK;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** XGROUP: the key must exist (unless CREATE … MKSTREAM) and, except for CREATE and DESTROY, the group too. */
  static group(ctx: CommandContext, input: XGroupInput): Reply {
    const { sub, key, group: groupName, mkStream, entriesRead, consumer: consumerName } = input;
    if (sub === 'help') return [...StreamsMessages.XGROUP_HELP];
    const s = ctx.db.get(key, 'stream');
    const g = s?.groups.get(groupName);
    if (!mkStream) {
      if (!s) throw new AppError(StreamsMessages.XGROUP_NO_KEY);
      if (!g && (sub === 'setid' || sub === 'createconsumer' || sub === 'delconsumer')) {
        throw new AppError(formatMessage(StreamsMessages.NOGROUP_FOR_KEY, { key, group: groupName }));
      }
    }
    if (sub === 'create') return StreamsGroupService.create(ctx, input, s, g);

    const st = s as Stream;
    if (sub === 'setid') {
      const grp = g as ConsumerGroup;
      grp.lastId = input.id.kind === 'last' ? st.lastId : StreamsGroupService.requireId(input.id);
      grp.entriesRead = entriesRead ?? null;
      return OK;
    }
    if (sub === 'destroy') {
      if (!g) return 0;
      st.groups.delete(groupName);
      return 1;
    }
    const grp = g as ConsumerGroup;
    if (sub === 'createconsumer') {
      if (grp.consumers.has(consumerName)) return 0;
      getOrCreateConsumer(grp, consumerName);
      return 1;
    }
    // delconsumer: its pending entries leave the group's PEL; returns how many it had
    const c = grp.consumers.get(consumerName);
    if (!c) return 0;
    for (const k of c.pending.keys()) grp.pending.delete(k);
    grp.consumers.delete(consumerName);
    return c.pending.size;
  }
}
