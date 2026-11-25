import ZSetsCombineService from './zsets.combine.service';
import ZSetsPopService from './zsets.pop.service';
import ZSetsQueryService from './zsets.query.service';
import ZSetsRangeService from './zsets.range.service';
import ZSetsWriteService from './zsets.write.service';

export { ZSetsCombineService, ZSetsPopService, ZSetsQueryService, ZSetsRangeService, ZSetsWriteService };

/** The sorted set data structure, for modules that build or read sorted-set values (geo, keys, persistence…). */
export { ZSet } from './zsets.structure';

/** The zsets module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class ZSetsService {
  // Writes — ZADD, ZINCRBY, ZREM
  static add = ZSetsWriteService.add.bind(ZSetsWriteService);
  static incrBy = ZSetsWriteService.incrBy.bind(ZSetsWriteService);
  static rem = ZSetsWriteService.rem.bind(ZSetsWriteService);

  // Queries — ZCARD, ZSCORE, ZMSCORE, ZCOUNT, ZLEXCOUNT, ZRANK, ZSCAN, ZRANDMEMBER
  static get = ZSetsQueryService.get.bind(ZSetsQueryService);
  static card = ZSetsQueryService.card.bind(ZSetsQueryService);
  static score = ZSetsQueryService.score.bind(ZSetsQueryService);
  static mScore = ZSetsQueryService.mScore.bind(ZSetsQueryService);
  static count = ZSetsQueryService.count.bind(ZSetsQueryService);
  static lexCount = ZSetsQueryService.lexCount.bind(ZSetsQueryService);
  static rank = ZSetsQueryService.rank.bind(ZSetsQueryService);
  static scan = ZSetsQueryService.scan.bind(ZSetsQueryService);
  static randMember = ZSetsQueryService.randMember.bind(ZSetsQueryService);

  // Ranges — ZRANGE family, ZRANGESTORE, ZREMRANGEBYSCORE / RANK / LEX
  static range = ZSetsRangeService.range.bind(ZSetsRangeService);
  static rangeStore = ZSetsRangeService.rangeStore.bind(ZSetsRangeService);
  static remRangeByScore = ZSetsRangeService.remRangeByScore.bind(ZSetsRangeService);
  static remRangeByRank = ZSetsRangeService.remRangeByRank.bind(ZSetsRangeService);
  static remRangeByLex = ZSetsRangeService.remRangeByLex.bind(ZSetsRangeService);

  // Pops — ZPOPMIN, ZPOPMAX, ZMPOP, BZPOPMIN, BZPOPMAX, BZMPOP
  static pop = ZSetsPopService.pop.bind(ZSetsPopService);
  static blockingPop = ZSetsPopService.blockingPop.bind(ZSetsPopService);
  static mPop = ZSetsPopService.mPop.bind(ZSetsPopService);
  static blockingMPop = ZSetsPopService.blockingMPop.bind(ZSetsPopService);

  // Set algebra — ZUNION, ZINTER, ZDIFF (+STORE), ZINTERCARD
  static sources = ZSetsCombineService.sources.bind(ZSetsCombineService);
  static combined = ZSetsCombineService.combined.bind(ZSetsCombineService);
  static store = ZSetsCombineService.store.bind(ZSetsCombineService);
  static interCard = ZSetsCombineService.interCard.bind(ZSetsCombineService);
}
