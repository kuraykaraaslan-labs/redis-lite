import { CommandError } from '../errors';
import { RespMessages, unknownSubcommand } from '../messages';
import type { Reply } from '../resp';
import type { Protocol } from '../resp';
import { OK, PONG, RespError, RespMap, RespSet, RespVerbatim, Status } from '../resp';
import type { Client } from '../server/client';
import { parseInteger } from '../util';
import { HELP_TEXT } from './meta-table';
import type { CommandContext, CommandSpec } from './types';
import { NO_REPLY } from './types';

export const REDIS_VERSION = '8.8.4';

const NAME_ERROR = 'ERR Client names cannot contain spaces, newlines or special characters.';
const HELLO_NOAUTH =
  'NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time';

/** Redis validateClientAttr(): only printable ASCII without spaces ('!'..'~'). */
function validAttr(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 33 || c > 126) return false;
  }
  return true;
}

/** `<CMD> HELP` reply: Redis addReplyHelp() (status lines, HELP appended). */
export function helpReply(command: string, lines: string[]): Reply {
  return [`${command.toUpperCase()} <subcommand> [<arg> [value] [opt] ...]. Subcommands are:`, ...lines, 'HELP', '    Print this help.'].map(
    (l) => new Status(l),
  );
}

/** Redis addReplySubcommandSyntaxError(). */
export function subcommandSyntaxError(sub: string, command: string): CommandError {
  return new CommandError(`ERR unknown subcommand or wrong number of arguments for '${sub.slice(0, 128)}'. Try ${command.toUpperCase()} HELP.`);
}

/** The single ACL user: `default`, with nopass unless requirepass is set. */
export function defaultPassword(ctx: CommandContext): string {
  return ctx.server.config.get('requirepass') ?? '';
}

/** ACLAuthenticateUser(): OK or WRONGPASS (only the `default` user exists). */
function authenticate(ctx: CommandContext, user: string, password: string): Reply {
  const expected = defaultPassword(ctx);
  if (user !== 'default' || (expected !== '' && password !== expected)) return new RespError(RespMessages.WRONGPASS);
  ctx.client.authenticated = true;
  return OK;
}

/** CLIENT LIST `flags=` (Redis catClientInfoString). */
function clientFlags(c: Client): string {
  let f = '';
  if (c.monitor) f += 'O';
  if (c.subscriptionCount) f += 'P';
  if (c.multi) f += 'x';
  if (c.blocked) f += 'b';
  if (c.tracking) f += 't';
  if (c.closeAfterReply) f += 'c';
  if (c.noEvict) f += 'e';
  if (c.noTouch) f += 'T';
  return f || 'N';
}

/** Redis getClientType(): monitors count as normal clients. */
function clientType(c: Client): string {
  return c.subscriptionCount ? 'pubsub' : 'normal';
}

const CLIENT_TYPES: Record<string, string> = { normal: 'normal', slave: 'replica', replica: 'replica', master: 'master', pubsub: 'pubsub' };

function localAddress(ctx: CommandContext, c: Client): string {
  const s = c.socket;
  return s ? `${s.localAddress ?? ctx.server.options.host}:${s.localPort ?? ctx.server.options.port}` : `${ctx.server.options.host}:${ctx.server.options.port}`;
}

export function clientInfoLine(ctx: CommandContext, c: Client): string {
  const now = Date.now();
  const multiMem = c.multi ? c.multi.reduce((n, argv) => n + argv.reduce((m, a) => m + a.length, 0), 0) : 0;
  return (
    `id=${c.id} addr=${c.address} laddr=${localAddress(ctx, c)} fd=${c.socket ? c.id + 7 : -1} name=${c.name} ` +
    `age=${Math.floor((now - c.createdAt) / 1000)} idle=${Math.floor((now - c.lastActiveAt) / 1000)} flags=${clientFlags(c)} ` +
    `db=${c.dbIndex} sub=${c.channels.size} psub=${c.patterns.size} ssub=${c.shardChannels.size} multi=${c.multi ? c.multi.length : -1} ` +
    `watch=${c.watched.size} qbuf=0 qbuf-free=0 argv-mem=0 multi-mem=${multiMem} rbs=1024 rbp=0 obl=0 oll=0 omem=0 tot-mem=${1024 + multiMem} ` +
    `events=r cmd=${c.lastCommand} user=default redir=${c.tracking ? c.trackingRedirect : -1} resp=${c.resp} ` +
    `lib-name=${c.libName} lib-ver=${c.libVer} io-thread=0 tot-net-in=${c.netIn} tot-net-out=${c.netOut} tot-cmds=${c.commandsProcessed}`
  );
}

function parseOnOff(value: string): boolean {
  const v = value.toLowerCase();
  if (v !== 'on' && v !== 'off') throw new CommandError(RespMessages.SYNTAX);
  return v === 'on';
}

function clientList(ctx: CommandContext, args: string[]): Reply {
  let clients = [...ctx.server.clients];
  if (args.length === 3 && args[1].toLowerCase() === 'type') {
    const type = CLIENT_TYPES[args[2].toLowerCase()];
    if (!type) throw new CommandError(`ERR Unknown client type '${args[2]}'`);
    clients = clients.filter((c) => clientType(c) === type);
  } else if (args.length > 2 && args[1].toLowerCase() === 'id') {
    const byId = new Map(clients.map((c) => [c.id, c]));
    clients = [];
    for (const raw of args.slice(2)) {
      const id = parseInteger(raw, 'ERR Invalid client ID');
      const c = byId.get(id);
      if (c) clients.push(c);
    }
  } else if (args.length !== 1) throw new CommandError(RespMessages.SYNTAX);
  return new RespVerbatim(clients.map((c) => `${clientInfoLine(ctx, c)}\n`).join(''));
}

function clientKill(ctx: CommandContext, args: string[]): Reply {
  const me = ctx.client;
  const kill = (target: Client): void => {
    if (target === me) me.closeAfterReply = true;
    else ctx.server.killClient(target);
  };
  if (args.length === 2) {
    // old form: CLIENT KILL addr:port (can kill the caller too)
    const target = [...ctx.server.clients].find((c) => c.address === args[1]);
    if (!target) throw new CommandError('ERR No such client');
    kill(target);
    return OK;
  }
  let id: number | null = null;
  let type: string | null = null;
  let addr: string | null = null;
  let laddr: string | null = null;
  let maxAge: number | null = null;
  let skipMe = true;
  for (let i = 1; i < args.length; i += 2) {
    const opt = args[i].toLowerCase();
    const value = args[i + 1];
    if (value === undefined) throw new CommandError(RespMessages.SYNTAX);
    if (opt === 'id') {
      if (!/^-?\d+$/.test(value) || Number(value) < 1) throw new CommandError('ERR client-id should be greater than 0');
      id = Number(value);
    } else if (opt === 'type') {
      const t = CLIENT_TYPES[value.toLowerCase()];
      if (!t) throw new CommandError(`ERR Unknown client type '${value}'`);
      type = t;
    } else if (opt === 'addr') addr = value;
    else if (opt === 'laddr') laddr = value;
    else if (opt === 'user') {
      if (value !== 'default') throw new CommandError(`ERR No such user '${value}'`);
    } else if (opt === 'skipme') {
      const v = value.toLowerCase();
      if (v !== 'yes' && v !== 'no') throw new CommandError(RespMessages.SYNTAX);
      skipMe = v === 'yes';
    } else if (opt === 'maxage') {
      maxAge = parseInteger(value);
    } else throw new CommandError(RespMessages.SYNTAX);
  }
  const now = Date.now();
  let killed = 0;
  for (const c of [...ctx.server.clients]) {
    if (id !== null && c.id !== id) continue;
    if (type !== null && clientType(c) !== type) continue;
    if (addr !== null && c.address !== addr) continue;
    if (laddr !== null && localAddress(ctx, c) !== laddr) continue;
    if (maxAge !== null && Math.floor((now - c.createdAt) / 1000) <= maxAge) continue;
    if (skipMe && c === me) continue;
    kill(c);
    killed++;
  }
  return killed;
}

function client(ctx: CommandContext, args: string[]): Reply | typeof NO_REPLY {
  const sub = args[0].toLowerCase();
  const c = ctx.client;
  switch (sub) {
    case 'setname':
      if (!validAttr(args[1])) throw new CommandError(NAME_ERROR);
      c.name = args[1];
      return OK;
    case 'getname':
      return c.name || null;
    case 'id':
      return c.id;
    case 'info':
      return new RespVerbatim(`${clientInfoLine(ctx, c)}\n`);
    case 'list':
      return clientList(ctx, args);
    case 'setinfo': {
      const attr = args[1].toLowerCase();
      if (attr !== 'lib-name' && attr !== 'lib-ver') throw new CommandError(`ERR Unrecognized option '${args[1]}'`);
      if (!validAttr(args[2])) throw new CommandError(`ERR ${args[1]} cannot contain spaces, newlines or special characters.`);
      if (attr === 'lib-name') c.libName = args[2];
      else c.libVer = args[2];
      return OK;
    }
    case 'kill':
      return clientKill(ctx, args);
    case 'unblock': {
      if (args.length > 3) throw subcommandSyntaxError(args[0], 'client');
      let withError = false;
      if (args.length === 3) {
        const reason = args[2].toLowerCase();
        if (reason !== 'timeout' && reason !== 'error') throw new CommandError('ERR CLIENT UNBLOCK reason should be TIMEOUT or ERROR');
        withError = reason === 'error';
      }
      const id = parseInteger(args[1]);
      const target = [...ctx.server.clients].find((x) => x.id === id);
      return target && ctx.server.unblockClient(target, withError) ? 1 : 0;
    }
    case 'getredir':
      return c.tracking ? c.trackingRedirect : -1;
    case 'trackinginfo':
      return RespMap.from(['flags', new RespSet([c.tracking ? 'on' : 'off']), 'redirect', c.tracking ? c.trackingRedirect : -1, 'prefixes', []]);
    case 'tracking': {
      const on = parseOnOff(args[1]);
      let redirect = 0;
      for (let i = 2; i < args.length; i++) {
        const opt = args[i].toLowerCase();
        if (opt === 'redirect' && i + 1 < args.length) {
          redirect = parseInteger(args[++i]);
          if (![...ctx.server.clients].some((x) => x.id === redirect)) throw new CommandError('ERR The client ID you want redirect to does not exist');
        } else if (opt === 'prefix' && i + 1 < args.length) i++;
        else if (opt !== 'bcast' && opt !== 'optin' && opt !== 'optout' && opt !== 'noloop') throw new CommandError(RespMessages.SYNTAX);
      }
      c.tracking = on;
      c.trackingRedirect = on ? redirect : 0;
      return OK;
    }
    case 'caching':
      throw new CommandError('ERR CLIENT CACHING can be called only when the client is in tracking mode with OPTIN or OPTOUT mode enabled');
    case 'help':
      return helpReply('client', HELP_TEXT.client);
    case 'no-touch':
      c.noTouch = parseOnOff(args[1]);
      return OK;
    case 'no-evict':
      c.noEvict = parseOnOff(args[1]);
      return OK;
    case 'reply': {
      const mode = args[1].toLowerCase();
      if (mode === 'on') {
        c.replyOff = false;
        c.skipNext = false;
        c.skipCurrent = false;
        return OK;
      }
      if (mode === 'off') {
        c.replyOff = true;
        return NO_REPLY;
      }
      if (mode === 'skip') {
        if (!c.replyOff) c.skipNext = true;
        return NO_REPLY;
      }
      throw new CommandError(RespMessages.SYNTAX);
    }
    case 'pause': {
      if (args.length > 3) throw subcommandSyntaxError(args[0], 'client');
      const timeout = parseInteger(args[1], 'ERR timeout is not an integer or out of range');
      if (timeout < 0) throw new CommandError(RespMessages.TIMEOUT_NEGATIVE);
      if (args.length === 3 && !['write', 'all'].includes(args[2].toLowerCase())) throw new CommandError(RespMessages.SYNTAX);
      return OK;
    }
    case 'unpause':
      return OK;
    default:
      throw new CommandError(unknownSubcommand(args[0], 'client'));
  }
}

function hello(ctx: CommandContext, args: string[]): Reply {
  let ver: Protocol | null = null;
  if (args.length) {
    const v = parseInteger(args[0], 'ERR Protocol version is not an integer or out of range');
    if (v !== 2 && v !== 3) throw new CommandError(RespMessages.NOPROTO);
    ver = v;
  }
  let auth: [string, string] | null = null;
  let name: string | null = null;
  for (let i = 1; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    const more = args.length - 1 - i;
    if (opt === 'auth' && more >= 2) {
      auth = [args[i + 1], args[i + 2]];
      i += 2;
    } else if (opt === 'setname' && more >= 1) {
      name = args[++i];
      if (!validAttr(name)) throw new CommandError(NAME_ERROR);
    } else throw new CommandError(`ERR Syntax error in HELLO option '${args[i]}'`);
  }
  if (auth) {
    const r = authenticate(ctx, auth[0], auth[1]);
    if (r instanceof RespError) return r;
  }
  if (!ctx.client.authenticated) return new RespError(HELLO_NOAUTH);
  if (name !== null) ctx.client.name = name;
  if (ver !== null) ctx.client.resp = ver;
  return RespMap.from(['server', 'redis', 'version', REDIS_VERSION, 'proto', ctx.client.resp, 'id', ctx.client.id, 'mode', 'standalone', 'role', 'master', 'modules', []]);
}

function reset(ctx: CommandContext): Reply {
  const c = ctx.client;
  c.multi = null;
  c.multiError = false;
  c.watched.clear();
  for (const ch of [...c.channels]) ctx.server.unsubscribe(c, ch, false);
  for (const p of [...c.patterns]) ctx.server.unsubscribe(c, p, true);
  for (const ch of [...c.shardChannels]) ctx.server.sunsubscribe(c, ch);
  if (c.monitor) {
    c.monitor = false;
    ctx.server.monitors.delete(c);
  }
  c.dbIndex = 0;
  c.name = '';
  c.resp = 2;
  c.noTouch = false;
  c.noEvict = false;
  c.tracking = false;
  c.trackingRedirect = 0;
  c.replyOff = false;
  c.skipNext = false;
  c.skipCurrent = false;
  c.authenticated = defaultPassword(ctx) === '';
  return new Status('RESET');
}

export const connectionCommands: CommandSpec[] = [
  {
    name: 'ping',
    arity: -1,
    flags: { pubsub: true },
    handler: (ctx, args) => {
      if (args.length > 1) throw new CommandError("ERR wrong number of arguments for 'ping' command");
      if (ctx.client.subscriptionCount > 0 && ctx.client.resp === 2) return ['pong', args[0] ?? ''];
      return args.length ? args[0] : PONG;
    },
  },
  { name: 'echo', arity: 2, handler: (_ctx, args) => args[0] },
  {
    name: 'select',
    arity: 2,
    handler: (ctx, args) => {
      const index = parseInteger(args[0]);
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
      if (args.length === 1) {
        if (defaultPassword(ctx) === '') throw new CommandError(RespMessages.AUTH_NO_PASSWORD);
        return authenticate(ctx, 'default', args[0]);
      }
      return authenticate(ctx, args[0], args[1]);
    },
  },
  { name: 'hello', arity: -1, flags: { noauth: true, noscript: true }, handler: hello },
  { name: 'client', arity: -2, flags: { noscript: true }, handler: client },
  { name: 'reset', arity: 1, flags: { noauth: true, noscript: true, pubsub: true }, handler: reset },
  { name: 'quit', arity: -1, flags: { noauth: true, noscript: true }, handler: () => OK },
  { name: 'readonly', arity: 1, handler: () => new RespError('ERR This instance has cluster support disabled') },
  { name: 'readwrite', arity: 1, handler: () => new RespError('ERR This instance has cluster support disabled') },
];
