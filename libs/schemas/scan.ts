import { z } from 'zod';

import { parseScanCursor } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';

import { firstIssue, reject } from './issue';
import { IntegerSchema } from './number';

/** An unsigned 64-bit SCAN cursor (SCAN, HSCAN, SSCAN, ZSCAN) → number; anything else is `ERR invalid cursor`. */
export const ScanCursorSchema = z.string().transform((raw, ctx) => parseScanCursor(raw) ?? reject(ctx, RespMessages.INVALID_CURSOR));

/**
 * `[MATCH pattern] [COUNT n] [TYPE type]`, in any order and case. An option missing its value, an unknown
 * option or COUNT < 1 is a syntax error; a non-integer COUNT is `ERR value is not an integer…`.
 */
export const ScanOptionsSchema = z.array(z.string()).transform((options, ctx) => {
  let match = '*';
  let type: string | null = null;
  let count = 10;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i].toLowerCase();
    if (opt === 'match' && i + 1 < options.length) match = options[++i];
    else if (opt === 'count' && i + 1 < options.length) {
      const parsed = IntegerSchema.safeParse(options[++i]);
      if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
      if (parsed.data < 1) return reject(ctx, RespMessages.SYNTAX);
      count = parsed.data;
    } else if (opt === 'type' && i + 1 < options.length) type = options[++i].toLowerCase();
    else return reject(ctx, RespMessages.SYNTAX);
  }
  return { match, type, count };
});

export type ScanCursor = z.infer<typeof ScanCursorSchema>;
export type ScanOptions = z.infer<typeof ScanOptionsSchema>;
