import { z } from 'zod';

import { RespMessages } from '@/libs/resp/messages';

import { reject } from './issue';

/**
 * The timeout of a blocking command (BLPOP, BLMOVE, BZPOPMIN, BLMPOP…): seconds, fractions allowed → ms; 0 = wait
 * forever, anything else at least 1 ms. Not a finite number → `ERR timeout is not a float…`; below zero → negative.
 */
export const BlockTimeoutSchema = z.string().transform((raw, ctx) => {
  const seconds = Number(raw);
  if (raw.trim() === '' || Number.isNaN(seconds) || !Number.isFinite(seconds)) return reject(ctx, RespMessages.TIMEOUT_NOT_FLOAT);
  if (seconds < 0) return reject(ctx, RespMessages.TIMEOUT_NEGATIVE);
  return seconds === 0 ? 0 : Math.max(1, Math.round(seconds * 1000));
});

export type BlockTimeout = z.infer<typeof BlockTimeoutSchema>;
