import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { KeySchema, ValueSchema, reject } from '@/libs/schemas';

import { PfDebugSubcommandEnum } from './hyperloglog.enums';
import HyperLogLogMessages from './hyperloglog.messages';

/**
 * Argument grammar of the HyperLogLog commands. Each DTO parses the arguments after the command name (`args`).
 * Checks that need the database (an invalid HLL string, a missing PFDEBUG key) stay in the services.
 */

// ============================================================================
// Value DTOs: PFADD, PFCOUNT, PFMERGE
// ============================================================================

export const PfAddDTO = z.tuple([KeySchema], ValueSchema).transform(([key, ...elements]) => ({ key, elements }));

export const PfCountDTO = z.array(KeySchema).transform((keys) => ({ keys }));

/** PFMERGE destkey [sourcekey …]: the destination is merged too (it is the first key). */
export const PfMergeDTO = z
  .tuple([KeySchema], KeySchema)
  .transform(([destination, ...sources]) => ({ destination, keys: [destination, ...sources] }));

// ============================================================================
// Debug DTOs: PFDEBUG, PFSELFTEST
// ============================================================================

/**
 * PFDEBUG subcommand key: parsed after the key was read (a missing key beats a wrong argument count). An unknown
 * subcommand is not an error here: Redis writes the value back before refusing it (see the debug service).
 */
export const PfDebugDTO = z.tuple([z.string(), KeySchema], z.string()).transform(([name, key, ...rest], ctx) => {
  const subcommand = PfDebugSubcommandEnum.safeParse(name.toLowerCase());
  if (subcommand.success && rest.length) return reject(ctx, formatMessage(HyperLogLogMessages.DEBUG_WRONG_ARITY, { subcommand: name }));
  return { name, key, subcommand: subcommand.success ? subcommand.data : null };
});

export const PfSelfTestDTO = z.tuple([]).transform(() => ({}));

// ============================================================================
// Type Exports
// ============================================================================

export type PfAddInput = z.infer<typeof PfAddDTO>;
export type PfCountInput = z.infer<typeof PfCountDTO>;
export type PfMergeInput = z.infer<typeof PfMergeDTO>;
export type PfDebugInput = z.infer<typeof PfDebugDTO>;
export type PfSelfTestInput = z.infer<typeof PfSelfTestDTO>;
