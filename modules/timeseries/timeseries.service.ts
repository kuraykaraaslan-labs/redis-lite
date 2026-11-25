/**
 * The time series module's public API: one flat facade over the sub-services (other modules import only this class).
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import TimeseriesInfoService from './timeseries.info.service';
import TimeseriesIngestService from './timeseries.ingest.service';
import TimeseriesQueryService from './timeseries.query.service';
import TimeseriesRangeService from './timeseries.range.service';
import TimeseriesRulesService from './timeseries.rules.service';

export { TimeseriesInfoService, TimeseriesIngestService, TimeseriesQueryService, TimeseriesRangeService, TimeseriesRulesService };

export default class TimeseriesService {
  // Ingest — TS.CREATE, TS.ADD, TS.MADD, TS.INCRBY / TS.DECRBY, TS.DEL
  static create = TimeseriesIngestService.create.bind(TimeseriesIngestService);
  static add = TimeseriesIngestService.add.bind(TimeseriesIngestService);
  static mAdd = TimeseriesIngestService.mAdd.bind(TimeseriesIngestService);
  static incrBy = TimeseriesIngestService.incrBy.bind(TimeseriesIngestService);
  static del = TimeseriesIngestService.del.bind(TimeseriesIngestService);

  // Range — TS.GET, TS.RANGE, TS.REVRANGE
  static get = TimeseriesRangeService.get.bind(TimeseriesRangeService);
  static range = TimeseriesRangeService.range.bind(TimeseriesRangeService);

  // Query — TS.QUERYINDEX, TS.MGET, TS.MRANGE, TS.MREVRANGE
  static queryIndex = TimeseriesQueryService.queryIndex.bind(TimeseriesQueryService);
  static mGet = TimeseriesQueryService.mGet.bind(TimeseriesQueryService);
  static mRange = TimeseriesQueryService.mRange.bind(TimeseriesQueryService);

  // Rules — TS.CREATERULE, TS.DELETERULE, RENAME hook, ts-compaction-policy grammar
  static createRule = TimeseriesRulesService.createRule.bind(TimeseriesRulesService);
  static deleteRule = TimeseriesRulesService.deleteRule.bind(TimeseriesRulesService);
  static renamed = TimeseriesRulesService.renamed.bind(TimeseriesRulesService);
  static parseCompactionPolicy = TimeseriesRulesService.parseCompactionPolicy.bind(TimeseriesRulesService);

  // Info — TS.INFO, TS.ALTER
  static info = TimeseriesInfoService.info.bind(TimeseriesInfoService);
  static alter = TimeseriesInfoService.alter.bind(TimeseriesInfoService);
}
