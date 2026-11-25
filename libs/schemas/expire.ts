import { z } from 'zod';

import { INT64_MAX } from '@/libs/number';
import { formatMessage } from '@/libs/message-format';
import { RespMessages } from '@/libs/resp/messages';

import { Int64Schema } from './number';
import { reject } from './issue';

/** The expiry options shared by SET, GETEX, HGETEX, HSETEX…: relative (EX/PX) or absolute (EXAT/PXAT) times. */
export const ExpireOptionEnum = z.enum(['EX', 'PX', 'EXAT', 'PXAT']);
export type ExpireOption = z.infer<typeof ExpireOptionEnum>;

const UNIT_MS: Record<ExpireOption, bigint> = { EX: 1000n, PX: 1n, EXAT: 1000n, PXAT: 1n };

/**
 * The value of an EX / PX / EXAT / PXAT option → absolute expiry time in ms.
 * Like Redis: not an int64 → `ERR value is not an integer…`; ≤ 0, or overflowing int64 once converted to an absolute
 * time in ms → `ERR invalid expire time in '<command>' command`.
 */
export function ExpireTimeSchema(option: ExpireOption, command: string) {
  const invalid = formatMessage(RespMessages.INVALID_EXPIRE, { command });
  return Int64Schema.transform((amount, ctx) => {
    const ms = amount * UNIT_MS[option];
    const at = option === 'EXAT' || option === 'PXAT' ? ms : ms + BigInt(Date.now());
    if (amount <= 0n || ms > INT64_MAX || at > INT64_MAX) return reject(ctx, invalid);
    return Number(at);
  });
}

/** The four expiry-time schemas of one command, built once (hot paths such as SET must not rebuild schemas per call). */
export function ExpireTimeSchemas(command: string): Record<ExpireOption, ReturnType<typeof ExpireTimeSchema>> {
  return {
    EX: ExpireTimeSchema('EX', command),
    PX: ExpireTimeSchema('PX', command),
    EXAT: ExpireTimeSchema('EXAT', command),
    PXAT: ExpireTimeSchema('PXAT', command),
  };
}
