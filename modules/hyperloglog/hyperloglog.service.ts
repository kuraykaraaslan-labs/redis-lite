import HyperLogLogDebugService from './hyperloglog.debug.service';
import HyperLogLogValueService from './hyperloglog.value.service';

export { HyperLogLogDebugService, HyperLogLogValueService };

/** The hyperloglog module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class HyperLogLogService {
  // Values — PFADD, PFCOUNT, PFMERGE
  static add = HyperLogLogValueService.add.bind(HyperLogLogValueService);
  static count = HyperLogLogValueService.count.bind(HyperLogLogValueService);
  static merge = HyperLogLogValueService.merge.bind(HyperLogLogValueService);

  // Debug — PFDEBUG, PFSELFTEST
  static debugRead = HyperLogLogDebugService.debugRead.bind(HyperLogLogDebugService);
  static debug = HyperLogLogDebugService.debug.bind(HyperLogLogDebugService);
  static selfTest = HyperLogLogDebugService.selfTest.bind(HyperLogLogDebugService);
}
