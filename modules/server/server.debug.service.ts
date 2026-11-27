
import { AppError } from '@/libs/app-error';
import Logger from '@/libs/logger';
import { formatMessage } from '@/libs/message-format';
import { formatFixed } from '@/libs/number';
import { OK, RespVerbatim, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';
import DatabaseService from '@/modules/database/database.service';
import KeysService from '@/modules/keys/keys.service';
import MemoryService from '@/modules/memory/memory.service';
import type { RedisValue } from '@/modules/database/database.types';

import type {
  DebugActiveExpireInput,
  DebugKeyInput,
  DebugObjectInput,
  DebugOneArgInput,
  DebugPopulateInput,
  DebugReloadInput,
  DebugSleepInput,
} from './server.dto';
import ServerMessages from './server.messages';

/** DEBUG (debugCommand in debug.c): the subcommands that make sense without a C runtime. */
export default class ServerDebugService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  private static readonly SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static encodingOf(ctx: CommandContext, v: RedisValue): string {
    return DatabaseService.objectEncoding(v, ctx.server.config);
  }

  /** A stable fake object address for DEBUG OBJECT `Value at:%p`. */
  private static fakeAddress(key: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
    return `0x7f${(h & 0xffffff).toString(16).padStart(6, '0')}${((h >>> 8) & 0xfff0).toString(16).padStart(4, '0')}`;
  }

  /** The value at `key`, or ERR no such key. */
  private static value(ctx: CommandContext, key: string): RedisValue {
    const v = ctx.db.peek(key);
    if (!v) throw new AppError(ServerMessages.NO_SUCH_KEY);
    return v;
  }

  // ──────────────────────────────────────────────
  // Public Methods: inspection
  // ──────────────────────────────────────────────

  /** DEBUG OBJECT key [fast]. */
  static object(ctx: CommandContext, { key, fast }: DebugObjectInput): Reply {
    const v = ServerDebugService.value(ctx, key);
    const cfg = ctx.server.config;
    const enc = ServerDebugService.encodingOf(ctx, v);
    // shared integers 0..9999 (OBJ_SHARED_REFCOUNT), as OBJECT REFCOUNT reports
    const shared = v.type === 'string' && !v.raw && /^(0|[1-9]\d{0,3})$/.test(v.value) && cfg.get('maxmemory') === '0';
    const refcount = shared ? 2147483647 : 1;
    const idle = ctx.db.idleSeconds(key);
    const now = Date.now();
    // robj->lru: the LRU clock (seconds, 24 bits) of the last access, or (minutes << 8 | counter) under an LFU policy
    const lru = cfg.lfu
      ? (((Math.floor(now / 60000) & 0xffff) << 8) | ctx.db.frequency(key)) >>> 0
      : (Math.floor(now / 1000) - idle) & 0xffffff;
    let quicklist = '';
    if (v.type === 'list') {
      const q = MemoryService.debugQuicklistInfo(v.value);
      quicklist =
        ` ql_nodes:${q.nodes} ql_avg_node:${formatFixed(q.avgNode, 2)} ql_listpack_max:${q.listpackMax}` +
        ` ql_compressed:${q.compressed} ql_uncompressed_size:${q.uncompressedSize}`;
    }
    const serialized = fast
      ? ''
      : ` serializedlength:${MemoryService.serializedLength(v, KeysService.rdbOptions(ctx))}`;
    return new Status(
      formatMessage(ServerMessages.DEBUG_OBJECT, { address: ServerDebugService.fakeAddress(key), refcount, encoding: enc, serialized, lru, idle, quicklist }),
    );
  }

  static listpack(ctx: CommandContext, { key }: DebugKeyInput): Reply {
    const enc = ServerDebugService.encodingOf(ctx, ServerDebugService.value(ctx, key));
    if (enc !== 'listpack') throw new AppError(ServerMessages.DEBUG_NOT_LISTPACK);
    return new Status(ServerMessages.DEBUG_LISTPACK_PRINTED);
  }

  /** DEBUG HTSTATS dbid: the stats of the database's main and expires dicts. */
  static htstats(ctx: CommandContext, { db }: { db: number }): Reply {
    if (db < 0 || db >= ctx.server.databases.length) throw new AppError(ServerMessages.DEBUG_DB_RANGE);
    const database = ctx.server.databases[db];
    const t = ctx.server.memoryModel.keyspaceTables(db);
    const text =
      ServerMessages.DEBUG_HTSTATS_MAIN + MemoryService.htStats(t.main, database.storedKeys) +
      ServerMessages.DEBUG_HTSTATS_EXPIRES + MemoryService.htStats(t.expires, database.expiresCount);
    return new RespVerbatim(text);
  }

  /** DEBUG HTSTATS-KEY key: the stats of a hashtable-encoded value's dict. */
  static htstatsKey(ctx: CommandContext, { key }: DebugKeyInput): Reply {
    const v = ctx.db.peek(key);
    if (!v) throw new AppError(ServerMessages.NO_SUCH_KEY);
    const enc = ServerDebugService.encodingOf(ctx, v);
    if ((enc !== 'hashtable' && enc !== 'skiplist') || (v.type !== 'set' && v.type !== 'hash' && v.type !== 'zset')) {
      throw new AppError(ServerMessages.DEBUG_NOT_HASHTABLE);
    }
    const size = v.value.size;
    return new RespVerbatim(MemoryService.htStats(MemoryService.dictTables(v.value, size), size));
  }

  static quicklist(ctx: CommandContext, { key }: DebugKeyInput): Reply {
    const enc = ServerDebugService.encodingOf(ctx, ServerDebugService.value(ctx, key));
    if (enc !== 'quicklist') throw new AppError(ServerMessages.DEBUG_NOT_QUICKLIST);
    return new Status(ServerMessages.DEBUG_QUICKLIST_PRINTED);
  }

  static help(): Reply {
    return CommandService.helpReply('debug');
  }

  // ──────────────────────────────────────────────
  // Public Methods: actions
  // ──────────────────────────────────────────────

  /** DEBUG SLEEP blocks the whole server, as in Redis. */
  static sleep(_ctx: CommandContext, { ms }: DebugSleepInput): Reply {
    if (ms > 0) Atomics.wait(ServerDebugService.SLEEP_CELL, 0, 0, ms);
    return OK;
  }

  static setActiveExpire(ctx: CommandContext, { enabled }: DebugActiveExpireInput): Reply {
    ctx.server.activeExpire = enabled;
    return OK;
  }

  static changeReplId(ctx: CommandContext): Reply {
    ctx.server.replication.changeReplId();
    return OK;
  }

  /** DEBUG POPULATE count [prefix] [size]: string keys `<prefix>:<n>` = `value:<n>` (padded / cut to size with NULs). */
  static populate(ctx: CommandContext, { count, prefix, size }: DebugPopulateInput): Reply {
    for (let j = 0; j < count; j++) {
      const key = `${prefix}:${j}`;
      if (ctx.db.peek(key) !== undefined) continue;
      let value = `value:${j}`;
      if (size) value = value.length >= size ? value.slice(0, size) : value + '\0'.repeat(size - value.length);
      ctx.db.set(key, { type: 'string', value });
      ctx.server.touch(ctx.client.dbIndex, key);
    }
    return OK;
  }

  static log(_ctx: CommandContext, { value }: DebugOneArgInput): Reply {
    Logger.warn('[ServerDebugService.log] DEBUG LOG', { text: value });
    return OK;
  }

  static reload(ctx: CommandContext, { options }: DebugReloadInput): Reply {
    const hook = ctx.server.debugHooks.reload;
    return hook ? hook(ctx.client, options) : OK;
  }

  static loadAof(ctx: CommandContext): Reply {
    const hook = ctx.server.debugHooks.loadaof;
    return hook ? hook(ctx.client) : OK;
  }

  /** DEBUG STRINGMATCH-LEN: the fuzz tester has nothing to test here. */
  static stringMatchLen(): Reply {
    return new Status(ServerMessages.DEBUG_STRINGMATCH);
  }

  /** Subcommands accepted without effect (QUICKLIST-PACKED-THRESHOLD, SET-DISABLE-DENY-SCRIPTS, PAUSE-CRON…). */
  static accepted(): Reply {
    return OK;
  }
}
