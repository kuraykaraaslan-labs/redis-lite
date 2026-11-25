import { formatMessage } from '@/libs/message-format';

import NotificationsMessages from './notifications.messages';
import type { KeyEvent, NotifyFlags } from './notifications.types';

/** Which events are published, and where: the notify-keyspace-events flags and the Pub/Sub messages of one event. */
export default class NotificationsPublishService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** The classes the `A` alias stands for. */
  private static readonly ALL_CLASSES = 'g$lshzxetd';

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Parses notify-keyspace-events (K, E, the class characters, A = all classes but m and n). */
  static parseNotifyFlags(value: string): NotifyFlags {
    const classes = new Set<string>();
    for (const c of value) {
      if (c === 'A') for (const a of NotificationsPublishService.ALL_CLASSES) classes.add(a);
      else if (c !== 'K' && c !== 'E') classes.add(c);
    }
    return { keyspace: value.includes('K'), keyevent: value.includes('E'), classes };
  }

  /** The pub/sub messages Redis publishes for one event: `__keyspace@<db>__:<key>` → event, `__keyevent@<db>__:<event>` → key. */
  static notificationMessages(flags: NotifyFlags, db: number, e: KeyEvent): Array<[string, string]> {
    if (!flags.classes.has(e.cls)) return [];
    const out: Array<[string, string]> = [];
    if (flags.keyspace) out.push([formatMessage(NotificationsMessages.KEYSPACE_CHANNEL, { db, key: e.key }), e.event]);
    if (flags.keyevent) out.push([formatMessage(NotificationsMessages.KEYEVENT_CHANNEL, { db, event: e.event }), e.key]);
    return out;
  }

  /** Commands that read keys and therefore can emit `keymiss` (class m) for missing keys. */
  static isReadCommand(flags: { write?: boolean } | undefined): boolean {
    return !flags?.write;
  }
}
