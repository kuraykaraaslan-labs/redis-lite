import { z } from 'zod';

import { parseLongDouble } from '@/libs/number/long-double';
import { RespMessages } from '@/libs/resp/messages';

import { reject } from './issue';

/**
 * A Redis long double argument (INCRBYFLOAT, HINCRBYFLOAT increments) → LongDouble; anything Redis refuses is
 * `ERR value is not a valid float`. Infinities parse: the command itself refuses a non-finite result.
 */
export const LongDoubleSchema = z.string().transform((value, ctx) => parseLongDouble(value) ?? reject(ctx, RespMessages.NOT_FLOAT));
