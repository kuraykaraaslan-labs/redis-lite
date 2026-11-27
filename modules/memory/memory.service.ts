import MemoryAllocModel from './memory.alloc.model';
import MemoryDictModel from './memory.dict.model';
import MemoryQuicklistModel from './memory.quicklist.model';
import MemoryRaxModel from './memory.rax.model';
import MemorySdsModel from './memory.sds.model';
import MemoryInfoService from './memory.info.service';
import MemoryOverheadService from './memory.overhead.service';
import MemoryUsageService from './memory.usage.service';

export { MemoryInfoService, MemoryOverheadService, MemoryUsageService };
export { Evictor } from './memory.eviction';
export { MemoryTracker } from './memory.tracker';

/**
 * The memory module's stateless public API: Redis-style memory accounting (a clean-room model of Redis 7.0 on 64-bit
 * Linux with jemalloc) as one flat facade over the sub-services and the size models they are built from. Other modules
 * import only this class (and the types). The per-server runtime (MemoryTracker, Evictor) is in memory.tracker.ts /
 * memory.eviction.ts.
 */
export default class MemoryService {
  // Size model — struct sizes, jemalloc, sds, dicts, quicklists, rax
  static readonly SIZES = MemoryAllocModel.SIZES;
  static jemallocSize = MemoryAllocModel.jemallocSize.bind(MemoryAllocModel);
  static sdsReqType = MemoryAllocModel.sdsReqType.bind(MemoryAllocModel);
  static sdsHdrSize = MemoryAllocModel.sdsHdrSize.bind(MemoryAllocModel);
  static sdsAllocSize = MemoryAllocModel.sdsAllocSize.bind(MemoryAllocModel);
  static keyAllocSize = MemoryAllocModel.keyAllocSize.bind(MemoryAllocModel);
  static embstrAllocSize = MemoryAllocModel.embstrAllocSize.bind(MemoryAllocModel);
  static intsetBytes = MemoryAllocModel.intsetBytes.bind(MemoryAllocModel);
  static dictBuckets = MemoryAllocModel.dictBuckets.bind(MemoryAllocModel);
  static quicklistNodes = MemoryQuicklistModel.quicklistNodes.bind(MemoryQuicklistModel);
  static streamRaxMemory = MemoryRaxModel.streamRaxMemory.bind(MemoryRaxModel);

  // Value dicts — table sizes and incremental rehashing of hashtable sets / hashes / skiplist zsets
  static dictSnapshot = MemoryDictModel.snapshot.bind(MemoryDictModel);
  static dictAfterCommand = MemoryDictModel.afterCommand.bind(MemoryDictModel);
  static dictSlots = MemoryDictModel.slots.bind(MemoryDictModel);
  static dictSync = MemoryDictModel.sync.bind(MemoryDictModel);
  static dictCron = MemoryDictModel.cron.bind(MemoryDictModel);
  static dictTables = MemoryDictModel.tables.bind(MemoryDictModel);

  // String allocations — sds capacity of raw strings written in place
  static readonly EMBSTR_MAX = MemorySdsModel.EMBSTR_MAX;
  static sdsFresh = MemorySdsModel.fresh.bind(MemorySdsModel);
  static sdsMakeRoom = MemorySdsModel.makeRoom.bind(MemorySdsModel);
  static stringSds = MemorySdsModel.of.bind(MemorySdsModel);
  static modifiedString = MemorySdsModel.modified.bind(MemorySdsModel);

  // Per key — MEMORY USAGE, DEBUG OBJECT
  static readonly DEFAULT_SAMPLES = MemoryUsageService.DEFAULT_SAMPLES;
  static objectSize = MemoryUsageService.objectSize.bind(MemoryUsageService);
  static memoryUsage = MemoryUsageService.memoryUsage.bind(MemoryUsageService);
  static serializedLength = MemoryUsageService.serializedLength.bind(MemoryUsageService);
  static debugQuicklistInfo = MemoryUsageService.debugQuicklistInfo.bind(MemoryUsageService);

  // Dataset and overhead — used_memory, maxmemory
  static readonly MEMORY_DEFAULTS = MemoryOverheadService.MEMORY_DEFAULTS;
  static dbOverhead = MemoryOverheadService.dbOverhead.bind(MemoryOverheadService);
  static datasetBytes = MemoryOverheadService.datasetBytes.bind(MemoryOverheadService);
  static clientMemory = MemoryOverheadService.clientMemory.bind(MemoryOverheadService);
  static luaCaches = MemoryOverheadService.luaCaches.bind(MemoryOverheadService);
  static functionsCaches = MemoryOverheadService.functionsCaches.bind(MemoryOverheadService);
  static computeMemory = MemoryOverheadService.computeMemory.bind(MemoryOverheadService);
  static memoryForEviction = MemoryOverheadService.memoryForEviction.bind(MemoryOverheadService);

  // Presentation — MEMORY STATS, INFO memory
  static bytesToHuman = MemoryInfoService.bytesToHuman.bind(MemoryInfoService);
  static memoryStats = MemoryInfoService.memoryStats.bind(MemoryInfoService);
  static infoMemory = MemoryInfoService.infoMemory.bind(MemoryInfoService);
  static htStats = MemoryInfoService.htStats.bind(MemoryInfoService);
}
