import { z } from 'zod';

/**
 * Command flags in the order COMMAND INFO prints them (hidden flags such as may_replicate / sentinel / protected are
 * left out). ACL categories are owned by the acl module (`AclCategoryEnum` in acl.enums.ts).
 */
export const CommandFlagEnum = z.enum([
  'write', 'readonly', 'denyoom', 'module', 'admin', 'pubsub', 'noscript', 'blocking', 'loading', 'stale', 'skip_monitor', 'skip_slowlog', 'asking',
  'fast', 'no_auth', 'no_mandatory_keys', 'no_async_loading', 'no_multi', 'movablekeys', 'allow_busy',
]);

export const COMMAND_FLAG_ORDER = CommandFlagEnum.options;

export type CommandFlag = z.infer<typeof CommandFlagEnum>;
