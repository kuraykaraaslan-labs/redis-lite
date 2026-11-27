import { z } from 'zod';

import { RespMessages } from '@/libs/resp/messages';

import { parseArg, reject } from './issue';
import { IntegerSchema } from './number';

/**
 * The options of a SCAN over one key (HSCAN, SSCAN): `[MATCH pattern] [COUNT n]`, in any order and case. Unlike the keyspace SCAN there is no TYPE. The
 * options are read in order and the first problem is reported: an option missing its value, an unknown option or
 * COUNT < 1 is a syntax error, a non-integer COUNT is `ERR value is not an integer…`. Redis parses them only once the
 * key is known to exist.
 */
export function KeyScanOptionsSchema() {
  return z.array(z.string()).transform((options, ctx) => {
    let match = '*';
    let count = 10;
    for (let i = 0; i < options.length; i++) {
      const option = options[i].toLowerCase();
      if (option === 'match' && i + 1 < options.length) match = options[++i];
      else if (option === 'count' && i + 1 < options.length) {
        const parsed = parseArg(IntegerSchema, options[++i]);
        if (!parsed.ok) return reject(ctx, parsed.error);
        if (parsed.value < 1) return reject(ctx, RespMessages.SYNTAX);
        count = parsed.value;
      } else return reject(ctx, RespMessages.SYNTAX);
    }
    return { match, count };
  });
}

export type KeyScanOptions = z.infer<ReturnType<typeof KeyScanOptionsSchema>>;
