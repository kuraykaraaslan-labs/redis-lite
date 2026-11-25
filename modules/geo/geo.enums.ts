import { z } from 'zod';

/** Result order of a search: by distance from the center (lowercased). */
export const GeoSortEnum = z.enum(['asc', 'desc']);

export type GeoSort = z.infer<typeof GeoSortEnum>;
