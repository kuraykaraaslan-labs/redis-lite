// Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { OK, RespError, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import PersistenceService from '@/modules/persistence/persistence.service';

import KeysDumpService from './keys.dump.service';
import type { MigrateInput } from './keys.dto';
import KeysMessages from './keys.messages';
import { MigrateTransport } from './keys.migrate.transport';

/**
 * MIGRATE: moves keys to another server as DUMP payloads restored there (`RESTORE key ttl payload [REPLACE]`, the TTL
 * being what is left of the key's, 0 for none), after `AUTH` when given and `SELECT db` when the cached connection is on
 * another database. The replies are read in order: the first error line is reported as `ERR Target instance replied
 * with error: …`; without COPY, the keys whose RESTORE succeeded are deleted (a `del` event, propagated as one DEL),
 * unless AUTH or SELECT failed. No existing key answers NOKEY without connecting; I/O failures answer IOERR.
 */
export default class KeysMigrateService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static ioError(stage: 'connect' | 'write' | 'read'): RespError {
    if (stage === 'connect') return new RespError(KeysMessages.MIGRATE_IO_CONNECT);
    return new RespError(stage === 'write' ? KeysMessages.MIGRATE_IO_WRITE : KeysMessages.MIGRATE_IO_READ);
  }

  /** Deletes the migrated keys like DEL does: modified-key signal, `del` event, one propagated DEL. */
  private static deleteMigrated(ctx: CommandContext, keys: string[]): void {
    const dbIndex = ctx.client.dbIndex;
    const deleted: string[] = [];
    for (const key of keys) {
      if (!ctx.db.remove(key)) continue;
      deleted.push(key);
      ctx.server.touch(dbIndex, key);
      ctx.server.notify(dbIndex, [{ cls: 'g', event: 'del', key }]);
    }
    if (deleted.length) ctx.server.persistence.propagator.also(dbIndex, ['DEL', ...deleted]);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  static migrate(ctx: CommandContext, { host, port, keys, db, timeout, copy, replace, username, password }: MigrateInput): Reply {
    // the dispatcher must not touch or notify the keys itself: what changes is decided by the target's replies
    ctx.noop = true;
    const now = Date.now();
    const found: string[] = [];
    const restores: string[][] = [];
    for (const key of keys) {
      const value = ctx.db.lookup(key);
      if (!value) continue;
      const at = ctx.db.getExpire(key);
      const ttl = at === undefined ? 0 : Math.max(1, at - now);
      const payload = PersistenceService.dumpPayload(value, KeysDumpService.rdbOptions(ctx)).toString('latin1');
      found.push(key);
      restores.push(['RESTORE', key, String(ttl), payload, ...(replace ? ['REPLACE'] : [])]);
    }
    if (!found.length) return new Status(KeysMessages.MIGRATE_NOKEY);

    const auth = password === null ? null : username === null ? ['AUTH', password] : ['AUTH', username, password];
    const outcome = MigrateTransport.get().exchange({ host, port, timeout, db: String(db), auth, restores });
    if (outcome.kind === 'io') return KeysMigrateService.ioError(outcome.stage);

    const replies = outcome.replies;
    const preamble = replies.length - restores.length;
    const firstError = replies.find((line) => line.startsWith('-'));
    const preambleFailed = replies.slice(0, preamble).some((line) => line.startsWith('-'));
    if (!copy && !preambleFailed) {
      KeysMigrateService.deleteMigrated(
        ctx,
        found.filter((_, i) => !replies[preamble + i].startsWith('-')),
      );
    }
    if (firstError !== undefined) throw new AppError(formatMessage(KeysMessages.MIGRATE_TARGET_ERROR, { error: firstError.slice(1) }));
    return OK;
  }
}
