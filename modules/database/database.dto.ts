import { z } from 'zod';

import { RespMessages } from '@/libs/resp/messages';
import { IntegerSchema, firstIssue, reject } from '@/libs/schemas';

import DatabaseMessages from './database.messages';
import DatabaseScanService from './database.scan.service';

/**
 * Grammar shared by the SCAN family (SCAN, HSCAN, SSCAN): the cursor and the options. Stateless; the commands' own DTOs
 * compose these schemas. Candidates for `@/libs/schemas` (used by keys, hashes and sets).
 */

// ============================================================================
// Scan Grammar
// ============================================================================

/** An unsigned 64-bit SCAN cursor → number; anything else is `ERR invalid cursor`. */
export const ScanCursorSchema = z.string().transform((raw, ctx) => {
  const cursor = DatabaseScanService.parseCursor(raw);
  return cursor === null ? reject(ctx, DatabaseMessages.INVALID_CURSOR) : cursor;
});

/**
 * `[MATCH pattern] [COUNT n] [TYPE type] [NOVALUES]`, in any order and case. An option missing its value, an unknown
 * option or COUNT < 1 is a syntax error; a non-integer COUNT is `ERR value is not an integer…`.
 */
export const ScanOptionsSchema = z.array(z.string()).transform((options, ctx) => {
  let match = '*';
  let type: string | null = null;
  let noValues = false;
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
    else if (opt === 'novalues') noValues = true;
    else return reject(ctx, RespMessages.SYNTAX);
  }
  return { match, type, noValues, count };
});

// ============================================================================
// Type Exports
// ============================================================================

export type ScanOptions = z.infer<typeof ScanOptionsSchema>;
