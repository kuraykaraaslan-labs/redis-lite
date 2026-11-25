import MemoryAllocModel from './memory.alloc.model';
import MemoryQuicklistModel from './memory.quicklist.model';
import MemoryRaxModel from './memory.rax.model';
import MemoryInfoService from './memory.info.service';
import MemoryOverheadService from './memory.overhead.service';
import MemoryUsageService from './memory.usage.service';

export { MemoryInfoService, MemoryOverheadService, MemoryUsageService };
export { Evictor } from './memory.eviction';
export { MemoryTracker } from './memory.tracker';

/**
 * The memory module's stateless public API: Redis-style memory accounting (a clean-room model of Redis 8 on 64-bit
 * Linux with jemalloc) as one flat facade over the sub-services and the size models they are built from. Other modules
 * import only this class (and the types). The per-server runtime (MemoryTracker, Evictor) is in memory.tracker.ts /
 * memory.eviction.ts.
 */
export default class MemoryService {
  // Size model — struct sizes, jemalloc, sds, kvobj, dicts, quicklists, rax
  static readonly SIZES = MemoryAllocModel.SIZES;
  static jemallocSize = MemoryAllocModel.jemallocSize.bind(MemoryAllocModel);
  static sdsReqType = MemoryAllocModel.sdsReqType.bind(MemoryAllocModel);
  static sdsHdrSize = MemoryAllocModel.sdsHdrSize.bind(MemoryAllocModel);
  static sdsAllocSize = MemoryAllocModel.sdsAllocSize.bind(MemoryAllocModel);
  static hfieldAllocSize = MemoryAllocModel.hfieldAllocSize.bind(MemoryAllocModel);
  static keyOverhead = MemoryAllocModel.keyOverhead.bind(MemoryAllocModel);
  static kvobjAllocSize = MemoryAllocModel.kvobjAllocSize.bind(MemoryAllocModel);
  static intsetBytes = MemoryAllocModel.intsetBytes.bind(MemoryAllocModel);
  static dictBuckets = MemoryAllocModel.dictBuckets.bind(MemoryAllocModel);
  static quicklistNodes = MemoryQuicklistModel.quicklistNodes.bind(MemoryQuicklistModel);
  static streamRaxMemory = MemoryRaxModel.streamRaxMemory.bind(MemoryRaxModel);

  // Per key — MEMORY USAGE, DEBUG OBJECT
  static readonly DEFAULT_SAMPLES = MemoryUsageService.DEFAULT_SAMPLES;
  static objectSize = MemoryUsageService.objectSize.bind(MemoryUsageService);
  static memoryUsage = MemoryUsageService.memoryUsage.bind(MemoryUsageService);
  static serializedLength = MemoryUsageService.serializedLength.bind(MemoryUsageService);
  static debugQuicklistInfo = MemoryUsageService.debugQuicklistInfo.bind(MemoryUsageService);

  // Dataset and overhead — used_memory, maxmemory
  static readonly MEMORY_DEFAULTS = MemoryOverheadService.MEMORY_DEFAULTS;
  static kvstoreMemUsage = MemoryOverheadService.kvstoreMemUsage.bind(MemoryOverheadService);
  static dbOverhead = MemoryOverheadService.dbOverhead.bind(MemoryOverheadService);
  static datasetBytes = MemoryOverheadService.datasetBytes.bind(MemoryOverheadService);
  static clientMemory = MemoryOverheadService.clientMemory.bind(MemoryOverheadService);
  static computeMemory = MemoryOverheadService.computeMemory.bind(MemoryOverheadService);
  static memoryForEviction = MemoryOverheadService.memoryForEviction.bind(MemoryOverheadService);

  // Presentation — MEMORY STATS, INFO memory
  static bytesToHuman = MemoryInfoService.bytesToHuman.bind(MemoryInfoService);
  static memoryStats = MemoryInfoService.memoryStats.bind(MemoryInfoService);
  static infoMemory = MemoryInfoService.infoMemory.bind(MemoryInfoService);
}
