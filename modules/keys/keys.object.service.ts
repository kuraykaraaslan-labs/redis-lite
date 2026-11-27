import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import type { Reply } from '@/libs/resp';
import { RespMessages } from '@/libs/resp/messages';

import CommandService from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';
import DatabaseService from '@/modules/database/database.service';

import type { ObjectInput } from './keys.dto';
import KeysMessages from './keys.messages';

/** OBJECT ENCODING | REFCOUNT | IDLETIME | FREQ | HELP: object metadata, read without touching the key. */
export default class KeysObjectService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Small integers are shared objects in Redis (refcount OBJ_SHARED_REFCOUNT = INT_MAX). */
  private static readonly SHARED_INTEGER_RE = /^(0|[1-9]\d{0,3})$/;
  private static readonly SHARED_REFCOUNT = 2147483647;

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  static object(ctx: CommandContext, input: ObjectInput): Reply {
    if (input.help) return CommandService.helpReply('object');
    const { key, subcommand, given } = input;
    const v = ctx.db.peek(key);
    const config = ctx.server.config;
    switch (subcommand) {
      case 'encoding':
        return v ? DatabaseService.objectEncoding(v, config) : null;
      case 'refcount': {
        if (!v) return null;
        // Shared unless an LRU/LFU maxmemory policy is set (maxmemory is then non-zero).
        const shared = v.type === 'string' && !v.raw && !v.noInt && KeysObjectService.SHARED_INTEGER_RE.test(v.value) && config.get('maxmemory') === '0';
        return shared ? KeysObjectService.SHARED_REFCOUNT : 1;
      }
      case 'idletime':
        if (!v) return null;
        if (config.lfu) throw new AppError(KeysMessages.LFU_NO_IDLETIME);
        return ctx.db.idleSeconds(key);
      case 'freq':
        if (!v) return null;
        if (!config.lfu) throw new AppError(KeysMessages.LFU_NO_FREQ);
        return ctx.db.frequency(key);
      default:
        // An unknown subcommand is refused after the key lookup, as in Redis.
        throw new AppError(formatMessage(RespMessages.UNKNOWN_SUBCOMMAND, { subcommand: given, command: 'OBJECT' }));
    }
  }
}
