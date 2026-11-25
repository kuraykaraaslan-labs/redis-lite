/**
 * @deprecated Step-2 compatibility shim: the old `acl.core` exports, re-exported from the converted module so other
 * modules keep compiling until they import `@/modules/acl/acl.service` (and its types / messages files). Remove once
 * nothing imports this file.
 */
import { formatMessage } from '@/libs/message-format';

import AclCheckService from './acl.check.service';
import { AclCategoryEnum } from './acl.enums';
import type { AclRuleErrorCode } from './acl.enums';
import AclMessages from './acl.messages';
import AclRulesService from './acl.rules.service';

export { Acl } from './acl.engine';
export { AclSelector, AclUser } from './acl.structure';
export type { AclDenyReason, AclLogContext, AclLogReason } from './acl.enums';
export type {
  AclDenial,
  AclGetUser,
  AclLogEntry,
  AclLogInput,
  AclOptions,
  AclSelectorInfo,
  ChannelAccess,
  CheckOptions,
  KeyAccess,
  KeyPattern,
} from './acl.types';

/** @deprecated Use AclService.categories() / AclCategoryEnum. */
export const ACL_CATEGORIES: readonly string[] = AclCategoryEnum.options;

/** @deprecated Use AclMessages.RULE_*. */
export const ACL_RULE_ERRORS: Readonly<Record<AclRuleErrorCode, string>> = {
  ENOENT: AclMessages.RULE_ENOENT,
  EINVAL: AclMessages.RULE_EINVAL,
  EEXIST: AclMessages.RULE_EEXIST,
  EISDIR: AclMessages.RULE_EISDIR,
  ENODEV: AclMessages.RULE_ENODEV,
  EBADMSG: AclMessages.RULE_EBADMSG,
  ECHILD: AclMessages.RULE_ECHILD,
};

/** @deprecated Use AclMessages with formatMessage(). */
export const ACL_MESSAGES = {
  USERNAME_SPACES: AclMessages.USERNAME_SPACES,
  DEFAULT_UNDELETABLE: AclMessages.DEFAULT_UNDELETABLE,
  GENPASS_RANGE: AclMessages.GENPASS_RANGE,
  userNotFound: (name: string): string => formatMessage(AclMessages.USER_NOT_FOUND, { name }),
  commandNotFound: (name: string): string => formatMessage(AclMessages.COMMAND_NOT_FOUND, { name }),
  unknownCategory: (name: string): string => formatMessage(AclMessages.UNKNOWN_CATEGORY, { name: name.slice(0, 128) }),
  unmatchedParen: (arg: string): string => formatMessage(AclMessages.UNMATCHED_PAREN, { arg }),
} as const;

/** @deprecated Use AclService.denialMessage. */
export const aclDenialMessage = AclCheckService.denialMessage.bind(AclCheckService);
/** @deprecated Use AclService.noPermError. */
export const noPermError = AclCheckService.noPermError.bind(AclCheckService);
/** @deprecated Use AclService.globMatch. */
export const aclGlobMatch = AclCheckService.globMatch.bind(AclCheckService);
/** @deprecated Use AclService.hashPassword. */
export const hashPassword = AclRulesService.hashPassword.bind(AclRulesService);
/** @deprecated Use AclService.genPass. */
export const genPass = AclRulesService.genPass.bind(AclRulesService);
