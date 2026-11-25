import AclCheckService from './acl.check.service';
import AclLogService from './acl.log.service';
import AclRulesService from './acl.rules.service';

export { AclCheckService, AclLogService, AclRulesService };
export { Acl } from './acl.engine';
export { AclSelector, AclUser } from './acl.structure';

/**
 * The acl module's public API: one flat facade over the stateless sub-services (other modules import only this file).
 * The per-server state (users, ACL LOG) is the `Acl` class exported alongside.
 */
export default class AclService {
  // Permission checks — denial texts, glob matching, categories
  static denialMessage = AclCheckService.denialMessage.bind(AclCheckService);
  static noPermError = AclCheckService.noPermError.bind(AclCheckService);
  static globMatch = AclCheckService.globMatch.bind(AclCheckService);
  static categories = AclCheckService.categories.bind(AclCheckService);

  // Rules — passwords and GENPASS
  static hashPassword = AclRulesService.hashPassword.bind(AclRulesService);
  static genPass = AclRulesService.genPass.bind(AclRulesService);
}
