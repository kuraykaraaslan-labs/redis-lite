import { z } from 'zod';

import { INT64_MIN } from '@/libs/number';

import { reject } from './issue';
import { Int64Schema } from './number';

/** Redis's texts for a random-pick count out of range (not shared elsewhere yet). */
export const RandomCountMessages = {
  /** -2^63 is a valid int64 but outside [-LONG_MAX, LONG_MAX]. */
  COUNT_RANGE: 'ERR value is out of range, value must between -9223372036854775807 and 9223372036854775807',
  /** WITHVALUES / WITHSCORES doubles the reply: |count| must stay within LONG_MAX / 2. */
  PAIRS_RANGE: 'ERR value is out of range',
} as const;

const HALF_LONG_MAX = 4611686018427387903n;

/** The count of HRANDFIELD / SRANDMEMBER / ZRANDMEMBER: an int64 within [-LONG_MAX, LONG_MAX] → bigint. */
export const RandomCountSchema = Int64Schema.transform((n, ctx) => (n === INT64_MIN ? reject(ctx, RandomCountMessages.COUNT_RANGE) : n));

/** With WITHVALUES / WITHSCORES the count must lie within ±LONG_MAX / 2 (the reply holds two entries per pick). */
export function isPairCountInRange(count: bigint): boolean {
  return count >= -HALF_LONG_MAX && count <= HALF_LONG_MAX;
}
