import { AppError } from '@/libs/app-error';
import { INT64_MAX, INT64_MIN, formatFloat, intReply, isInt64, toFloat } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';

import type { CommandContext } from '@/modules/command/command.types';

import type { IncrByFloatInput, IncrByInput } from './strings.dto';

/** Numeric strings: INCR, DECR, INCRBY, DECRBY (int64) and INCRBYFLOAT. Both keep the key's TTL. */
export default class StringsCounterService {
  /** Adds `delta` to the int64 stored at `key` (0 when missing) and returns the result. */
  static incrBy(ctx: CommandContext, { key, delta }: IncrByInput): number | bigint {
    const current = ctx.db.get(key, 'string');
    if (current !== undefined && !isInt64(current)) throw new AppError(RespMessages.NOT_INTEGER);
    const result = (current === undefined ? 0n : BigInt(current)) + delta;
    if (result < INT64_MIN || result > INT64_MAX) throw new AppError(RespMessages.INCR_OVERFLOW);
    ctx.db.set(key, { type: 'string', value: result.toString() }, true);
    return intReply(result);
  }

  /** INCRBYFLOAT on the value read before the arguments were parsed (Redis's precedence, see the commands layer). */
  static incrByFloat(ctx: CommandContext, { key, increment }: IncrByFloatInput, current: string | null): string {
    const stored = current === null ? 0 : toFloat(current);
    if (stored === null) throw new AppError(RespMessages.NOT_FLOAT);
    const result = stored + increment;
    if (!Number.isFinite(result)) throw new AppError(RespMessages.NAN_OR_INF);
    const text = formatFloat(result);
    ctx.db.set(key, { type: 'string', value: text }, true);
    return text;
  }
}
