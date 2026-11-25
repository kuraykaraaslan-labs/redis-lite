/**
 * Every text the notifications module emits: the Pub/Sub channel names keyspace notifications are published on
 * (`__keyspace@<db>__:<key>` carries the event, `__keyevent@<db>__:<event>` carries the key).
 */
export const NotificationsMessages = {
  KEYSPACE_CHANNEL: '__keyspace@{db}__:{key}',
  KEYEVENT_CHANNEL: '__keyevent@{db}__:{event}',
} as const;

export default NotificationsMessages;
