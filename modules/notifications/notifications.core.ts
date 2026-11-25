/**
 * @deprecated Compatibility shim (step 2): keyspace notifications moved to NotificationsService
 * (notifications.service.ts). Kept because server.core still imports these names from this path.
 */
import NotificationsService from './notifications.service';

export type { Execution, KeyEvent, NotifyFlags } from './notifications.types';

export const keyspaceEvents = NotificationsService.keyspaceEvents;
export const setWrote = NotificationsService.setWrote;
export const parseNotifyFlags = NotificationsService.parseNotifyFlags;
export const notificationMessages = NotificationsService.notificationMessages;
export const isReadCommand = NotificationsService.isReadCommand;
