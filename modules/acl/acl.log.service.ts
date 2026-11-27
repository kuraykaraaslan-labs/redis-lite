import { RespDouble, RespMap } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { AclLogEntry, AclLogInput, AclLogState } from './acl.types';

/** ACL LOG: denied commands and failed AUTHs, grouped like Redis does (ACLAddLogEntry). */
export default class AclLogService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** An entry absorbs a new one with the same reason, context, object and user within this window. */
  private static readonly GROUPING_MS = 60_000;

  /** How many of the newest entries are looked at for grouping. */
  private static readonly GROUPING_DEPTH = 10;

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Adds an entry (or bumps the matching recent one, moving it to the front), then trims the log to `maxLen`. */
  static record(state: AclLogState, input: AclLogInput, now: number, maxLen: number): void {
    const list = state.entries;
    for (let i = 0; i < Math.min(AclLogService.GROUPING_DEPTH, list.length); i++) {
      const e = list[i];
      if (
        e.reason === input.reason &&
        e.context === input.context &&
        Math.abs(e.ctime - now) <= AclLogService.GROUPING_MS &&
        e.object === input.object &&
        e.username === input.username
      ) {
        list.splice(i, 1);
        list.unshift(e);
        e.clientInfo = input.clientInfo;
        e.ctime = now;
        e.count++;
        return;
      }
    }
    list.unshift({
      count: 1,
      reason: input.reason,
      context: input.context,
      object: input.object,
      username: input.username,
      clientInfo: input.clientInfo,
      ctime: now,
    });
    while (list.length > maxLen) list.pop();
  }

  /** The `count` newest entries, newest first. */
  static entries(state: AclLogState, count: number, now: number): AclLogEntry[] {
    return state.entries.slice(0, Math.max(0, count)).map((e) => ({
      count: e.count,
      reason: e.reason,
      context: e.context,
      object: e.object,
      username: e.username,
      ageSeconds: (now - e.ctime) / 1000,
      clientInfo: e.clientInfo,
    }));
  }

  /** ACL LOG [count] reply: array of 7-field maps. */
  static reply(entries: AclLogEntry[]): Reply {
    return entries.map(
      (e) =>
        new RespMap([
          ['count', e.count],
          ['reason', e.reason],
          ['context', e.context],
          ['object', e.object],
          ['username', e.username],
          ['age-seconds', new RespDouble(e.ageSeconds)],
          ['client-info', e.clientInfo],
        ]),
    );
  }

  /** ACL LOG RESET. */
  static reset(state: AclLogState): void {
    state.entries = [];
  }
}
