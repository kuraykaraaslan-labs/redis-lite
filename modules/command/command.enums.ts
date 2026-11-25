import { z } from 'zod';

/** ACL categories, in the order Redis lists them (ACL CAT, COMMAND INFO). */
export const AclCategoryEnum = z.enum([
  'keyspace', 'read', 'write', 'set', 'sortedset', 'list', 'hash', 'string', 'bitmap', 'hyperloglog', 'geo', 'stream', 'pubsub', 'admin',
  'fast', 'slow', 'blocking', 'dangerous', 'connection', 'transaction', 'scripting',
]);

/** Command flags in the order COMMAND INFO prints them (hidden flags such as may_replicate / sentinel / protected are left out). */
export const CommandFlagEnum = z.enum([
  'write', 'readonly', 'denyoom', 'module', 'admin', 'pubsub', 'noscript', 'blocking', 'loading', 'stale', 'skip_monitor', 'skip_slowlog', 'asking',
  'fast', 'no_auth', 'no_mandatory_keys', 'no_async_loading', 'no_multi', 'movablekeys', 'allow_busy',
]);

export const ACL_CATEGORIES = AclCategoryEnum.options;
export const COMMAND_FLAG_ORDER = CommandFlagEnum.options;

export type AclCategory = z.infer<typeof AclCategoryEnum>;
export type CommandFlag = z.infer<typeof CommandFlagEnum>;
