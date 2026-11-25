import { CommandError } from '../errors';
import { RespMessages, unknownSubcommand, wrongArity } from '../messages';
import type { Reply } from '../resp';
import type { Protocol } from '../resp';
import { OK, PONG, RespError, RespMap, RespSet, RespVerbatim, Status } from '../resp';
import type { Client } from '../server/client';
import { parseInteger } from '../util';
import type { CommandContext, CommandSpec } from './types';

export const REDIS_VERSION = '7.2.0';

function authenticate(ctx: CommandContext, user: string, password: string): Reply {
  const expected = ctx.server.options.password;
  if (!expected) {
    if (user === 'default' && password === '') return OK;
    return new RespError(RespMessages.AUTH_NO_PASSWORD);
  }
  if (user !== 'default' || password !== expected) return new RespError(RespMessages.WRONGPASS);
  ctx.client.authenticated = true;
  return OK;
}

export function clientInfoLine(ctx: CommandContext, c: Client): string {
  const now = Date.now();
  const flags = c.multi ? 'x' : c.blocked ? 'b' : c.subscriptionCount ? 'P' : 'N';
  return (
    `id=${c.id} addr=${c.address} laddr=${ctx.server.options.host}:${ctx.server.options.port} fd=8 name=${c.name} ` +
    `age=${Math.floor((now - c.createdAt) / 1000)} idle=${Math.floor((now - c.lastActiveAt) / 1000)} flags=${flags} ` +
    `db=${c.dbIndex} sub=${c.channels.size} psub=${c.patterns.size} ssub=0 multi=${c.multi ? c.multi.length : -1} ` +
    `qbuf=0 qbuf-free=0 argv-mem=0 multi-mem=0 rbs=1024 rbp=0 obl=0 oll=0 omem=0 tot-mem=1024 events=r ` +
    `cmd=${c.lastCommand} user=default redir=-1 resp=2 lib-name=${c.libName} lib-ver=${c.libVer}`
  );
}

function client(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  const c = ctx.client;
  switch (sub) {
    case 'setname':
      if (args.length !== 2) throw new CommandError(wrongArity('client|setname'));
      if (/[\s]/.test(args[1])) throw new CommandError('ERR Client names cannot contain spaces, newlines or special characters.');
      c.name = args[1];
      return OK;
    case 'getname':
      return c.name || null;
    case 'id':
      return c.id;
    case 'info':
      return new RespVerbatim(`${clientInfoLine(ctx, c)}\n`);
    case 'list':
      return new RespVerbatim([...ctx.server.clients].map((x) => `${clientInfoLine(ctx, x)}\n`).join(''));
    case 'setinfo': {
      const attr = (args[1] ?? '').toLowerCase();
      if (attr === 'lib-name') c.libName = args[2] ?? '';
      else if (attr === 'lib-ver') c.libVer = args[2] ?? '';
      else throw new CommandError(`ERR Unrecognized option '${args[1] ?? ''}'`);
      return OK;
    }
    case 'kill': {
      let killed = 0;
      const target = args.length === 2 ? { key: 'addr', value: args[1] } : { key: (args[1] ?? '').toLowerCase(), value: args[2] ?? '' };
      for (const other of ctx.server.clients) {
        const match =
          (target.key === 'addr' && other.address === target.value) ||
          (target.key === 'id' && String(other.id) === target.value);
        if (match) {
          other.socket?.destroy();
          killed++;
        }
      }
      if (args.length === 2) {
        if (!killed) throw new CommandError('ERR No such client');
        return OK;
      }
      return killed;
    }
    case 'unblock': {
      const target = [...ctx.server.clients].find((x) => String(x.id) === args[1]);
      const mode = (args[2] ?? 'timeout').toLowerCase();
      if (mode !== 'timeout' && mode !== 'error') throw new CommandError('ERR CLIENT UNBLOCK reason should be TIMEOUT or ERROR');
      return target && ctx.server.unblockClient(target, mode === 'error') ? 1 : 0;
    }
    case 'getredir':
      return -1;
    case 'trackinginfo':
      return RespMap.from(['flags', new RespSet(['off']), 'redirect', -1, 'prefixes', []]);
    case 'help':
      return ['CLIENT <subcommand>'];
    case 'no-touch': {
      const mode = (args[1] ?? '').toLowerCase();
      if (mode !== 'on' && mode !== 'off') throw new CommandError(RespMessages.SYNTAX);
      c.noTouch = mode === 'on';
      return OK;
    }
    case 'no-evict':
    case 'reply':
    case 'pause':
    case 'unpause':
    case 'tracking':
      return OK;
    default:
      throw new CommandError(unknownSubcommand(args[0], 'client'));
  }
}

function hello(ctx: CommandContext, args: string[]): Reply {
  let i = 0;
  if (args.length) {
    const ver = parseInteger(args[0], 'ERR Protocol version is not an integer or out of range');
    if (ver !== 2 && ver !== 3) throw new CommandError(RespMessages.NOPROTO);
    i = 1;
  }
  for (; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    if (opt === 'auth' && i + 2 < args.length) {
      const r = authenticate(ctx, args[i + 1], args[i + 2]);
      if (r instanceof RespError) return r;
      i += 2;
    } else if (opt === 'setname' && i + 1 < args.length) {
      ctx.client.name = args[++i];
    } else throw new CommandError(`ERR Syntax error in HELLO option '${args[i]}'`);
  }
  if (!ctx.client.authenticated) return new RespError(RespMessages.NOAUTH);
  if (args.length) ctx.client.resp = Number(args[0]) as Protocol;
  return RespMap.from(['server', 'redis', 'version', REDIS_VERSION, 'proto', ctx.client.resp, 'id', ctx.client.id, 'mode', 'standalone', 'role', 'master', 'modules', []]);
}

export const connectionCommands: CommandSpec[] = [
  {
    name: 'ping',
    arity: -1,
    flags: { pubsub: true },
    handler: (ctx, args) => {
      if (args.length > 1) throw new CommandError(wrongArity('ping'));
      if (ctx.client.subscriptionCount > 0 && ctx.client.resp === 2) return ['pong', args[0] ?? ''];
      return args.length ? args[0] : PONG;
    },
  },
  { name: 'echo', arity: 2, handler: (_ctx, args) => args[0] },
  {
    name: 'select',
    arity: 2,
    handler: (ctx, args) => {
      const index = parseInteger(args[0], RespMessages.INVALID_DB_INDEX);
      if (index < 0 || index >= ctx.server.databases.length) throw new CommandError(RespMessages.DB_INDEX);
      ctx.client.dbIndex = index;
      return OK;
    },
  },
  {
    name: 'auth',
    arity: -2,
    flags: { noauth: true, noscript: true },
    handler: (ctx, args) => {
      if (args.length > 2) throw new CommandError(RespMessages.SYNTAX);
      return args.length === 1 ? authenticate(ctx, 'default', args[0]) : authenticate(ctx, args[0], args[1]);
    },
  },
  { name: 'hello', arity: -1, flags: { noauth: true, noscript: true }, handler: hello },
  { name: 'client', arity: -2, flags: { noscript: true }, handler: client },
  {
    name: 'reset',
    arity: 1,
    flags: { noauth: true, noscript: true, pubsub: true },
    handler: (ctx) => {
      const c = ctx.client;
      c.multi = null;
      c.multiError = false;
      c.watched.clear();
      for (const ch of [...c.channels]) ctx.server.unsubscribe(c, ch, false);
      for (const p of [...c.patterns]) ctx.server.unsubscribe(c, p, true);
      c.dbIndex = 0;
      c.name = '';
      c.authenticated = !ctx.server.options.password;
      return new Status('RESET');
    },
  },
  { name: 'quit', arity: -1, flags: { noauth: true, noscript: true }, handler: () => OK },
  { name: 'readonly', arity: 1, handler: () => OK },
  { name: 'readwrite', arity: 1, handler: () => OK },
];

