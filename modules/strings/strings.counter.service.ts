import { AppError } from '@/libs/app-error';
import { addInt64 } from '@/libs/number';
import { addLongDouble, formatLongDouble, parseLongDouble } from '@/libs/number/long-double';
import { RespMessages } from '@/libs/resp/messages';

import type { CommandContext } from '@/modules/command/command.types';

import type { IncrByFloatInput, IncrByInput } from './strings.dto';

const ZERO = { neg: false, m: 0n, e: 0 };

/** Numeric strings: INCR, DECR, INCRBY, DECRBY (int64) and INCRBYFLOAT. Both keep the key's TTL. */
export default class StringsCounterService {
  /** Adds `delta` to the int64 stored at `key` (0 when missing) and returns the result. */
  static incrBy(ctx: CommandContext, { key, delta }: IncrByInput): number | bigint {
    const result = addInt64(ctx.db.get(key, 'string'), delta);
    if (result === 'not-integer') throw new AppError(RespMessages.NOT_INTEGER);
    if (result === 'overflow') throw new AppError(RespMessages.INCR_OVERFLOW);
    ctx.db.set(key, { type: 'string', value: String(result) }, true);
    return result;
  }

  /**
   * INCRBYFLOAT on the value read before the arguments were parsed (Redis's precedence, see the commands layer). Like
   * Redis, the sum is computed in 80-bit long double precision and stored as `%.17Lf` text, never integer-encoded.
   */
  static incrByFloat(ctx: CommandContext, { key, increment }: IncrByFloatInput, current: string | null): string {
    const stored = current === null ? ZERO : parseLongDouble(current);
    if (stored === null) throw new AppError(RespMessages.NOT_FLOAT);
    const result = addLongDouble(stored, increment);
    if (result === null || result.inf) throw new AppError(RespMessages.NAN_OR_INF);
    const text = formatLongDouble(result);
    ctx.db.set(key, { type: 'string', value: text, noInt: true }, true);
    return text;
  }
}
