import { z } from 'zod';

/** XADD / XTRIM trimming strategy (lower-cased option name). */
export const TrimStrategyEnum = z.enum(['maxlen', 'minid']);

/** XGROUP subcommands (lower-cased). */
export const XGroupSubcommandEnum = z.enum(['create', 'setid', 'destroy', 'createconsumer', 'delconsumer', 'help']);

/** XINFO subcommands (lower-cased). */
export const XInfoSubcommandEnum = z.enum(['stream', 'groups', 'consumers', 'help']);

export type TrimStrategy = z.infer<typeof TrimStrategyEnum>;
export type XGroupSubcommand = z.infer<typeof XGroupSubcommandEnum>;
export type XInfoSubcommand = z.infer<typeof XInfoSubcommandEnum>;
