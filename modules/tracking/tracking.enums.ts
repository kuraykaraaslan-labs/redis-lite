import { z } from 'zod';

/** CLIENT CACHING's argument (lower-cased, as the client stores it). */
export const TrackingCachingEnum = z.enum(['yes', 'no']);

/** CLIENT TRACKING's mode argument (lower-cased). */
export const TrackingModeEnum = z.enum(['on', 'off']);

export type TrackingCaching = z.infer<typeof TrackingCachingEnum>;
export type TrackingMode = z.infer<typeof TrackingModeEnum>;
