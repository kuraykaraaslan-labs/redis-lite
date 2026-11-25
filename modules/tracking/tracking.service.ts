import { ClientCachingDTO, ClientTrackingDTO } from './tracking.dto';
import TrackingClientService from './tracking.client.service';
import TrackingInvalidationService from './tracking.invalidation.service';

export { TrackingClientService, TrackingInvalidationService };
export { Tracking } from './tracking.core';

/**
 * The tracking module's public API (server-assisted client-side caching): one flat facade over the client-mode and
 * invalidation sub-services. Every method takes the per-server TrackingState (the `Tracking` object the server owns).
 */
export default class TrackingService {
  // Grammar — the arguments after CLIENT TRACKING / CLIENT CACHING (the connection module's DTOs pipe into these)
  static readonly TrackingOptionsSchema = ClientTrackingDTO;
  static readonly CachingValueSchema = ClientCachingDTO;

  // Client mode — CLIENT TRACKING / CACHING / TRACKINGINFO
  static configure = TrackingClientService.configure.bind(TrackingClientService);
  static disable = TrackingClientService.disable.bind(TrackingClientService);
  static caching = TrackingClientService.caching.bind(TrackingClientService);
  static info = TrackingClientService.info.bind(TrackingClientService);

  // Invalidation — remembered reads, BCAST, deferred delivery
  static remember = TrackingInvalidationService.remember.bind(TrackingInvalidationService);
  static enforceLimit = TrackingInvalidationService.enforceLimit.bind(TrackingInvalidationService);
  static invalidate = TrackingInvalidationService.invalidate.bind(TrackingInvalidationService);
  static flushBcast = TrackingInvalidationService.flushBcast.bind(TrackingInvalidationService);
  static flushed = TrackingInvalidationService.flushed.bind(TrackingInvalidationService);
  static flushDeferred = TrackingInvalidationService.flushDeferred.bind(TrackingInvalidationService);
  static stats = TrackingInvalidationService.stats.bind(TrackingInvalidationService);
}
