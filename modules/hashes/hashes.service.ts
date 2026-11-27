import HashesFieldService from './hashes.field.service';
import HashesIterationService from './hashes.iteration.service';
import HashStore from './hashes.structure';

export { HashesFieldService, HashesIterationService, HashStore };

/** The hashes module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class HashesService {
  // Store — hash lookups
  static read = HashStore.read.bind(HashStore);

  // Fields — HSET, HMSET, HSETNX, HGET, HMGET, HGETALL, HDEL, HEXISTS, HLEN, HKEYS, HVALS, HSTRLEN, HINCRBY*
  static hSet = HashesFieldService.hSet.bind(HashesFieldService);
  static hMSet = HashesFieldService.hMSet.bind(HashesFieldService);
  static hSetNx = HashesFieldService.hSetNx.bind(HashesFieldService);
  static hDel = HashesFieldService.hDel.bind(HashesFieldService);
  static hIncrBy = HashesFieldService.hIncrBy.bind(HashesFieldService);
  static hIncrByFloat = HashesFieldService.hIncrByFloat.bind(HashesFieldService);
  static hGet = HashesFieldService.hGet.bind(HashesFieldService);
  static hMGet = HashesFieldService.hMGet.bind(HashesFieldService);
  static hGetAll = HashesFieldService.hGetAll.bind(HashesFieldService);
  static hExists = HashesFieldService.hExists.bind(HashesFieldService);
  static hLen = HashesFieldService.hLen.bind(HashesFieldService);
  static hKeys = HashesFieldService.hKeys.bind(HashesFieldService);
  static hVals = HashesFieldService.hVals.bind(HashesFieldService);
  static hStrLen = HashesFieldService.hStrLen.bind(HashesFieldService);

  // Iteration — HSCAN, HRANDFIELD
  static hScan = HashesIterationService.hScan.bind(HashesIterationService);
  static hRandField = HashesIterationService.hRandField.bind(HashesIterationService);
}
