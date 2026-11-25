import DatabaseService from './database.service';

/**
 * @deprecated Step-2 compatibility shim: SCAN cursors moved to DatabaseService (database.service.ts).
 * Kept so unconverted modules still compile; the lead removes it in the final pass.
 */
export const scanPage = DatabaseService.scanPage;
export const parseCursor = DatabaseService.parseCursor;
