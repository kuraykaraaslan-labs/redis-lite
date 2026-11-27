import { z } from 'zod';

/** ACL categories in the order Redis lists them (ACL CAT). */
export const AclCategoryEnum = z.enum([
  'keyspace', 'read', 'write', 'set', 'sortedset', 'list', 'hash', 'string', 'bitmap', 'hyperloglog', 'geo', 'stream',
  'pubsub', 'admin', 'fast', 'slow', 'blocking', 'dangerous', 'connection', 'transaction', 'scripting',
]);

/** What a permission check denied: the command itself, one of its keys, or one of its channels. */
export const AclDenyReasonEnum = z.enum(['command', 'key', 'channel']);

/** ACL LOG reasons: a denial, or a failed AUTH. */
export const AclLogReasonEnum = z.enum(['command', 'key', 'channel', 'auth']);

/** Where a denied command ran (ACL LOG `context`). */
export const AclLogContextEnum = z.enum(['toplevel', 'multi', 'lua', 'module']);

/** acl-pubsub-default: the channels a new user starts with. */
export const AclPubsubDefaultEnum = z.enum(['resetchannels', 'allchannels']);

/** Why an ACL rule was refused (ACLSetUser's errno), see AclMessages.RULE_*. */
export const AclRuleErrorCodeEnum = z.enum(['ENOENT', 'EINVAL', 'EEXIST', 'EISDIR', 'ENODEV', 'EBADMSG', 'ECHILD']);

// ============================================================================
// Type Exports
// ============================================================================

export type AclCategory = z.infer<typeof AclCategoryEnum>;
export type AclDenyReason = z.infer<typeof AclDenyReasonEnum>;
export type AclLogReason = z.infer<typeof AclLogReasonEnum>;
export type AclLogContext = z.infer<typeof AclLogContextEnum>;
export type AclPubsubDefault = z.infer<typeof AclPubsubDefaultEnum>;
export type AclRuleErrorCode = z.infer<typeof AclRuleErrorCodeEnum>;
