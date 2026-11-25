import NotificationsEventsService from './notifications.events.service';
import NotificationsPublishService from './notifications.publish.service';

export { NotificationsEventsService, NotificationsPublishService };

/** The notifications module's public API: keyspace events of an executed command and how they are published. */
export default class NotificationsService {
  // Events — derived from an execution
  static keyspaceEvents = NotificationsEventsService.keyspaceEvents.bind(NotificationsEventsService);
  static setWrote = NotificationsEventsService.setWrote.bind(NotificationsEventsService);

  // Publishing — notify-keyspace-events flags and channels
  static parseNotifyFlags = NotificationsPublishService.parseNotifyFlags.bind(NotificationsPublishService);
  static notificationMessages = NotificationsPublishService.notificationMessages.bind(NotificationsPublishService);
  static isReadCommand = NotificationsPublishService.isReadCommand.bind(NotificationsPublishService);
}
