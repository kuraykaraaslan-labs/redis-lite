import KeysDatabaseService from './keys.database.service';
import KeysDumpService from './keys.dump.service';
import KeysExpireService from './keys.expire.service';
import KeysMigrateService from './keys.migrate.service';
import KeysObjectService from './keys.object.service';
import KeysSortService from './keys.sort.service';
import KeysSpaceService from './keys.space.service';

export { KeysDatabaseService, KeysDumpService, KeysExpireService, KeysMigrateService, KeysObjectService, KeysSortService, KeysSpaceService };

/** The keys module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class KeysService {
  // Keyspace — DEL, UNLINK, EXISTS, TOUCH, TYPE, RENAME, COPY, KEYS, SCAN, RANDOMKEY
  static del = KeysSpaceService.del.bind(KeysSpaceService);
  static exists = KeysSpaceService.exists.bind(KeysSpaceService);
  static touch = KeysSpaceService.touch.bind(KeysSpaceService);
  static type = KeysSpaceService.type.bind(KeysSpaceService);
  static rename = KeysSpaceService.rename.bind(KeysSpaceService);
  static copy = KeysSpaceService.copy.bind(KeysSpaceService);
  static keys = KeysSpaceService.keys.bind(KeysSpaceService);
  static scan = KeysSpaceService.scan.bind(KeysSpaceService);
  static randomKey = KeysSpaceService.randomKey.bind(KeysSpaceService);

  // Expiry — EXPIRE family, TTL family, PERSIST
  static expire = KeysExpireService.expire.bind(KeysExpireService);
  static ttl = KeysExpireService.ttl.bind(KeysExpireService);
  static persist = KeysExpireService.persist.bind(KeysExpireService);

  // OBJECT
  static object = KeysObjectService.object.bind(KeysObjectService);

  // Databases — MOVE, SWAPDB
  static move = KeysDatabaseService.move.bind(KeysDatabaseService);
  static swapDb = KeysDatabaseService.swapDb.bind(KeysDatabaseService);

  // SORT
  static sort = KeysSortService.sort.bind(KeysSortService);

  // DUMP / RESTORE
  static rdbOptions = KeysDumpService.rdbOptions.bind(KeysDumpService);
  static rdbError = KeysDumpService.rdbError.bind(KeysDumpService);
  static dump = KeysDumpService.dump.bind(KeysDumpService);
  static restore = KeysDumpService.restore.bind(KeysDumpService);

  // MIGRATE
  static migrate = KeysMigrateService.migrate.bind(KeysMigrateService);
}
