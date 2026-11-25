import { CommandError } from '../errors';
import { RespMessages } from '../messages';
import { OK } from '../resp';
import type { CommandSpec } from './types';

export const transactionCommands: CommandSpec[] = [
  {
    name: 'multi',
    arity: 1,
    flags: { noscript: true },
    handler: (ctx) => {
      if (ctx.client.multi) throw new CommandError(RespMessages.MULTI_NESTED);
      ctx.client.multi = [];
      ctx.client.multiError = false;
      return OK;
    },
  },
  { name: 'exec', arity: 1, flags: { noscript: true }, handler: (ctx) => ctx.server.runExec(ctx.client) },
  {
    name: 'discard',
    arity: 1,
    flags: { noscript: true },
    handler: (ctx) => {
      if (!ctx.client.multi) throw new CommandError(RespMessages.DISCARD_WITHOUT_MULTI);
      ctx.client.multi = null;
      ctx.client.multiError = false;
      ctx.client.watched.clear();
      return OK;
    },
  },
  {
    name: 'watch',
    arity: -2,
    flags: { noscript: true },
    handler: (ctx, args) => {
      if (ctx.client.multi) throw new CommandError(RespMessages.WATCH_IN_MULTI);
      for (const key of args) {
        ctx.db.peek(key); // expire first, so an already-expired key does not count as a change later (no LRU/LFU touch)
        const k = `${ctx.client.dbIndex}:${key}`;
        if (!ctx.client.watched.has(k)) ctx.client.watched.set(k, ctx.server.keyVersion(ctx.client.dbIndex, key));
      }
      return OK;
    },
  },
  {
    name: 'unwatch',
    arity: 1,
    flags: { noscript: true },
    handler: (ctx) => {
      ctx.client.watched.clear();
      return OK;
    },
  },
];
