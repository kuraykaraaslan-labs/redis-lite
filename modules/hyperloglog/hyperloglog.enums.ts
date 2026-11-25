import { z } from 'zod';

/** PFDEBUG's subcommands (lowercased). */
export const PfDebugSubcommandEnum = z.enum(['getreg', 'decode', 'encoding', 'todense']);

export type PfDebugSubcommand = z.infer<typeof PfDebugSubcommandEnum>;
