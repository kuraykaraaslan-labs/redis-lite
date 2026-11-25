import GeoPointService from './geo.point.service';
import GeoSearchService from './geo.search.service';

export { GeoPointService, GeoSearchService };

/** The geo module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class GeoService {
  // Points — GEOADD, GEOPOS, GEODIST, GEOHASH
  static add = GeoPointService.add.bind(GeoPointService);
  static pos = GeoPointService.pos.bind(GeoPointService);
  static dist = GeoPointService.dist.bind(GeoPointService);
  static hash = GeoPointService.hash.bind(GeoPointService);

  // Searches — GEORADIUS, GEORADIUSBYMEMBER (+_RO), GEOSEARCH, GEOSEARCHSTORE
  static source = GeoSearchService.source.bind(GeoSearchService);
  static search = GeoSearchService.search.bind(GeoSearchService);
}
