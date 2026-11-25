import StringsCounterService from './strings.counter.service';
import StringsLcsService from './strings.lcs.service';
import StringsRangeService from './strings.range.service';
import StringsValueService from './strings.value.service';

export { StringsCounterService, StringsLcsService, StringsRangeService, StringsValueService };

/** The strings module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class StringsService {
  // Values — GET, SET and variants, GETEX, MGET, MSET
  static get = StringsValueService.get.bind(StringsValueService);
  static set = StringsValueService.set.bind(StringsValueService);
  static setEx = StringsValueService.setEx.bind(StringsValueService);
  static setNx = StringsValueService.setNx.bind(StringsValueService);
  static getSet = StringsValueService.getSet.bind(StringsValueService);
  static getDel = StringsValueService.getDel.bind(StringsValueService);
  static getEx = StringsValueService.getEx.bind(StringsValueService);
  static mGet = StringsValueService.mGet.bind(StringsValueService);
  static mSet = StringsValueService.mSet.bind(StringsValueService);
  static mSetNx = StringsValueService.mSetNx.bind(StringsValueService);

  // Counters — INCR, DECR, INCRBY, DECRBY, INCRBYFLOAT
  static incrBy = StringsCounterService.incrBy.bind(StringsCounterService);
  static incrByFloat = StringsCounterService.incrByFloat.bind(StringsCounterService);

  // Ranges — APPEND, STRLEN, GETRANGE, SUBSTR, SETRANGE
  static append = StringsRangeService.append.bind(StringsRangeService);
  static strLen = StringsRangeService.strLen.bind(StringsRangeService);
  static getRange = StringsRangeService.getRange.bind(StringsRangeService);
  static substr = StringsRangeService.substr.bind(StringsRangeService);
  static setRange = StringsRangeService.setRange.bind(StringsRangeService);

  // LCS
  static lcsValues = StringsLcsService.readValues.bind(StringsLcsService);
  static lcs = StringsLcsService.lcs.bind(StringsLcsService);
}
