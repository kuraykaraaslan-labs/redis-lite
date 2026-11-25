import SetsAlgebraService from './sets.algebra.service';
import SetsMemberService from './sets.member.service';
import SetsRandomService from './sets.random.service';
import SetsScanService from './sets.scan.service';
import SetStore from './sets.structure';

export { SetsAlgebraService, SetsMemberService, SetsRandomService, SetsScanService, SetStore };

/** The sets module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class SetsService {
  // Store — the read step of read-first commands
  static read = SetStore.read.bind(SetStore);

  // Members — SADD, SREM, SMEMBERS, SISMEMBER, SMISMEMBER, SCARD, SMOVE
  static sAdd = SetsMemberService.sAdd.bind(SetsMemberService);
  static sRem = SetsMemberService.sRem.bind(SetsMemberService);
  static sMembers = SetsMemberService.sMembers.bind(SetsMemberService);
  static sIsMember = SetsMemberService.sIsMember.bind(SetsMemberService);
  static sMIsMember = SetsMemberService.sMIsMember.bind(SetsMemberService);
  static sCard = SetsMemberService.sCard.bind(SetsMemberService);
  static sMove = SetsMemberService.sMove.bind(SetsMemberService);

  // Random — SPOP, SRANDMEMBER
  static sPop = SetsRandomService.sPop.bind(SetsRandomService);
  static sRandMember = SetsRandomService.sRandMember.bind(SetsRandomService);

  // Algebra — SUNION, SINTER, SDIFF, *STORE, SINTERCARD
  static combine = SetsAlgebraService.combineSets.bind(SetsAlgebraService);
  static combineStore = SetsAlgebraService.combineStore.bind(SetsAlgebraService);
  static sInterCard = SetsAlgebraService.sInterCard.bind(SetsAlgebraService);

  // Scan — SSCAN
  static sScan = SetsScanService.sScan.bind(SetsScanService);
}
