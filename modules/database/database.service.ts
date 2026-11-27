import DatabaseEncodingService from './database.encoding.service';
import DatabaseScanService from './database.scan.service';

export { DatabaseEncodingService, DatabaseScanService };
export { Database } from './database.core';

/**
 * The database module's public API besides the stateful `Database` keyspace (database.core.ts): object encodings and
 * SCAN cursors. Other modules import only this class.
 */
export default class DatabaseService {
  // Encodings — OBJECT ENCODING, listpack sizes, compact-encoding checks
  static isRedisInteger = DatabaseEncodingService.isRedisInteger.bind(DatabaseEncodingService);
  static listpackEntrySize = DatabaseEncodingService.listpackEntrySize.bind(DatabaseEncodingService);
  static listpackSize = DatabaseEncodingService.listpackSize.bind(DatabaseEncodingService);
  static updateEncoding = DatabaseEncodingService.updateEncoding.bind(DatabaseEncodingService);
  static objectEncoding = DatabaseEncodingService.objectEncoding.bind(DatabaseEncodingService);
  static knownEncoding = DatabaseEncodingService.knownEncoding.bind(DatabaseEncodingService);
  static copyEncoding = DatabaseEncodingService.copyEncoding.bind(DatabaseEncodingService);
  static isCompact = DatabaseEncodingService.isCompact.bind(DatabaseEncodingService);

  // Scan — cursor pages
  static scanPage = DatabaseScanService.scanPage.bind(DatabaseScanService);
}
