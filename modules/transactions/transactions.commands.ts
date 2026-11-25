import { withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import { WatchDTO } from './transactions.dto';
import TransactionsService from './transactions.service';

/** Routing of the transaction commands: name, arity, flags, then DTO → service. No logic lives here. */

const NOSCRIPT = { noscript: true } as const;

export const transactionCommands: CommandSpec[] = [
  { name: 'multi', arity: 1, flags: NOSCRIPT, handler: (ctx) => TransactionsService.multi(ctx) },
  { name: 'exec', arity: 1, flags: NOSCRIPT, handler: (ctx) => TransactionsService.exec(ctx) },
  { name: 'discard', arity: 1, flags: NOSCRIPT, handler: (ctx) => TransactionsService.discard(ctx) },
  { name: 'watch', arity: -2, flags: NOSCRIPT, handler: withDTO(WatchDTO, TransactionsService.watch) },
  { name: 'unwatch', arity: 1, flags: NOSCRIPT, handler: (ctx) => TransactionsService.unwatch(ctx) },
];
