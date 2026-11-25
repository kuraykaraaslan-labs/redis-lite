import ListsIndexService from './lists.index.service';
import ListsMoveService from './lists.move.service';
import ListsPushService from './lists.push.service';
import ListStore from './lists.structure';

export { ListsIndexService, ListsMoveService, ListsPushService, ListStore };

/** The lists module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class ListsService {
  // Store — the read step of read-first commands
  static read = ListStore.read.bind(ListStore);

  // Push / pop — LPUSH, RPUSH, LPUSHX, RPUSHX, LPOP, RPOP, LMPOP
  static push = ListsPushService.push.bind(ListsPushService);
  static pop = ListsPushService.pop.bind(ListsPushService);
  static mPop = ListsPushService.mPop.bind(ListsPushService);

  // Index — LLEN, LRANGE, LINDEX, LSET, LREM, LTRIM, LINSERT, LPOS
  static readExisting = ListsIndexService.readExisting.bind(ListsIndexService);
  static lLen = ListsIndexService.lLen.bind(ListsIndexService);
  static lRange = ListsIndexService.lRange.bind(ListsIndexService);
  static lIndex = ListsIndexService.lIndex.bind(ListsIndexService);
  static lPos = ListsIndexService.lPos.bind(ListsIndexService);
  static lSet = ListsIndexService.lSet.bind(ListsIndexService);
  static lRem = ListsIndexService.lRem.bind(ListsIndexService);
  static lTrim = ListsIndexService.lTrim.bind(ListsIndexService);
  static lInsert = ListsIndexService.lInsert.bind(ListsIndexService);

  // Moves and blocking — LMOVE, RPOPLPUSH, BLPOP, BRPOP, BLMPOP, BLMOVE, BRPOPLPUSH
  static lMove = ListsMoveService.lMove.bind(ListsMoveService);
  static bPop = ListsMoveService.bPop.bind(ListsMoveService);
  static bLMPop = ListsMoveService.bLMPop.bind(ListsMoveService);
  static bLMove = ListsMoveService.bLMove.bind(ListsMoveService);
}
