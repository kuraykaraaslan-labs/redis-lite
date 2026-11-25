import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Status } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import HashesService from '@/modules/hashes/hashes.service';
import type { DecodedObject, RdbOptions } from '@/modules/persistence/persistence.rdb';
import { dumpPayload, restorePayloadEx } from '@/modules/persistence/persistence.rdb';

import type { KeyInput, RestoreInput } from './keys.dto';
import KeysMessages from './keys.messages';

/** DUMP / RESTORE: a key's value in Redis's RDB serialization format. */
export default class KeysDumpService {
  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Live encoding thresholds, so DUMP picks the same object encoding Redis would. */
  static rdbOptions(ctx: CommandContext): Partial<RdbOptions> {
    const c = ctx.server.config;
    return {
      hashMaxListpackEntries: c.num('hash-max-listpack-entries'),
      hashMaxListpackValue: c.num('hash-max-listpack-value'),
      setMaxIntsetEntries: c.num('set-max-intset-entries'),
      setMaxListpackEntries: c.num('set-max-listpack-entries'),
      setMaxListpackValue: c.num('set-max-listpack-value'),
      zsetMaxListpackEntries: c.num('zset-max-listpack-entries'),
      zsetMaxListpackValue: c.num('zset-max-listpack-value'),
      listMaxListpackSize: c.num('list-max-listpack-size'),
      streamNodeMaxEntries: c.num('stream-node-max-entries'),
      streamNodeMaxBytes: c.num('stream-node-max-bytes'),
    };
  }

  /** Maps codec errors to the Redis error replies. */
  static rdbError(error: unknown): AppError {
    const msg = (error as Error).message;
    if (msg.includes('version or checksum')) return new AppError(KeysMessages.DUMP_CHECKSUM);
    return new AppError(KeysMessages.BAD_DATA_FORMAT);
  }

  /** DUMP: the serialized value (binary string), or nil for a missing key. Hash field TTLs are included. */
  static dump(ctx: CommandContext, { key }: KeyInput): string | null {
    const v = ctx.db.lookup(key);
    if (!v) return null;
    const ttl = v.type === 'hash' ? HashesService.hashFieldExpires(v.value) : undefined;
    return dumpPayload(v, KeysDumpService.rdbOptions(ctx), ttl).toString('latin1');
  }

  /** RESTORE: creates the key from a DUMP payload; a TTL already in the past just deletes the key. */
  static restore(ctx: CommandContext, { key, ttl, payload, replace, absolute, idle, freq }: RestoreInput): Status {
    if (ctx.db.has(key) && !replace) throw new AppError(KeysMessages.BUSYKEY);
    let decoded: DecodedObject;
    try {
      decoded = restorePayloadEx(Buffer.from(payload, 'latin1'));
    } catch (error) {
      throw KeysDumpService.rdbError(error);
    }
    const value = decoded.value;
    const at = ttl === 0 ? undefined : absolute ? ttl : Date.now() + ttl;
    if (at !== undefined && at <= Date.now()) {
      ctx.db.remove(key);
      return OK;
    }
    ctx.db.set(key, value);
    if (value.type === 'hash' && decoded.fieldExpires) HashesService.setHashFieldExpires(value.value, decoded.fieldExpires);
    if (at !== undefined) ctx.db.setExpire(key, at);
    // IDLETIME applies under LRU-style policies, FREQ under LFU, like Redis's objectSetLRUOrLFU.
    if (idle !== null && !ctx.server.config.lfu) ctx.db.setIdle(key, idle);
    if (freq !== null && ctx.server.config.lfu) ctx.db.setFrequency(key, freq);
    return OK;
  }
}
