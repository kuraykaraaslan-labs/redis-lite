/**
 * @deprecated Compatibility shim (step 2): the RDB format moved to PersistenceService (persistence.service.ts) and its
 * codecs / sub-services. Kept so modules that still import this path (keys.extra.commands, scripting.functions.commands)
 * compile; the lead removes it once they import the facade.
 */
import PersistenceService from './persistence.service';

export { RDB_OPCODE, RDB_TYPE, RDB_VERSION } from './persistence.enums';
export type {
  DecodedObject,
  EncodedObject,
  FieldExpires,
  ListpackEntry,
  RdbAux,
  RdbAuxInput,
  RdbDatabase,
  RdbFile,
  RdbKeyEntry,
  RdbOptions,
} from './persistence.types';

export const dumpPayload = PersistenceService.dumpPayload;
export const restorePayloadEx = PersistenceService.restorePayloadEx;
export const restorePayload = PersistenceService.restorePayload;
export const functionsDumpPayload = PersistenceService.functionsDumpPayload;
export const functionsRestorePayload = PersistenceService.functionsRestorePayload;
export const encodeObject = PersistenceService.encodeObject;
export const listpackBytes = PersistenceService.listpackBytes;
