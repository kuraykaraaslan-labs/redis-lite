import DatabaseService from './database.service';

/**
 * @deprecated Step-2 compatibility shim: the encoding functions moved to DatabaseService (database.service.ts).
 * Kept so unconverted modules still compile; the lead removes it in the final pass.
 */
export const isRedisInteger = DatabaseService.isRedisInteger;
export const listpackEntrySize = DatabaseService.listpackEntrySize;
export const listpackSize = DatabaseService.listpackSize;
export const updateEncoding = DatabaseService.updateEncoding;
export const objectEncoding = DatabaseService.objectEncoding;
export const copyEncoding = DatabaseService.copyEncoding;
export const isCompact = DatabaseService.isCompact;
