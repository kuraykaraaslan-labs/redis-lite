/**
 * @deprecated Compatibility shim (step 2): memory accounting moved to MemoryService (memory.service.ts), its
 * sub-services and size models. Kept so server.core / server.commands, which still import this path, compile.
 */
import MemoryService from './memory.service';

export { RaxShape } from './memory.rax.model';
export type {
  DbOverhead,
  DbSizeOptions,
  DbSnapshot,
  FieldTtls,
  InfoMemoryExtras,
  KeyRecord,
  MemoryInput,
  MemoryReport,
  MemoryStatValue,
  MemoryUsageOptions,
  QuicklistNodeInfo,
  SdsType,
} from './memory.types';

export const clientMemory = MemoryService.clientMemory;
export const computeMemory = MemoryService.computeMemory;
export const memoryForEviction = MemoryService.memoryForEviction;
export const debugQuicklistInfo = MemoryService.debugQuicklistInfo;
export const infoMemory = MemoryService.infoMemory;
export const memoryStats = MemoryService.memoryStats;
export const memoryUsage = MemoryService.memoryUsage;
export const serializedLength = MemoryService.serializedLength;
export const objectSize = MemoryService.objectSize;
